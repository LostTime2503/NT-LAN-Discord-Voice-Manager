import { createMatWebhookReceiver, isCsRoomAssignmentEvent } from "./csWebhookServer.js";
import type { MatWebhookEvent } from "./csWebhookServer.js";
import { CsEventStore } from "./csEventStore.js";
import type { MatBracketSummary, MatClient, MatMatchSnapshot, MatTeam } from "./matClient.js";
import { planCsTeamRooms } from "./csTournamentSync.js";
import { classifyCsTournament, discoverActiveCsTournaments, type CsCompetition } from "./csTournamentDiscovery.js";
import type { CsRegistrationSource } from "./csSyncRuntime.js";
import type { RegisteredPerson } from "./registrationClient.js";
import type { AddressInfo } from "node:net";
import type { CsDiscordManager } from "./csDiscordManager.js";
import type { CsSourceMode } from "./botSettings.js";

export interface CsWebhookDryRunReport {
  eventType: string;
  tournament: "main" | "wingman";
  tournamentSource: "api" | "roster";
  dryRun?: boolean;
  plannedRooms: number;
  plannedMembers: number;
  roomsEnsured?: number;
  updatedRooms?: number;
  skippedTeams: number;
  unmatchedPlayers: number;
  ambiguousSteamIds: number;
}

export interface CsWebhookRuntimeOptions {
  secret: string;
  port: number;
  path?: string;
  namespace?: "test";
  getMode?: () => CsSourceMode;
  host?: string;
  intervalMs: number;
  mat?: MatClient;
  dryRun?: boolean;
  registration: CsRegistrationSource;
  discordManager?: CsDiscordManager;
  store?: CsEventStore;
  report?: (summary: CsWebhookDryRunReport) => void;
  onTestEvent?: (eventType: string) => void;
  onEventReceived?: (event: CsWebhookEventSummary) => void;
  onEventRejected?: (eventType: string, reason: string) => void;
  onEventIgnored?: (eventType: string, reason: string) => void;
  onTerminalCleanup?: (eventType: string, releasedAssignments: number | null) => void;
  onProcessingFailed?: (eventType: string, stage: string, reason: string) => void;
}

export interface CsWebhookEventSummary {
  eventType: string;
  matchStatus: string;
  sequence: number;
  team1Players: number;
  team2Players: number;
}

export interface CsWebhookRuntimeDiagnostics {
  listening: boolean;
  healthCheckOk: boolean;
  lastSignedRequestAt: number | null;
  lastSignedRequestType: string | null;
  lastTestEventAt: number | null;
}

const terminalMatchStatuses = new Set(["completed", "cancelled", "canceled", "bye", "reset"]);
const activeWingmanStatuses = new Set(["ready", "loaded", "live", "in_progress", "playing"]);
const waitingWingmanStatuses = new Set(["pending", "waiting", "scheduled"]);
const terminalWebhookEventTypes = new Set(["match.finished", "match.cancelled", "match.reset"]);

function safeFailureReason(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as { name?: unknown; code?: unknown; cause?: unknown } : undefined;
  const code = record?.code ?? (typeof record?.cause === "object" && record.cause !== null
    ? (record.cause as { code?: unknown }).code : undefined);
  switch (code) {
    case 50013: return "Discord nektet handlingen: manglende rettighet (50013).";
    case 50001: return "Boten mangler tilgang til Discord-ressursen (50001).";
    case 10003: return "Discord-kanalen finnes ikke lenger (10003).";
    case 429: return "Discord ratebegrenset handlingen (429).";
    case "ECONNREFUSED": return "Tilkobling til API eller Discord ble avvist.";
    case "ETIMEDOUT": return "Tilkobling til API eller Discord fikk tidsavbrudd.";
  }
  const name = typeof record?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(record.name)
    ? record.name : "Ukjent feiltype";
  const safeCode = typeof code === "number" && Number.isInteger(code) ? ` (${code})`
    : typeof code === "string" && /^[A-Z0-9_-]{1,24}$/i.test(code) ? ` (${code})` : "";
  return `${name}${safeCode}; feildetaljer er skjult.`;
}

