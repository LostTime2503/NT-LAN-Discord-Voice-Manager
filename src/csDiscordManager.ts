import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { VoiceState } from "discord.js";
import { planCsTeamRooms } from "./csTournamentSync.js";
import type { MatBracketSummary, MatMatchSnapshot, MatTeam } from "./matClient.js";
import type { MatWebhookEvent } from "./csWebhookServer.js";
import type { RegisteredPerson } from "./registrationClient.js";

export type CsVoiceRoomScope = "main" | "wingman";

export interface CsVoiceRoomRequest {
  key: string;
  name: string;
  scope: CsVoiceRoomScope;
  teamId: string;
  tournamentId: string;
  matchSlug: string;
  memberIds: string[];
}

export interface CsDiscordAdapter {
  ensureRoom(request: CsVoiceRoomRequest, existingChannelId?: string, previousRequest?: CsVoiceRoomRequest): Promise<string>;
  canRouteMemberFromLobby(memberId: string, lobbyChannelId: string): Promise<boolean>;
  moveMemberFromSources(memberId: string, channelId: string, allowedSourceChannelIds: string[]): Promise<boolean>;
  setParticipantRole(memberId: string, shouldHaveRole: boolean): Promise<boolean>;
  revokeMemberFromRoom(channelId: string, memberId: string): Promise<void>;
}

interface OwnedCsRoom extends CsVoiceRoomRequest {
  channelId: string;
  retiring?: boolean;
  manualOverride?: boolean;
}

interface PersistedCsRoomState {
  version: 2;
  rooms: OwnedCsRoom[];
  assignments: CsVoiceRoomRequest[];
}

export interface CsDiscordSyncSummary {
  plannedRooms: number;
  updatedRooms: number;
  skippedTeams: number;
  unmatchedPlayers: number;
  ambiguousSteamIds: number;
}

export interface CsParticipantRoleSummary {
  granted: number;
  removed: number;
  unchanged: number;
  preservedMissingData: number;
  manualLinks: number;
}

const discordIdPattern = /^\d{17,20}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOwnedRoom(value: unknown): value is OwnedCsRoom {
  return isRecord(value) && typeof value.key === "string" && typeof value.channelId === "string"
    && discordIdPattern.test(value.channelId) && typeof value.name === "string"
    && (value.scope === "main" || value.scope === "wingman") && typeof value.teamId === "string"
    && typeof value.tournamentId === "string" && typeof value.matchSlug === "string"
    && (value.retiring === undefined || typeof value.retiring === "boolean")
    && (value.manualOverride === undefined || typeof value.manualOverride === "boolean")
    && Array.isArray(value.memberIds) && value.memberIds.every(id => typeof id === "string" && discordIdPattern.test(id));
}


