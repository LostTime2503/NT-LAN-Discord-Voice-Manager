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
import type { MatBracketSummary, MatClient, MatMatchSnapshot } from "../src/matClient.js";
import type { RegisteredPerson } from "../src/registrationClient.js";
import { CsDiscordManager, type CsDiscordAdapter } from "../src/csDiscordManager.js";
import type { MatTournament } from "../src/matClient.js";

const secret = "synthetic-webhook-secret-with-enough-entropy";
const discordOne = "123456789012345678";
const discordTwo = "123456789012345679";
const steamOne = "76561198000000001";
const steamTwo = "76561198000000002";

function signedReadyRequest(tournamentId: number, id = "runtime-test-event") {
  const payload = {
    id,
    type: "match.ready",
    test: false,
    data: {
      sequence: 1,
      match: {
        id: 12,
        slug: "fixture-match",
        status: "loaded",
        game: "cs2",
        tournament: { id: tournamentId },
        team1: { id: "team-one", name: "private", tag: "A", players: [{ steam_id64: steamOne }] },
        team2: { id: "team-two", name: "private", tag: "B", players: [{ steam_id64: steamTwo }] }
      }
    }
  };
  const body = Buffer.from(JSON.stringify(payload));
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  return {
    body,
    headers: { "content-type": "application/json", "x-at-signature": `t=${timestamp},v1=${digest}` }
  };
}

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
    mat: {
      getTournaments: async () => [
        { id: 3, type: "single_elimination", status: "active", teamSize: 5 },
        { id: 4, type: "shuffle", status: "active", teamSize: 2 }
      ]
    } as unknown as MatClient,
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

test("runtime startup discovers Main/Wingman formats and restores the active Wingman match", async () => {
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
    canRouteMemberFromLobby: async () => { throw new Error("Dry-run must not inspect members"); },
    moveMemberFromSources: async () => { throw new Error("Dry-run must not move members"); },
    setParticipantRole: async () => { throw new Error("Dry-run must not change roles"); },
    revokeMemberFromRoom: async () => { throw new Error("Dry-run must not revoke channel access"); }
  };
  const manager = new CsDiscordManager(discordAdapter, "123456789012345680", 5_000, join(directory, "rooms.json"));
  let fetchedMatchSlug = "";
  const mat = {
    getTournaments: async () => [
      { id: 3, type: "single_elimination", status: "active", teamSize: 5 },
      { id: 4, type: "shuffle", status: "active", teamSize: 2 }
    ],
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

test("webhook ACK follows durable acceptance without waiting for MAT discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-webhook-ack-"));
  let discoveryCalls = 0;
  let releaseDiscovery!: (tournaments: MatTournament[]) => void;
  const delayedDiscovery = new Promise<MatTournament[]>(resolve => { releaseDiscovery = resolve; });
  const store = new CsEventStore(join(directory, "events.json"));
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    mat: {
      getTournaments: async () => {
        discoveryCalls += 1;
        if (discoveryCalls === 1) return [{ id: 3, type: "single_elimination", status: "active", teamSize: 5 }];
        return delayedDiscovery;
      }
    } as unknown as MatClient,
    registration: { getParticipants: async () => new Map() },
    store,
    report: () => undefined
  });

  try {
    await runtime.start();
    const address = runtime.address;
    assert.ok(address);
    const request = signedReadyRequest(99, "unknown-tournament-event");
    const responsePromise = fetch(`http://127.0.0.1:${address.port}/webhooks/mat`, {
      method: "POST",
      headers: request.headers,
      body: request.body
    });
    const response = await Promise.race([
      responsePromise,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 250))
    ]);
    assert.ok(response, "receiver should ACK without waiting for MAT discovery");
    assert.equal(response.status, 202);
    assert.deepEqual((await store.getPending()).map(event => event.id), ["unknown-tournament-event"]);
  } finally {
    releaseDiscovery([{ id: 3, type: "single_elimination", status: "active", teamSize: 5 }]);
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime stop waits for in-flight webhook processing before it returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-webhook-stop-"));
  const store = new CsEventStore(join(directory, "events.json"));
  await store.load();
  await store.accept({
    id: "pending-before-start",
    type: "match.ready",
    test: false,
    sequence: 1,
    match: {
      id: "match-1",
      slug: "match-1",
      status: "loaded",
      tournamentId: "3",
      team1: { id: "team-one", name: "A", tag: "A", steamIds: [steamOne] },
      team2: { id: "team-two", name: "B", tag: "B", steamIds: [steamTwo] }
    }
  });
  let processingStarted!: () => void;
  const started = new Promise<void>(resolve => { processingStarted = resolve; });
  let releaseParticipants!: (participants: Map<string, RegisteredPerson>) => void;
  const delayedParticipants = new Promise<Map<string, RegisteredPerson>>(resolve => { releaseParticipants = resolve; });
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    mat: {
      getTournaments: async () => [{ id: 3, type: "single_elimination", status: "active", teamSize: 5 }]
    } as unknown as MatClient,
    registration: {
      getParticipants: async () => new Map(),
      getCsParticipants: async () => {
        processingStarted();
        return delayedParticipants;
      }
    },
    store,
    report: () => undefined
  });

  try {
    await runtime.start();
    await started;
    let stopped = false;
    const stopPromise = runtime.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(stopped, false, "stop should wait for accepted work to finish");
    releaseParticipants(new Map([
      [discordOne, { name: "One", firstName: "One", steamId: steamOne }],
      [discordTwo, { name: "Two", firstName: "Two", steamId: steamTwo }]
    ]));
    await stopPromise;
    assert.deepEqual(await store.getPending(), []);
  } finally {
    releaseParticipants(new Map());
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("webhook diagnostics report local health and only count a signed MAT test event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-webhook-diagnostics-"));
  const store = new CsEventStore(join(directory, "events.json"));
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    registration: { getParticipants: async () => new Map() },
    store,
    report: () => undefined
  });

  try {
    await runtime.start();
    const address = runtime.address;
    assert.ok(address);
    const initial = await runtime.getDiagnostics();
    assert.equal(initial.listening, true);
    assert.equal(initial.healthCheckOk, true);
    assert.equal(initial.lastTestEventAt, null);

    const body = Buffer.from(JSON.stringify({ id: "mat-test-event", type: "match.ready", test: true }));
    const timestamp = Math.floor(Date.now() / 1000);
    const validDigest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
    const invalid = await fetch(`http://127.0.0.1:${address.port}/webhooks/mat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-at-signature": `t=${timestamp},v1=${"0".repeat(64)}` },
      body
    });
    assert.equal(invalid.status, 401);
    assert.equal((await runtime.getDiagnostics()).lastSignedRequestAt, null);

    const valid = await fetch(`http://127.0.0.1:${address.port}/webhooks/mat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-at-signature": `t=${timestamp},v1=${validDigest}` },
      body
    });
    assert.equal(valid.status, 202);
    const received = await runtime.getDiagnostics();
    assert.equal(received.lastSignedRequestType, "match.ready");
    assert.ok(received.lastSignedRequestAt);
    assert.equal(received.lastTestEventAt, received.lastSignedRequestAt);
    assert.deepEqual(await store.getPending(), []);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});