export function selectRecoverableWingmanMatches(bracket: MatBracketSummary): string[] | null {
  if (bracket.tournament.type !== "shuffle" || bracket.tournament.teamSize !== 2) return null;
  if (terminalMatchStatuses.has(bracket.tournament.status.toLowerCase())) return [];
  const relevant = bracket.matches.filter(match => match.slug && match.round !== null && match.status !== null);
  if (relevant.some(match => !terminalMatchStatuses.has(match.status!.toLowerCase())
    && !activeWingmanStatuses.has(match.status!.toLowerCase())
    && !waitingWingmanStatuses.has(match.status!.toLowerCase()))) return null;
  const open = relevant.filter(match => !terminalMatchStatuses.has(match.status!.toLowerCase()));
  const latestOpenRound = open.reduce((highest, match) => Math.max(highest, match.round ?? 0), 0);
  if (!latestOpenRound) return [];
  const active = open.filter(match => match.round === latestOpenRound && activeWingmanStatuses.has(match.status!.toLowerCase()));
  if (active.length > 1) return null;
  return active.map(match => match.slug!).slice(0, 1);
}

export function toRecoveredWingmanEvent(match: MatMatchSnapshot): MatWebhookEvent {
  return {
    id: `recovery:${match.tournamentId}:${match.id}:${match.status}`,
    type: "match.ready",
    test: false,
    sequence: match.round ?? 0,
    match: {
      id: match.id,
      slug: match.slug,
      status: match.status,
      tournamentId: match.tournamentId,
      team1: match.team1,
      team2: match.team2
    }
  };
}

export class CsWebhookRuntime {
  private readonly store: CsEventStore;
  private readonly report: (summary: CsWebhookDryRunReport) => void;
  private receiver: ReturnType<typeof createMatWebhookReceiver> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private processing: Promise<void> | undefined;
  private processRequestedWhileRunning = false;
  private readonly assignedRoomMatches = new Set<string>();
  private readonly tournamentScopes = new Map<string, "main" | "wingman">();
  private activeMainTournamentId: number | undefined;
  private activeWingmanTournamentId: number | undefined;
  private lastSignedRequestAt: number | null = null;
  private lastSignedRequestType: string | null = null;
  private lastTestEventAt: number | null = null;

  constructor(private readonly options: CsWebhookRuntimeOptions) {
    this.store = options.store ?? new CsEventStore();
    this.report = options.report ?? (summary => console.log("CS webhook dry-run", summary));
  }

  get address(): AddressInfo | null {
    const address = this.receiver?.address();
    return address && typeof address === "object" ? address : null;
  }

