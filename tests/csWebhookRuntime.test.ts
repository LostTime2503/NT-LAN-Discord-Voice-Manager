import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CsEventStore } from "../src/csEventStore.js";
import {
  CsWebhookRuntime,
  selectRecoverableWingmanMatches,
  toRecoveredWingmanEvent,
  type CsWebhookDryRunReport
} from "../src/csWebhookRuntime.js";
import type { MatBracketSummary, MatMatchSnapshot } from "../src/matClient.js";
import type { RegisteredPerson } from "../src/registrationClient.js";
import { CsDiscordManager, type CsDiscordAdapter } from "../src/csDiscordManager.js";

const secret = "synthetic-webhook-secret-with-enough-entropy";
const discordOne = "123456789012345678";
const discordTwo = "123456789012345679";
const steamOne = "76561198000000001";
const steamTwo = "76561198000000002";

test("Wingman recovery selects one active match from a valid 2v2 shuffle bracket", () => {
  const bracket: MatBracketSummary = {
    tournament: { id: 4, type: "shuffle", status: "active", teamSize: 2 },
    totalRounds: 2,
    matches: [
      { slug: "finished", round: 1, status: "completed", team1Id: "old-a", team2Id: "old-b" },
      { slug: "active", round: 2, status: "loaded", team1Id: "new-a", team2Id: "new-b" },
      { slug: "waiting", round: 2, status: "pending", team1Id: "later-a", team2Id: "later-b" }
    ]
  };
  assert.deepEqual(selectRecoverableWingmanMatches(bracket), ["active"]);
  assert.equal(selectRecoverableWingmanMatches({
    ...bracket,
    tournament: { ...bracket.tournament, type: "single_elimination" }
  }), null);
  assert.equal(selectRecoverableWingmanMatches({
    ...bracket,
    matches: [
      ...bracket.matches,
      { slug: "second-active", round: 2, status: "live", team1Id: "x", team2Id: "y" }
    ]
  }), null);
});

test("recovered match normalization retains pairing identity but not connect data", () => {
  const match: MatMatchSnapshot = {
    id: "42",
    slug: "active-match",
    status: "live",
    tournamentId: "4",
    round: 2,
    team1: { id: "duo-a", name: "private", tag: "A", steamIds: [steamOne, steamTwo] },
    team2: { id: "duo-b", name: "private", tag: "B", steamIds: ["76561198000000003", "76561198000000004"] }
  };
  const recovered = toRecoveredWingmanEvent(match);
  assert.equal(recovered.type, "match.ready");
  assert.equal(recovered.match.tournamentId, "4");
  assert.deepEqual(recovered.match.team1?.steamIds, [steamOne, steamTwo]);
  assert.equal(JSON.stringify(recovered).includes("password"), false);
});

test("signed match.ready is persisted then produces aggregate dry-run plan only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-webhook-runtime-"));
  const store = new CsEventStore(join(directory, "events.json"));
  const participants = new Map<string, RegisteredPerson>([
    [discordOne, { name: "private player one", firstName: "Player", steamId: steamOne }],
    [discordTwo, { name: "private player two", firstName: "Player", steamId: steamTwo }]
  ]);
  let resolveReport!: (report: CsWebhookDryRunReport) => void;
  const reportPromise = new Promise<CsWebhookDryRunReport>(resolve => { resolveReport = resolve; });
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    mainTournamentId: 3,
    wingmanTournamentId: 4,
    registration: {
      getParticipants: async () => new Map(),
      getCsParticipants: async () => participants
    },
    store,
    report: resolveReport
  });

  try {
    await runtime.start();
    const address = runtime.address;
    assert.ok(address);
    const payload = {
      id: "runtime-event-1",
      type: "match.ready",
      test: false,
      data: {
        sequence: 1,
        match: {
          id: 12,
          slug: "fixture-match",
          status: "loaded",
          game: "cs2",
          tournament: { id: 3 },
          team1: { id: "team-one", name: "private", tag: "A", players: [{ steam_id64: steamOne }] },
          team2: { id: "team-two", name: "private", tag: "B", players: [{ steam_id64: steamTwo }] },
          connect: { password: "must-not-be-retained" }
        }
      }
    };
    const body = Buffer.from(JSON.stringify(payload));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/mat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-at-signature": `t=${timestamp},v1=${digest}` },
      body
    });
    assert.equal(response.status, 202);
    const report = await Promise.race([
      reportPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dry-run was not reported")), 2_000))
    ]);
    assert.deepEqual(report, {
      eventType: "match.ready",
      tournament: "main",
      plannedRooms: 2,
      updatedRooms: 0,
      skippedTeams: 0,
      unmatchedPlayers: 0,
      ambiguousSteamIds: 0
    });
    assert.deepEqual(await store.getPending(), []);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime startup restores only the active Wingman match from bracket and match GETs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-wingman-startup-"));
  const mainBracket: MatBracketSummary = {
    tournament: { id: 3, type: "single_elimination", status: "active", teamSize: 5 },
    totalRounds: 0,
    matches: []
  };
  const wingmanBracket: MatBracketSummary = {
    tournament: { id: 4, type: "shuffle", status: "active", teamSize: 2 },
    totalRounds: 2,
    matches: [
      { slug: "old", round: 1, status: "completed", team1Id: "old-a", team2Id: "old-b" },
      { slug: "current", round: 2, status: "live", team1Id: "pair-a", team2Id: "pair-b" }
    ]
  };
  const match: MatMatchSnapshot = {
    id: "match-44", slug: "current", status: "live", tournamentId: "4", round: 2,
    team1: { id: "pair-a", name: "private", tag: "A", steamIds: [steamOne, steamTwo] },
    team2: { id: "pair-b", name: "private", tag: "B", steamIds: ["76561198000000003", "76561198000000004"] }
  };
  const discordAdapter: CsDiscordAdapter = {
    ensureRoom: async () => { throw new Error("Dry-run must not create rooms"); },
    moveMemberFromSources: async () => { throw new Error("Dry-run must not move members"); },
    setParticipantRole: async () => { throw new Error("Dry-run must not change roles"); },
    revokeMemberFromRoom: async () => { throw new Error("Dry-run must not revoke channel access"); },
    deleteRoomWhenEmpty: () => { throw new Error("Dry-run must not schedule cleanup"); }
  };
  const manager = new CsDiscordManager(discordAdapter, "123456789012345680", 5_000, join(directory, "rooms.json"));
  let fetchedMatchSlug = "";
  const mat = {
    getBracketSummary: async (id: number) => id === 3 ? mainBracket : wingmanBracket,
    getTeams: async () => [],
    getMatch: async (slug: string) => { fetchedMatchSlug = slug; return match; }
  } as unknown as MatClient;
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    mat,
    mainTournamentId: 3,
    wingmanTournamentId: 4,
    dryRun: true,
    registration: { getParticipants: async () => new Map(), getCsParticipants: async () => new Map() },
    discordManager: manager,
    store: new CsEventStore(join(directory, "events.json"))
  });

  try {
    await runtime.start();
    assert.equal(fetchedMatchSlug, "current");
    assert.deepEqual(await manager.getRooms(), []);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});