import assert from "node:assert/strict";
import { test } from "node:test";
import { planCsTeamRooms, planCsTournamentRooms } from "../src/csTournamentSync.js";
import { CsSyncRuntime } from "../src/csSyncRuntime.js";
import type { MatClient } from "../src/matClient.js";
import type { MatBracketSummary, MatTeam } from "../src/matClient.js";
import type { RegisteredPerson } from "../src/registrationClient.js";

const steamOne = "76561198000000001";
const steamTwo = "76561198000000002";
const discordOne = "123456789012345678";
const discordTwo = "123456789012345679";
const teams: MatTeam[] = [{
  id: "mat-team-1",
  name: "Blue team",
  tag: "BLUE",
  players: [{ steamId: steamOne }, { steamId: steamTwo }]
}];
const participantsFixture = participants([
  [discordOne, { name: "Player One", firstName: "Player", steamId: steamOne }],
  [discordTwo, { name: "Player Two", firstName: "Player", steamId: steamTwo }]
]);

function participants(entries: Array<[string, RegisteredPerson]>): Map<string, RegisteredPerson> {
  return new Map(entries);
}

test("complete unique SteamID matches produce a room plan", () => {
  const result = planCsTeamRooms(teams, participants([
    [discordOne, { name: "Player One", firstName: "Player", steamId: steamOne }],
    [discordTwo, { name: "Player Two", firstName: "Player", steamId: steamTwo }]
  ]));
  assert.deepEqual(result, {
    rooms: [{ teamId: "mat-team-1", channelName: "BLUE", memberIds: [discordOne, discordTwo] }],
    skippedTeamCount: 0,
    unmatchedParticipantCount: 0,
    ambiguousSteamIdCount: 0
  });
});

test("missing or ambiguous Steam mappings never produce a room", () => {
  const missing = planCsTeamRooms(teams, participants([
    [discordOne, { name: "Player One", firstName: "Player", steamId: steamOne }]
  ]));
  assert.equal(missing.rooms.length, 0);
  assert.equal(missing.skippedTeamCount, 1);
  assert.equal(missing.unmatchedParticipantCount, 1);

  const ambiguous = planCsTeamRooms(teams, participants([
    [discordOne, { name: "Player One", firstName: "Player", steamId: steamOne }],
    [discordTwo, { name: "Another account", firstName: "Another", steamId: steamOne }],
    ["123456789012345680", { name: "Player Two", firstName: "Player", steamId: steamTwo }]
  ]));
  assert.equal(ambiguous.rooms.length, 0);
  assert.equal(ambiguous.skippedTeamCount, 1);
  assert.equal(ambiguous.ambiguousSteamIdCount, 1);
});

test("teams with incomplete or repeated MAT roster IDs are skipped", () => {
  const incomplete: MatTeam[] = [{
    id: "incomplete",
    name: "Incomplete",
    tag: null,
    players: [{ steamId: steamOne }, { steamId: null }]
  }];
  const repeated: MatTeam[] = [{ ...teams[0]!, players: [{ steamId: steamOne }, { steamId: steamOne }] }];
  const linked = participants([[discordOne, { name: "Player One", firstName: "Player", steamId: steamOne }]]);
  assert.equal(planCsTeamRooms(incomplete, linked).skippedTeamCount, 1);
  assert.equal(planCsTeamRooms(repeated, linked).skippedTeamCount, 1);
});

test("tournament planning uses bracket teams and only the latest open shuffle round", () => {
  const bracket = (type: string, status: string, matches: MatBracketSummary["matches"]): MatBracketSummary => ({
    tournament: { id: 7, type, status, teamSize: 2 },
    totalRounds: 2,
    matches
  });
  const allTeams: MatTeam[] = [
    ...teams,
    { id: "old-pair", name: "Old", tag: "OLD", players: [{ steamId: steamOne }] },
    { id: "next-pair", name: "Next", tag: "NEXT", players: [{ steamId: steamTwo }] }
  ];
  const result = planCsTournamentRooms(
    bracket("single_elimination", "active", [
      { slug: "main-match", round: 1, status: "pending", team1Id: "mat-team-1", team2Id: null }
    ]),
    bracket("shuffle", "active", [
      { slug: "old-match", round: 1, status: "completed", team1Id: "old-pair", team2Id: null },
      { slug: "current-match", round: 2, status: "in_progress", team1Id: "next-pair", team2Id: null }
    ]),
    allTeams,
    participantsFixture
  );
  assert.deepEqual(result.main.rooms.map(room => room.teamId), ["mat-team-1"]);
  assert.deepEqual(result.wingman.rooms.map(room => room.teamId), ["next-pair"]);
});

test("completed or non-shuffle Wingman tournaments produce no rooms", () => {
  const emptyBracket: MatBracketSummary = {
    tournament: { id: 8, type: "single_elimination", status: "completed", teamSize: 2 },
    totalRounds: 1,
    matches: [{ slug: "ended", round: 1, status: "completed", team1Id: "mat-team-1", team2Id: null }]
  };
  const result = planCsTournamentRooms(emptyBracket, emptyBracket, teams, participantsFixture);
  assert.equal(result.main.rooms.length, 0);
  assert.equal(result.wingman.rooms.length, 0);
});

test("dry-run runtime reports aggregate plans without Discord mutations", async () => {
  const mainBracket: MatBracketSummary = {
    tournament: { id: 10, type: "single_elimination", status: "active", teamSize: 2 },
    totalRounds: 1,
    matches: [{ slug: "main-match", round: 1, status: "pending", team1Id: "mat-team-1", team2Id: null }]
  };
  const wingmanBracket: MatBracketSummary = {
    tournament: { id: 11, type: "shuffle", status: "active", teamSize: 2 },
    totalRounds: 1,
    matches: [{ slug: "wingman-match", round: 1, status: "in_progress", team1Id: "mat-team-1", team2Id: null }]
  };
  const mat = {
    getTeams: async () => teams,
    getTournaments: async () => [
      { id: 10, type: "single_elimination", status: "active", teamSize: 5 },
      { id: 11, type: "shuffle", status: "active", teamSize: 2 }
    ],
    getBracketSummary: async (id: number) => id === 10 ? mainBracket : wingmanBracket
  } as unknown as MatClient;
  let report: unknown;
  const runtime = new CsSyncRuntime(mat, {
    getParticipants: async () => participantsFixture
  }, 30_000, summary => { report = summary; });

  const result = await runtime.runOnce();
  assert.deepEqual(result, {
    participantCount: 2,
    mainTeamRoomCount: 1,
    mainSkippedTeamCount: 0,
    wingmanPairRoomCount: 1,
    wingmanSkippedPairCount: 0,
    unmatchedParticipantCount: 0,
    ambiguousSteamIdCount: 0,
    ambiguousMainTournamentCount: 0,
    ambiguousWingmanTournamentCount: 0
  });
  assert.deepEqual(report, result);
});