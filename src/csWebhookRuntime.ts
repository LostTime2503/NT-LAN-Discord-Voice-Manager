import { createMatWebhookReceiver } from "./csWebhookServer.js";
import type { MatWebhookEvent } from "./csWebhookServer.js";
import { CsEventStore } from "./csEventStore.js";
import type { MatClient, MatTeam } from "./matClient.js";
import { planCsTeamRooms } from "./csTournamentSync.js";
import type { CsRegistrationSource } from "./csSyncRuntime.js";
import type { RegisteredPerson } from "./registrationClient.js";
import type { AddressInfo } from "node:net";
import type { CsDiscordManager } from "./csDiscordManager.js";

export interface CsWebhookDryRunReport {
  eventType: string;
  tournament: "main" | "wingman";
  plannedRooms: number;
  skippedTeams: number;
  unmatchedPlayers: number;
  ambiguousSteamIds: number;
}

export interface CsWebhookRuntimeOptions {
  secret: string;
  port: number;
  host?: string;
  intervalMs: number;
  mat?: MatClient;
  mainTournamentId?: number;
  wingmanTournamentId?: number;
  dryRun?: boolean;
  registration: CsRegistrationSource;
  discordManager?: CsDiscordManager;
  store?: CsEventStore;
  report?: (summary: CsWebhookDryRunReport) => void;
}

export class CsWebhookRuntime {
  private readonly store: CsEventStore;
  private readonly report: (summary: CsWebhookDryRunReport) => void;
  private receiver: ReturnType<typeof createMatWebhookReceiver> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private processing = false;
  private syncingRoles = false;

  constructor(private readonly options: CsWebhookRuntimeOptions) {
    this.store = options.store ?? new CsEventStore();
    this.report = options.report ?? (summary => console.log("CS webhook dry-run", summary));
  }

  get address(): AddressInfo | null {
    const address = this.receiver?.address();
    return address && typeof address === "object" ? address : null;
  }

  async start(): Promise<void> {
    if (this.receiver) return;
    if (this.options.mainTournamentId && this.options.mainTournamentId === this.options.wingmanTournamentId) {
      throw new Error("Main and Wingman tournament IDs must be different.");
    }
    await this.store.load();
    await this.options.discordManager?.load();
    if (!this.options.dryRun && this.options.discordManager && this.options.mat && this.options.mainTournamentId) {
      try {
        const [bracket, teams, participants] = await Promise.all([
          this.options.mat.getBracketSummary(this.options.mainTournamentId),
          this.options.mat.getTeams(),
          this.getCsParticipants()
        ]);
        const summary = await this.options.discordManager.reconcileMainTournamentRooms(
          String(this.options.mainTournamentId), bracket, teams, participants, false
        );
        console.log("CS main rooms prepared", {
          plannedRooms: summary.plannedRooms,
          updatedRooms: summary.updatedRooms,
          skippedTeams: summary.skippedTeams,
          unmatchedPlayers: summary.unmatchedPlayers,
          ambiguousSteamIds: summary.ambiguousSteamIds
        });
      } catch {
        console.error("CS main rooms could not be prepared from MAT; ready events can still prepare active match rooms.");
      }
    }
    const receiver = createMatWebhookReceiver({
      secret: this.options.secret,
      onEvent: async event => {
        if (!this.tournamentFor(event)) return;
        const result = await this.store.accept(event);
        if (result === "accepted") void this.processPending();
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
    this.retryTimer = setInterval(() => {
      void this.processPending();
      void this.syncParticipantRoles();
    }, this.options.intervalMs);
    void this.processPending();
    void this.syncParticipantRoles();
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    const receiver = this.receiver;
    this.receiver = undefined;
    if (receiver?.listening) {
      await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
    }
  }

  private async processPending(): Promise<void> {
    if (this.processing || !this.receiver) return;
    this.processing = true;
    try {
      for (const event of await this.store.getPending()) {
        const tournament = this.tournamentFor(event);
        if (!tournament) {
          if (!this.options.mainTournamentId || !this.options.wingmanTournamentId) return;
          await this.store.markProcessed(event.id);
          continue;
        }
        try {
          await this.processEvent(event, tournament);
          await this.store.markProcessed(event.id);
        } catch {
          console.error("CS webhook dry-run processing failed; event remains queued.");
          return;
        }
      }
    } catch {
      console.error("CS webhook event queue could not be processed.");
    } finally {
      this.processing = false;
    }
  }

  private async syncParticipantRoles(): Promise<void> {
    if (this.syncingRoles || !this.receiver || !this.options.discordManager) return;
    this.syncingRoles = true;
    try {
      const participants = await this.getCsParticipants();
      const summary = await this.options.discordManager.reconcileParticipantRoles(
        participants,
        this.options.dryRun ?? true
      );
      console.log("CS participant role sync", summary);
    } catch {
      console.error("CS participant role sync failed; existing roles were preserved.");
    } finally {
      this.syncingRoles = false;
    }
  }

  private tournamentFor(event: MatWebhookEvent): "main" | "wingman" | null {
    if (this.options.mainTournamentId && event.match.tournamentId === String(this.options.mainTournamentId)) return "main";
    if (this.options.wingmanTournamentId && event.match.tournamentId === String(this.options.wingmanTournamentId)) return "wingman";
    return null;
  }

  private async getCsParticipants(): Promise<Map<string, RegisteredPerson>> {
    return this.options.registration.getCsParticipants
      ? this.options.registration.getCsParticipants()
      : this.options.registration.getParticipants();
  }

  private async processEvent(event: MatWebhookEvent, tournament: "main" | "wingman"): Promise<void> {
    if (this.options.discordManager) {
      const participants = event.type === "match.ready"
        ? await this.getCsParticipants()
        : new Map();
      const summary = await this.options.discordManager.handleMatchEvent(
        event,
        tournament,
        participants,
        this.options.dryRun ?? true
      );
      this.report({
        eventType: event.type,
        tournament,
        plannedRooms: summary.plannedRooms,
        skippedTeams: summary.skippedTeams,
        unmatchedPlayers: summary.unmatchedPlayers,
        ambiguousSteamIds: summary.ambiguousSteamIds
      });
      return;
    }
    if (event.type !== "match.ready") {
      this.report({ eventType: event.type, tournament, plannedRooms: 0, skippedTeams: 0, unmatchedPlayers: 0, ambiguousSteamIds: 0 });
      return;
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
    this.report({
      eventType: event.type,
      tournament,
      plannedRooms: plan.rooms.length,
      skippedTeams: plan.skippedTeamCount,
      unmatchedPlayers: plan.unmatchedParticipantCount,
      ambiguousSteamIds: plan.ambiguousSteamIdCount
    });
  }
}