function isRoomRequest(value: unknown): value is CsVoiceRoomRequest {
  return isRecord(value) && typeof value.key === "string" && typeof value.name === "string"
    && (value.scope === "main" || value.scope === "wingman") && typeof value.teamId === "string"
    && typeof value.tournamentId === "string" && typeof value.matchSlug === "string"
    && Array.isArray(value.memberIds) && value.memberIds.every(id => typeof id === "string" && discordIdPattern.test(id));
}
export class CsDiscordManager {
  private readonly rooms = new Map<string, OwnedCsRoom>();
  private readonly assignments = new Map<string, CsVoiceRoomRequest>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: CsDiscordAdapter,
    private readonly lobbyChannelId: string,
    private readonly deleteDelayMs: number,
    private readonly filePath = "data/cs-owned-voice-channels.json",
    private readonly globallyDryRun = true
  ) {}

  async load(): Promise<void> {
    try {
      const payload: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isRecord(payload) || (payload.version !== 1 && payload.version !== 2) || !Array.isArray(payload.rooms)
        || payload.rooms.some(room => !isOwnedRoom(room))
        || (payload.version === 2 && (!Array.isArray(payload.assignments) || payload.assignments.some(request => !isRoomRequest(request))))
        || new Set(payload.rooms.map(room => (room as OwnedCsRoom).key)).size !== payload.rooms.length) {
        throw new Error("Invalid CS voice-channel ownership state.");
      }
      for (const room of payload.rooms as OwnedCsRoom[]) this.rooms.set(room.key, room);
      if (payload.version === 2) {
        for (const request of payload.assignments as CsVoiceRoomRequest[]) this.assignments.set(request.key, request);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CS voice-channel ownership state could not be loaded.");
    }
    this.loaded = true;
  }

  async handleMatchEvent(
    event: MatWebhookEvent,
    scope: CsVoiceRoomScope,
    participants: Map<string, RegisteredPerson>,
    dryRun: boolean
  ): Promise<CsDiscordSyncSummary> {
    this.assertLoaded();
    void dryRun;
    if (event.type !== "match.ready") {
      if (scope === "wingman" && ["match.finished", "match.cancelled", "match.reset"].includes(event.type)) {
        for (const [key, assignment] of this.assignments) {
          if (assignment.scope === "wingman" && assignment.tournamentId === event.match.tournamentId
            && assignment.matchSlug === event.match.slug) this.assignments.delete(key);
        }
        await this.persist();
      }
      return { plannedRooms: 0, updatedRooms: 0, skippedTeams: 0, unmatchedPlayers: 0, ambiguousSteamIds: 0 };
    }

    const teams: MatTeam[] = [event.match.team1, event.match.team2]
      .filter((team): team is NonNullable<typeof team> => team !== null)
      .map(team => ({
        id: team.id,
        name: team.name ?? team.tag ?? team.id,
        tag: team.tag,
        players: team.steamIds.map(steamId => ({ steamId }))
      }));
    const plan = planCsTeamRooms(teams, participants);
    const completeWingmanPairing = scope !== "wingman" || (
      event.match.team1?.steamIds.length === 2
      && event.match.team2?.steamIds.length === 2
      && plan.rooms.length === 2
      && plan.skippedTeamCount === 0
    );
    if (!completeWingmanPairing) {
      return {
        plannedRooms: plan.rooms.length,
        updatedRooms: 0,
        skippedTeams: Math.max(plan.skippedTeamCount, 2 - plan.rooms.length),
        unmatchedPlayers: plan.unmatchedParticipantCount,
        ambiguousSteamIds: plan.ambiguousSteamIdCount
      };
    }

    if (scope === "wingman") {
      for (const [key, assignment] of this.assignments) {
        if (assignment.scope === "wingman" && assignment.tournamentId === event.match.tournamentId) {
          this.assignments.delete(key);
        }
      }
    }
    for (const planned of plan.rooms) {
      const key = scope === "main"
        ? `main:${event.match.tournamentId}:${planned.teamId}`
        : `wingman:${event.match.tournamentId}:${event.match.slug}:${planned.teamId}`;
      this.assignments.set(key, {
        key,
        name: `${scope === "main" ? "CS" : "Wingman"} ${planned.channelName}`.slice(0, 100),
        scope,
        teamId: planned.teamId,
        tournamentId: event.match.tournamentId,
        matchSlug: event.match.slug,
        memberIds: planned.memberIds
      });
    }
    await this.persist();

    return {
      plannedRooms: plan.rooms.length,
      updatedRooms: 0,
      skippedTeams: plan.skippedTeamCount,
      unmatchedPlayers: plan.unmatchedParticipantCount,
      ambiguousSteamIds: plan.ambiguousSteamIdCount
    };
  }

  async reconcileMainTournamentRooms(
    tournamentId: string,
    bracket: MatBracketSummary,
    teams: MatTeam[],
    participants: Map<string, RegisteredPerson>,
    dryRun: boolean
  ): Promise<CsDiscordSyncSummary> {
    this.assertLoaded();
    const terminalStatuses = new Set(["completed", "cancelled", "canceled"]);
    const teamIds = new Set(bracket.matches.flatMap(match => [match.team1Id, match.team2Id]
      .filter((id): id is string => id !== null)));
    const tournamentTeams = bracket.tournament.id === Number(tournamentId)
      && bracket.tournament.type !== "shuffle"
      && !terminalStatuses.has(bracket.tournament.status.toLowerCase())
      ? teams.filter(team => teamIds.has(team.id))
      : [];
    const plan = planCsTeamRooms(tournamentTeams, participants);
    for (const planned of plan.rooms) {
      const key = `main:${tournamentId}:${planned.teamId}`;
      this.assignments.set(key, {
        key,
        name: `CS ${planned.channelName}`.slice(0, 100),
        scope: "main",
        teamId: planned.teamId,
        tournamentId,
        matchSlug: "main-roster",
        memberIds: planned.memberIds
      });
    }
    if (plan.skippedTeamCount === 0) {
      const desiredKeys = new Set(plan.rooms.map(room => `main:${tournamentId}:${room.teamId}`));
      for (const [key, request] of this.assignments) {
        if (request.scope === "main" && request.tournamentId === tournamentId && !desiredKeys.has(key)) this.assignments.delete(key);
      }
    }
    await this.persist();

    return {
      plannedRooms: plan.rooms.length,
      updatedRooms: 0,
      skippedTeams: plan.skippedTeamCount,
      unmatchedPlayers: plan.unmatchedParticipantCount,
      ambiguousSteamIds: plan.ambiguousSteamIdCount
    };
  }

  async reconcileWingmanSnapshot(
    tournamentId: string,
    activeMatch: MatMatchSnapshot | null,
    participants: Map<string, RegisteredPerson>,
    dryRun: boolean
  ): Promise<CsDiscordSyncSummary> {
    this.assertLoaded();
    if (activeMatch) {
      if (activeMatch.tournamentId !== tournamentId) {
        return { plannedRooms: 0, updatedRooms: 0, skippedTeams: 1, unmatchedPlayers: 0, ambiguousSteamIds: 0 };
      }
      const event: MatWebhookEvent = {
        id: `recovery:${tournamentId}:${activeMatch.id}:${activeMatch.status}`,
        type: "match.ready",
        test: false,
        sequence: activeMatch.round ?? 0,
        match: {
          id: activeMatch.id,
          slug: activeMatch.slug,
          status: activeMatch.status,
          tournamentId,
          team1: activeMatch.team1,
          team2: activeMatch.team2
        }
      };
      return this.handleMatchEvent(event, "wingman", participants, dryRun);
    }

    for (const [key, assignment] of this.assignments) {
      if (assignment.scope === "wingman" && assignment.tournamentId === tournamentId) this.assignments.delete(key);
    }
    await this.persist();
    return { plannedRooms: 0, updatedRooms: 0, skippedTeams: 0, unmatchedPlayers: 0, ambiguousSteamIds: 0 };
  }

  async handleVoiceStateUpdate(state: VoiceState): Promise<boolean> {
    this.assertLoaded();
    if (this.globallyDryRun) return false;
    if (state.channelId !== this.lobbyChannelId || !state.id || state.member?.user.bot) return false;
    if (!await this.adapter.canRouteMemberFromLobby(state.id, this.lobbyChannelId)) return false;
    const candidates = new Map<string, CsVoiceRoomRequest>();
    for (const [key, assignment] of this.assignments) {
      if (assignment.memberIds.includes(state.id)) candidates.set(key, assignment);
    }
    if (candidates.size !== 1) return false;
    const request = candidates.values().next().value as CsVoiceRoomRequest | undefined;
    if (!request) return false;
    const previous = this.rooms.get(request.key);
    if (previous?.retiring || previous?.manualOverride) return false;
    const ensured = await this.ensureRoom(request, previous);
    if (ensured.manualOverride || !ensured.channelId) return false;
    const channelId = ensured.channelId;
    this.rooms.set(request.key, { ...request, channelId });
    await this.persist();
    return this.adapter.moveMemberFromSources(state.id, channelId, [this.lobbyChannelId]);
  }

  async getRooms(): Promise<OwnedCsRoom[]> {
    await this.writeQueue;
    this.assertLoaded();
    return [...this.rooms.values()].map(room => ({ ...room, memberIds: [...room.memberIds] }));
  }

  async getAssignments(): Promise<CsVoiceRoomRequest[]> {
    await this.writeQueue;
    this.assertLoaded();
    return [...this.assignments.values()].map(request => ({ ...request, memberIds: [...request.memberIds] }));
  }

  async reconcileParticipantRoles(
    participants: Map<string, RegisteredPerson>,
    dryRun: boolean
  ): Promise<CsParticipantRoleSummary> {
    this.assertLoaded();
    const summary: CsParticipantRoleSummary = {
      granted: 0,
      removed: 0,
      unchanged: 0,
      preservedMissingData: 0,
      manualLinks: 0
    };
    const effectiveDryRun = dryRun || this.globallyDryRun;
    for (const [discordId, participant] of participants) {
      if (participant.manualCsLink) {
        summary.manualLinks += 1;
        continue;
      }
      if (!Array.isArray(participant.tournaments)) {
        summary.preservedMissingData += 1;
        continue;
      }
      const enrolled = participant.tournaments.some(tournament => tournament === "cs2" || tournament === "cs2-wingman");
      if (effectiveDryRun) {
        summary.unchanged += 1;
        continue;
      }
      const changed = await this.adapter.setParticipantRole(discordId, enrolled);
      if (!enrolled) {
        for (const [key, request] of this.assignments) {
          if (!request.memberIds.includes(discordId)) continue;
          this.assignments.set(key, { ...request, memberIds: request.memberIds.filter(id => id !== discordId) });
        }
        await this.persist();
        await this.removeMemberFromRooms(discordId);
      }
      if (!changed) summary.unchanged += 1;
      else if (enrolled) summary.granted += 1;
      else summary.removed += 1;
    }
    return summary;
  }

  private async ensureRoom(
    request: CsVoiceRoomRequest,
    previous?: OwnedCsRoom
  ): Promise<{ channelId?: string; manualOverride: boolean }> {
    try {
      return {
        channelId: await this.adapter.ensureRoom(request, previous?.channelId, previous),
        manualOverride: false
      };
    } catch (error) {
      if (!previous || !(error instanceof Error) || error.name !== "ManualCsRoomDriftError") throw error;
      this.rooms.set(request.key, { ...previous, manualOverride: true });
      await this.persist();
      console.warn("A manually changed MAT-owned voice room is locked against automatic updates.");
      return { manualOverride: true };
    }
  }

  private async removeMemberFromRooms(memberId: string): Promise<void> {
    for (const [key, room] of this.rooms) {
      if (room.manualOverride || !room.memberIds.includes(memberId)) continue;
      await this.adapter.revokeMemberFromRoom(room.channelId, memberId);
      this.rooms.set(key, { ...room, memberIds: room.memberIds.filter(id => id !== memberId) });
      await this.persist();
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("CS voice-channel state has not been loaded.");
  }

  private persist(): Promise<void> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      const payload: PersistedCsRoomState = {
        version: 2,
        rooms: [...this.rooms.values()],
        assignments: [...this.assignments.values()]
      };
      await writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = task;
    return task;
  }
}