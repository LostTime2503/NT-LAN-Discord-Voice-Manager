import type { MatBracketSummary, MatTeam } from "./matClient.js";
import type { RegisteredPerson } from "./registrationClient.js";

export interface CsTeamRoomPlan {
  teamId: string;
  channelName: string;
  memberIds: string[];
}

export interface CsTeamRoomPlanResult {
  rooms: CsTeamRoomPlan[];
  skippedTeamCount: number;
  unmatchedParticipantCount: number;
  ambiguousSteamIdCount: number;
}

const discordIdPattern = /^\d{17,20}$/;
const steamId64Pattern = /^7656119\d{10}$/;

export function planCsTeamRooms(
  teams: MatTeam[],
  participants: Map<string, RegisteredPerson>
): CsTeamRoomPlanResult {
  const participantsBySteamId = new Map<string, string[]>();
  for (const [discordId, participant] of participants) {
    if (!discordIdPattern.test(discordId) || !participant.steamId || !steamId64Pattern.test(participant.steamId)) continue;
    const matches = participantsBySteamId.get(participant.steamId) ?? [];
    matches.push(discordId);
    participantsBySteamId.set(participant.steamId, matches);
  }

  const teamsBySteamId = new Map<string, string[]>();
  for (const team of teams) {
    for (const player of team.players) {
      if (!player.steamId || !steamId64Pattern.test(player.steamId)) continue;
      const matches = teamsBySteamId.get(player.steamId) ?? [];
      matches.push(team.id);
      teamsBySteamId.set(player.steamId, matches);
    }
  }

  let ambiguousSteamIdCount = 0;
  const ambiguousSteamIds = new Set<string>();
  for (const [steamId, discordIds] of participantsBySteamId) {
    if (discordIds.length > 1) ambiguousSteamIds.add(steamId);
  }
  for (const [steamId, teamIds] of teamsBySteamId) {
    if (teamIds.length > 1) ambiguousSteamIds.add(steamId);
  }
  ambiguousSteamIdCount = ambiguousSteamIds.size;

  let unmatchedParticipantCount = 0;
  const rooms: CsTeamRoomPlan[] = [];
  let skippedTeamCount = 0;
  for (const team of teams) {
    const steamIds = team.players.map(player => player.steamId);
    const uniqueSteamIds = new Set(steamIds.filter((value): value is string => typeof value === "string"));
    if (steamIds.length === 0 || uniqueSteamIds.size !== steamIds.length) {
      skippedTeamCount += 1;
      continue;
    }

    const memberIds: string[] = [];
    let complete = true;
    for (const steamId of uniqueSteamIds) {
      const discordIds = participantsBySteamId.get(steamId);
      if (!steamId64Pattern.test(steamId) || ambiguousSteamIds.has(steamId) || !discordIds?.length) {
        complete = false;
        if (!discordIds?.length) unmatchedParticipantCount += 1;
        continue;
      }
      memberIds.push(discordIds[0]!);
    }

    if (!complete || memberIds.length !== team.players.length) {
      skippedTeamCount += 1;
      continue;
    }
    rooms.push({
      teamId: team.id,
      channelName: team.tag || team.name,
      memberIds
    });
  }

  return { rooms, skippedTeamCount, unmatchedParticipantCount, ambiguousSteamIdCount };
}

export interface CsTournamentRoomPlans {
  main: CsTeamRoomPlanResult;
  wingman: CsTeamRoomPlanResult;
}

export function planCsTournamentRooms(
  mainBracket: MatBracketSummary,
  wingmanBracket: MatBracketSummary,
  teams: MatTeam[],
  participants: Map<string, RegisteredPerson>
): CsTournamentRoomPlans {
  const terminalStatuses = new Set(["completed", "cancelled", "canceled", "bye"]);
  const mainTeamIds = new Set(mainBracket.matches.flatMap(match => [match.team1Id, match.team2Id]
    .filter((id): id is string => id !== null)));
  const mainTeams = mainBracket.tournament.type !== "shuffle"
    && !terminalStatuses.has(mainBracket.tournament.status.toLowerCase())
    ? teams.filter(team => mainTeamIds.has(team.id))
    : [];

  const openRounds = wingmanBracket.matches.filter(match => match.round !== null && match.status !== null
    && !terminalStatuses.has(match.status.toLowerCase()));
  const currentRound = openRounds.reduce((highest, match) => Math.max(highest, match.round ?? 0), 0);
  const wingmanTeamIds = new Set(openRounds.filter(match => match.round === currentRound)
    .flatMap(match => [match.team1Id, match.team2Id]).filter((id): id is string => id !== null));
  const wingmanTeams = wingmanBracket.tournament.type === "shuffle"
    && !terminalStatuses.has(wingmanBracket.tournament.status.toLowerCase())
    ? teams.filter(team => wingmanTeamIds.has(team.id))
    : [];

  return {
    main: planCsTeamRooms(mainTeams, participants),
    wingman: planCsTeamRooms(wingmanTeams, participants)
  };
}