  async getDiagnostics(): Promise<CsWebhookRuntimeDiagnostics> {
    const address = this.address;
    let healthCheckOk = false;
    if (address) {
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/healthz`, {
          signal: AbortSignal.timeout(1_500),
          redirect: "error"
        });
        healthCheckOk = response.status === 204;
      } catch {
        healthCheckOk = false;
      }
    }
    return {
      listening: address !== null,
      healthCheckOk,
      lastSignedRequestAt: this.lastSignedRequestAt,
      lastSignedRequestType: this.lastSignedRequestType,
      lastTestEventAt: this.lastTestEventAt
    };
  }

  async start(): Promise<void> {
    if (this.receiver) return;
    await this.store.load();
    await this.options.discordManager?.load();
    if (this.options.getMode && this.mode() !== "live") await this.options.discordManager?.clearAssignments();
    if (this.options.mat && this.mode() !== "off") await this.refreshTournamentDiscovery();
    if (this.options.discordManager && this.options.mat && this.mode() === "live"
      && (this.activeMainTournamentId || this.activeWingmanTournamentId)) {
      try {
        const teams = await this.options.mat.getTeams();
        const participants = await this.getCsParticipants();
        if (this.activeMainTournamentId) {
          const mainBracket = await this.options.mat.getBracketSummary(this.activeMainTournamentId);
          const mainSummary = await this.options.discordManager.reconcileMainTournamentRooms(
            String(this.activeMainTournamentId), mainBracket, teams, participants, this.options.dryRun ?? true
          );
          console.log("CS main startup recovery", {
            plannedRooms: mainSummary.plannedRooms,
            updatedRooms: mainSummary.updatedRooms,
            skippedTeams: mainSummary.skippedTeams,
            unmatchedPlayers: mainSummary.unmatchedPlayers,
            ambiguousSteamIds: mainSummary.ambiguousSteamIds
          });
        }
        if (this.activeWingmanTournamentId) {
          const wingmanBracket = await this.options.mat.getBracketSummary(this.activeWingmanTournamentId);
          const activeSlugs = selectRecoverableWingmanMatches(wingmanBracket);
          if (activeSlugs === null) {
            console.error("Wingman startup recovery skipped; active match state is ambiguous.");
          } else if (activeSlugs.length === 1) {
            const match = await this.options.mat.getMatch(activeSlugs[0]!);
            if (match.tournamentId !== String(this.activeWingmanTournamentId)) {
              console.error("Wingman startup recovery skipped; active match belongs to another tournament.");
            } else {
              const summary = await this.options.discordManager.reconcileWingmanSnapshot(
                String(this.activeWingmanTournamentId), match, participants, this.options.dryRun ?? true
              );
              console.log("CS Wingman startup recovery", {
                activeMatchCount: 1,
                plannedRooms: summary.plannedRooms,
                skippedPairs: summary.skippedTeams,
                unmatchedPlayers: summary.unmatchedPlayers,
                ambiguousSteamIds: summary.ambiguousSteamIds
              });
            }
          } else {
            const summary = await this.options.discordManager.reconcileWingmanSnapshot(
              String(this.activeWingmanTournamentId), null, participants, this.options.dryRun ?? true
            );
            console.log("CS Wingman startup recovery", { activeMatchCount: 0, plannedRooms: summary.plannedRooms });
          }
        }
      } catch {
        console.error("CS startup recovery failed; existing room assignments were preserved and webhook events can still update them.");
      }
    }
    const receiver = createMatWebhookReceiver({
      secret: this.options.secret,
      path: this.options.path,
      onVerifiedRequest: request => {
        const receivedAt = Date.now();
        this.lastSignedRequestAt = receivedAt;
        this.lastSignedRequestType = request.type;
        if (request.test) {
          this.lastTestEventAt = receivedAt;
          try {
            this.options.onTestEvent?.(request.type);
          } catch (error) {
            console.error("CS webhook test event log failed", error);
          }
        }
      },
      onEvent: async event => {
        if (this.options.namespace) {
          event.match.tournamentId = `test:${event.match.tournamentId}`;
          event.match.slug = `test:${event.match.slug}`;
        }
        const mode = this.mode();
        if (mode !== "live") {
          this.options.onEventReceived?.({
            eventType: event.type, matchStatus: event.match.status, sequence: event.sequence,
            team1Players: event.match.team1?.steamIds.length ?? 0,
            team2Players: event.match.team2?.steamIds.length ?? 0
          });
          if (mode === "off") {
            this.options.onEventIgnored?.(event.type, "kilden er av; kvittert uten behandling eller senere avspilling");
          } else {
            const resolution = await this.tournamentFor(event);
            if (resolution) await this.processEvent(event, resolution.scope, resolution.rosterFallback ? "roster" : "api", true);
            else this.options.onEventIgnored?.(event.type, "forhåndsvisning: ingen støttet turnering/roster; ingen aktive oppdrag endret");
          }
          return;
        }
        const result = await this.store.accept(event);
        if (result === "accepted") {
          try {
            this.options.onEventReceived?.({
              eventType: event.type,
              matchStatus: event.match.status,
              sequence: event.sequence,
              team1Players: event.match.team1?.steamIds.length ?? 0,
              team2Players: event.match.team2?.steamIds.length ?? 0
            });
          } catch (error) {
            console.error("CS webhook receipt log failed", error);
          }
          void this.processPending();
        } else {
          const reason = result === "duplicate"
            ? "duplikat event-ID; allerede kvittert tidligere"
            : "eldre eller lik sekvensnummer; nyere event er allerede behandlet";
          try {
            this.options.onEventRejected?.(event.type, reason);
          } catch (error) {
            console.error("CS webhook rejected-event log failed", error);
          }
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      receiver.once("error", onError);
      receiver.listen(this.options.port, this.options.host ?? "0.0.0.0", () => {
        receiver.removeListener("error", onError);
        resolve();
      });
    });
    this.receiver = receiver;
    this.retryTimer = setInterval(() => void this.processPending(), this.options.intervalMs);
    void this.processPending();
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    const receiver = this.receiver;
    this.receiver = undefined;
    if (receiver?.listening) {
      await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
    }
    await this.processing;
    if (this.options.getMode && this.mode() !== "live") {
      for (const event of await this.store.getPending()) await this.store.markProcessed(event.id);
    }
  }

  private processPending(): void {
    if (!this.receiver) return;
    if (this.processing) {
      this.processRequestedWhileRunning = true;
      return;
    }
    const processing = this.drainPending();
    this.processing = processing;
    const finish = () => {
      if (this.processing !== processing) return;
      this.processing = undefined;
      if (this.processRequestedWhileRunning) {
        this.processRequestedWhileRunning = false;
        this.processPending();
      }
    };
    void processing.then(finish, finish);
  }

  private async drainPending(): Promise<void> {
    try {
      for (const event of await this.store.getPending()) {
        if (this.mode() !== "live") {
          await this.store.markProcessed(event.id);
          this.options.onEventIgnored?.(event.type, "kildens modus ble endret; køet event forkastet uten avspilling");
          continue;
        }
        let resolution: Awaited<ReturnType<CsWebhookRuntime["tournamentFor"]>>;
        try {
          resolution = await this.tournamentFor(event);
        } catch (error) {
          this.reportProcessingFailure(event.type, "turneringsoppslag", error);
          return;
        }
        if (!resolution) {
          if (terminalWebhookEventTypes.has(event.type)) {
            const released = this.options.discordManager
              ? await this.options.discordManager.releaseMatchWithoutTournament(event.match.slug)
              : 0;
            try {
              this.options.onTerminalCleanup?.(event.type, released);
            } catch (error) {
              console.error("CS terminal webhook cleanup log failed", error);
            }
          } else {
            const roster = `${event.match.team1?.steamIds.length ?? 0}v${event.match.team2?.steamIds.length ?? 0}`;
            const reason = isCsRoomAssignmentEvent(event.type)
              ? `turnering ikke aktiv og roster ${roster} støttes ikke (krever 5v5 eller 2v2)`
              : "ingen aktiv Main/Wingman-turnering matchet tournament-ID";
            try {
              this.options.onEventIgnored?.(event.type, reason);
            } catch (error) {
              console.error("CS webhook ignored-event log failed", error);
            }
          }
          await this.store.markProcessed(event.id);
          continue;
        }
        const roomAssignmentKey = isCsRoomAssignmentEvent(event.type)
          ? `${event.match.tournamentId}:${event.match.id}`
          : null;
        if (roomAssignmentKey && this.assignedRoomMatches.has(roomAssignmentKey) && event.type !== "match.live") {
          try {
            this.options.onEventIgnored?.(event.type, "komplett plan finnes allerede for denne kampen; duplikat-plan hoppet over");
          } catch (error) {
            console.error("CS webhook deduplicated-event log failed", error);
          }
          await this.store.markProcessed(event.id);
          continue;
        }
        try {
          const assignmentEstablished = await this.processEvent(
            event,
            resolution.scope,
            resolution.rosterFallback ? "roster" : "api"
          );
          await this.store.markProcessed(event.id);
          if (roomAssignmentKey && assignmentEstablished) this.assignedRoomMatches.add(roomAssignmentKey);
        } catch (error) {
          this.reportProcessingFailure(event.type, "event-behandling", error);
          return;
        }
      }
    } catch (error) {
      this.reportProcessingFailure("queue", "event-kø", error);
    }
  }

  private reportProcessingFailure(eventType: string, stage: string, error: unknown): void {
    const reason = safeFailureReason(error);
    console.error("CS webhook processing failed; event remains queued.", { eventType, stage, reason });
    try {
      this.options.onProcessingFailed?.(eventType, stage, reason);
    } catch {
      console.error("CS webhook failure diagnostic callback failed.");
    }
  }

  private async tournamentFor(event: MatWebhookEvent): Promise<{
    scope: CsCompetition;
    rosterFallback: boolean;
  } | null> {
    let scope = this.tournamentScopes.get(event.match.tournamentId);
    if (!scope && this.options.mat) {
      await this.refreshTournamentDiscovery();
      scope = this.tournamentScopes.get(event.match.tournamentId);
    }
    if (scope) return { scope, rosterFallback: false };
    if (!isCsRoomAssignmentEvent(event.type)) return null;
    const teamOneSize = event.match.team1?.steamIds.length;
    const teamTwoSize = event.match.team2?.steamIds.length;
    if (teamOneSize === 5 && teamTwoSize === 5) return { scope: "main", rosterFallback: true };
    if (teamOneSize === 2 && teamTwoSize === 2) return { scope: "wingman", rosterFallback: true };
    return null;
  }

  private async refreshTournamentDiscovery(): Promise<void> {
    if (!this.options.mat) return;
    const tournaments = await this.options.mat.getTournaments();
    const discovery = discoverActiveCsTournaments(tournaments);
    this.activeMainTournamentId = discovery.main?.id;
    this.activeWingmanTournamentId = discovery.wingman?.id;
    this.tournamentScopes.clear();
    const activeByScope = new Map<"main" | "wingman", string[]>();
    for (const tournament of tournaments) {
      const scope = classifyCsTournament(tournament);
      if (!scope) continue;
      const ids = activeByScope.get(scope) ?? [];
      ids.push(String(tournament.id));
      activeByScope.set(scope, ids);
    }
    for (const [scope, ids] of activeByScope) {
      if (ids.length > 1) for (const id of ids) this.tournamentScopes.delete(id);
      else if (ids.length === 1) this.tournamentScopes.set(ids[0]!, scope);
    }
    if (discovery.ambiguousMain || discovery.ambiguousWingman) {
      console.warn("MAT active tournament discovery is ambiguous; ambiguous tournament events are ignored.");
    }
  }

  private async getCsParticipants(): Promise<Map<string, RegisteredPerson>> {
    return this.options.registration.getCsParticipants
      ? this.options.registration.getCsParticipants()
      : this.options.registration.getParticipants();
  }

  private mode(): CsSourceMode {
    return this.options.getMode?.() ?? "live";
  }

  private async processEvent(
    event: MatWebhookEvent,
    tournament: "main" | "wingman",
    tournamentSource: "api" | "roster",
    previewOnly = false
  ): Promise<boolean> {
    if (this.options.discordManager && !previewOnly) {
      const participants = isCsRoomAssignmentEvent(event.type)
        ? await this.getCsParticipants()
        : new Map();
      if (this.mode() !== "live") {
        this.options.onEventIgnored?.(event.type, "modus endret under API-oppslag; ingen handling utført");
        return false;
      }
      const summary = await this.options.discordManager.handleMatchEvent(
        event,
        tournament,
        participants,
        this.options.dryRun ?? true
      );
      this.report({
        eventType: event.type,
        tournament,
        tournamentSource,
        dryRun: this.options.dryRun ?? true,
        plannedRooms: summary.plannedRooms,
        plannedMembers: summary.plannedMembers ?? 0,
        roomsEnsured: summary.roomsEnsured ?? 0,
        updatedRooms: summary.updatedRooms,
        skippedTeams: summary.skippedTeams,
        unmatchedPlayers: summary.unmatchedPlayers,
        ambiguousSteamIds: summary.ambiguousSteamIds
      });
      return isCsRoomAssignmentEvent(event.type) && (summary.plannedMembers ?? 0) > 0 && summary.skippedTeams === 0;
    }
    if (!isCsRoomAssignmentEvent(event.type)) {
      this.report({ eventType: event.type, tournament, tournamentSource, dryRun: this.options.dryRun ?? true,
        plannedRooms: 0, plannedMembers: 0, roomsEnsured: 0, updatedRooms: 0, skippedTeams: 0,
        unmatchedPlayers: 0, ambiguousSteamIds: 0 });
      return false;
    }
    const participants = await this.getCsParticipants();
    const teams: MatTeam[] = [event.match.team1, event.match.team2]
      .filter((team): team is NonNullable<typeof team> => team !== null)
      .map(team => ({
        id: team.id,
        name: team.name ?? team.tag ?? team.id,
        tag: team.tag,
        players: team.steamIds.map(steamId => ({ steamId }))
      }));
    const plan = planCsTeamRooms(teams, participants);
    const completeWingman = tournament !== "wingman" || (event.match.team1?.steamIds.length === 2
      && event.match.team2?.steamIds.length === 2 && plan.rooms.length === 2 && plan.skippedTeamCount === 0);
    this.report({
      eventType: event.type,
      tournament,
      tournamentSource,
      dryRun: true,
      plannedRooms: completeWingman ? plan.rooms.length : 0,
      plannedMembers: completeWingman ? new Set(plan.rooms.flatMap(room => room.memberIds)).size : 0,
      roomsEnsured: 0,
      updatedRooms: 0,
      skippedTeams: completeWingman ? plan.skippedTeamCount : Math.max(2, plan.skippedTeamCount),
      unmatchedPlayers: plan.unmatchedParticipantCount,
      ambiguousSteamIds: plan.ambiguousSteamIdCount
    });
    return plan.rooms.length > 0 && plan.skippedTeamCount === 0;
  }
}
