import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { VoiceState } from "discord.js";
import { planCsTeamRooms } from "./csTournamentSync.js";
import type { MatBracketSummary, MatTeam } from "./matClient.js";
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
  ensureRoom(request: CsVoiceRoomRequest, existingChannelId?: string): Promise<string>;
  moveMemberFromSources(memberId: string, channelId: string, allowedSourceChannelIds: string[]): Promise<boolean>;
  setParticipantRole(memberId: string, shouldHaveRole: boolean): Promise<boolean>;
  revokeMemberFromRoom(channelId: string, memberId: string): Promise<void>;
  deleteRoomWhenEmpty(channelId: string, delayMs: number, onDeleted: () => void): void;
}

interface OwnedCsRoom extends CsVoiceRoomRequest {
  channelId: string;
  retiring?: boolean;
}

interface PersistedCsRoomState {
  version: 1;
  rooms: OwnedCsRoom[];
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
    && Array.isArray(value.memberIds) && value.memberIds.every(id => typeof id === "string" && discordIdPattern.test(id));
}

export class CsDiscordManager {
  private readonly rooms = new Map<string, OwnedCsRoom>();
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
      if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.rooms)
        || payload.rooms.some(room => !isOwnedRoom(room))
        || new Set(payload.rooms.map(room => (room as OwnedCsRoom).key)).size !== payload.rooms.length) {
        throw new Error("Invalid CS voice-channel ownership state.");
      }
      for (const room of payload.rooms as OwnedCsRoom[]) this.rooms.set(room.key, room);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CS voice-channel ownership state could not be loaded.");
    }
    this.loaded = true;
    for (const room of this.rooms.values()) {
      if (room.retiring) this.adapter.deleteRoomWhenEmpty(room.channelId, this.deleteDelayMs, () => {
        void this.removeRetiredRoom(room.key);
      });
    }
  }

  async handleMatchEvent(
    event: MatWebhookEvent,
    scope: CsVoiceRoomScope,
    participants: Map<string, RegisteredPerson>,
    dryRun: boolean
  ): Promise<CsDiscordSyncSummary> {
    this.assertLoaded();
    const effectiveDryRun = dryRun || this.globallyDryRun;
    if (event.type !== "match.ready") {
      if (!effectiveDryRun && scope === "wingman" && ["match.finished", "match.cancelled", "match.reset"].includes(event.type)) {
        await this.retireWingmanMatch(event.match.tournamentId, event.match.slug);
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
    let updatedRooms = 0;
    if (!effectiveDryRun) {
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
        const previousRooms = [...this.rooms.values()].filter(room => room.scope === scope
          && room.tournamentId === event.match.tournamentId);
        const updates: Array<{ channelId: string; memberIds: string[] }> = [];
      for (const planned of plan.rooms) {
        const sourceTeam = teams.find(team => team.id === planned.teamId);
        if (!sourceTeam) continue;
        const key = scope === "main"
          ? `main:${event.match.tournamentId}:${planned.teamId}`
          : `wingman:${event.match.tournamentId}:${event.match.slug}:${planned.teamId}`;
        const previous = this.rooms.get(key);
        const request: CsVoiceRoomRequest = {
          key,
          name: `${scope === "main" ? "CS" : "Wingman"} ${planned.channelName}`.slice(0, 100),
          scope,
          teamId: planned.teamId,
          tournamentId: event.match.tournamentId,
          matchSlug: event.match.slug,
          memberIds: planned.memberIds
        };
        const channelId = await this.adapter.ensureRoom(request, previous?.channelId);
        this.rooms.set(key, { ...request, channelId });
        await this.persist();
        updates.push({ channelId, memberIds: request.memberIds });
        if (!previous || previous.channelId !== channelId || previous.memberIds.join(",") !== request.memberIds.join(",")) {
          updatedRooms += 1;
        }
      }
      const allowedSourceIds = [this.lobbyChannelId, ...previousRooms.map(room => room.channelId)];
      for (const update of updates) {
        for (const memberId of update.memberIds) {
          await this.adapter.moveMemberFromSources(memberId, update.channelId, allowedSourceIds);
        }
      }
      if (scope === "wingman") await this.retireOtherWingmanMatches(event.match.tournamentId, event.match.slug);
    }

    return {
      plannedRooms: plan.rooms.length,
      updatedRooms,
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
    let updatedRooms = 0;

    if (!dryRun && !this.globallyDryRun) {
      const previousRooms = [...this.rooms.values()].filter(room => room.scope === "main"
        && room.tournamentId === tournamentId);
      const updates: Array<{ channelId: string; memberIds: string[] }> = [];
      for (const planned of plan.rooms) {
        const key = `main:${tournamentId}:${planned.teamId}`;
        const previous = this.rooms.get(key);
        const request: CsVoiceRoomRequest = {
          key,
          name: `CS ${planned.channelName}`.slice(0, 100),
          scope: "main",
          teamId: planned.teamId,
          tournamentId,
          matchSlug: "main-roster",
          memberIds: planned.memberIds
        };
        const channelId = await this.adapter.ensureRoom(request, previous?.channelId);
        this.rooms.set(key, { ...request, channelId });
        await this.persist();
        updates.push({ channelId, memberIds: request.memberIds });
        if (!previous || previous.channelId !== channelId || previous.memberIds.join(",") !== request.memberIds.join(",")) {
          updatedRooms += 1;
        }
      }
      const allowedSourceIds = [this.lobbyChannelId, ...previousRooms.map(room => room.channelId)];
      for (const update of updates) {
        for (const memberId of update.memberIds) {
          await this.adapter.moveMemberFromSources(memberId, update.channelId, allowedSourceIds);
        }
      }
    }

    return {
      plannedRooms: plan.rooms.length,
      updatedRooms,
      skippedTeams: plan.skippedTeamCount,
      unmatchedPlayers: plan.unmatchedParticipantCount,
      ambiguousSteamIds: plan.ambiguousSteamIdCount
    };
  }

  async handleVoiceStateUpdate(state: VoiceState): Promise<boolean> {
    this.assertLoaded();
    if (this.globallyDryRun) return false;
    if (state.channelId !== this.lobbyChannelId || !state.id || state.member?.user.bot) return false;
    const targets = new Set<string>();
    for (const room of this.rooms.values()) {
      if (!room.retiring && room.memberIds.includes(state.id)) targets.add(room.channelId);
    }
    if (targets.size !== 1) return false;
    const channelId = targets.values().next().value as string | undefined;
    if (!channelId) return false;
    return this.adapter.moveMemberFromSources(state.id, channelId, [this.lobbyChannelId]);
  }

  async getRooms(): Promise<OwnedCsRoom[]> {
    await this.writeQueue;
    this.assertLoaded();
    return [...this.rooms.values()].map(room => ({ ...room, memberIds: [...room.memberIds] }));
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
        await this.removeMemberFromRooms(discordId);
      }
      if (!changed) summary.unchanged += 1;
      else if (enrolled) summary.granted += 1;
      else summary.removed += 1;
    }
    return summary;
  }

  private async removeMemberFromRooms(memberId: string): Promise<void> {
    for (const [key, room] of this.rooms) {
      if (!room.memberIds.includes(memberId)) continue;
      await this.adapter.revokeMemberFromRoom(room.channelId, memberId);
      this.rooms.set(key, { ...room, memberIds: room.memberIds.filter(id => id !== memberId) });
      await this.persist();
    }
  }

  private async retireWingmanMatch(tournamentId: string, matchSlug: string): Promise<void> {
    for (const [key, room] of this.rooms) {
      if (room.scope !== "wingman" || room.tournamentId !== tournamentId || room.matchSlug !== matchSlug) continue;
      if (room.retiring) continue;
      this.rooms.set(key, { ...room, retiring: true });
      await this.persist();
      this.adapter.deleteRoomWhenEmpty(room.channelId, this.deleteDelayMs, () => {
        void this.removeRetiredRoom(key);
      });
    }
  }

  private async retireOtherWingmanMatches(tournamentId: string, currentMatchSlug: string): Promise<void> {
    for (const [key, room] of this.rooms) {
      if (room.scope !== "wingman" || room.tournamentId !== tournamentId
        || room.matchSlug === currentMatchSlug || room.retiring) continue;
      this.rooms.set(key, { ...room, retiring: true });
      await this.persist();
      this.adapter.deleteRoomWhenEmpty(room.channelId, this.deleteDelayMs, () => {
        void this.removeRetiredRoom(key);
      });
    }
  }
  private async removeRetiredRoom(key: string): Promise<void> {
    const room = this.rooms.get(key);
    if (!room?.retiring) return;
    this.rooms.delete(key);
    await this.persist();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("CS voice-channel state has not been loaded.");
  }

  private persist(): Promise<void> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      const payload: PersistedCsRoomState = { version: 1, rooms: [...this.rooms.values()] };
      await writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = task;
    return task;
  }
}