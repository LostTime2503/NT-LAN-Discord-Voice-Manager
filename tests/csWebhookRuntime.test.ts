import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import type { CsSourceMode } from "../src/botSettings.js";
import type { MatTournament } from "../src/matClient.js";

const secret = "synthetic-webhook-secret-with-enough-entropy";
const discordOne = "123456789012345678";
const discordTwo = "123456789012345679";
const steamOne = "76561198000000001";
const steamTwo = "76561198000000002";

test("test sender uses isolated source, previews without assignments, and creates/cleans rooms in live mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-test-source-"));
  const testSecret = "synthetic-separate-test-secret";
  let mode: CsSourceMode = "off";
  let created = 0;
  const deleted: string[] = [];
  const notices: string[] = [];
  const participants = new Map<string, RegisteredPerson>([
    [discordOne, { name: "fixture", firstName: "fixture", steamId: steamOne }],
    [discordTwo, { name: "fixture", firstName: "fixture", steamId: steamTwo }],
    ["123456789012345680", { name: "fixture", firstName: "fixture", steamId: "76561198000000003" }],
    ["123456789012345681", { name: "fixture", firstName: "fixture", steamId: "76561198000000004" }]
  ]);
  const adapter = {
    ensureRoom: async () => String(4_000_000_000_000_000_000n + BigInt(++created)),
    canRouteMemberFromLobby: async () => false,
    canRouteMemberFromCsVoice: async () => false,
    deleteRoomWhenEmpty: async (id: string, _delay: number, onDeleted: () => Promise<void>) => {
      deleted.push(id);
      await onDeleted();
    },
    cancelAllRoomDeletions: () => undefined
  } as unknown as CsDiscordAdapter;
  const manager = new CsDiscordManager(adapter, "111111111111111111", 1, join(directory, "rooms.json"), false);
  const store = new CsEventStore(join(directory, "events.json"));
  const reports: CsWebhookDryRunReport[] = [];
  const runtime = new CsWebhookRuntime({
    secret: testSecret, port: 0, host: "127.0.0.1", path: "/webhooks/cs-test", namespace: "test",
    getMode: () => mode, dryRun: false, intervalMs: 60_000,
    registration: { getParticipants: async () => participants },
    discordManager: manager, store, report: summary => reports.push(summary),
    onTestEvent: () => notices.push("signature-test"),
    onEventIgnored: (_eventType, reason) => notices.push(reason)
  });
  try {
    await runtime.start();
    const url = `http://127.0.0.1:${runtime.address!.port}/webhooks/cs-test`;
    const send = async (sequence: number, extra: string[] = []) => {
      const result = await promisify(execFile)(process.execPath, [
        "scripts/send-fake-cs-match.mjs", `--url=${url}`, "--match-id=fixture-match", `--sequence=${sequence}`,
        `--team-one=${steamOne},${steamTwo}`, "--team-two=76561198000000003,76561198000000004", ...extra
      ], { env: { ...process.env, CS_TEST_WEBHOOK_SECRET: testSecret } });
      assert.match(result.stdout, /HTTP 202/);
      for (let attempt = 0; attempt < 200 && (await store.getPending()).length; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.deepEqual(await store.getPending(), []);
    };
    await send(1, ["--signature-test"]);
    await send(2);
    assert.equal(created, 0);
    assert.deepEqual(await manager.getAssignments(), []);
    assert.ok(notices.includes("signature-test"));
    assert.ok(notices.some(reason => reason.includes("kilden er av")));

    mode = "preview";
    await send(3);
    assert.equal(created, 0);
    assert.deepEqual(await manager.getAssignments(), []);
    assert.equal(reports.at(-1)?.dryRun, true);
    assert.equal(reports.at(-1)?.plannedRooms, 2);

    mode = "live";
    await send(4);
    assert.equal(created, 2);
    const assignments = await manager.getAssignments();
    assert.equal(assignments.length, 2);
    assert.ok(assignments.every(request => request.tournamentId.startsWith("test:") && request.matchSlug.startsWith("test:")));
    await send(5, ["--event=match.finished"]);
    assert.deepEqual(await manager.getAssignments(), []);
    assert.deepEqual(await manager.getRooms(), []);
    assert.equal(deleted.length, 2);

    const wrongSecret = signedReadyRequest(3);
    assert.equal((await fetch(url, { method: "POST", headers: wrongSecret.headers, body: wrongSecret.body })).status, 401);
    assert.equal((await fetch(url.replace("cs-test", "mat"), { method: "POST" })).status, 404);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("switching a source off during participant lookup prevents mutations and later replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-source-inflight-"));
  const store = new CsEventStore(join(directory, "events.json"));
  let mode: CsSourceMode = "live";
  let processed = 0;
  let releaseParticipants!: (participants: Map<string, RegisteredPerson>) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const participants = new Promise<Map<string, RegisteredPerson>>(resolve => { releaseParticipants = resolve; });
  const runtime = new CsWebhookRuntime({
    secret, port: 0, host: "127.0.0.1", intervalMs: 60_000,
    getMode: () => mode, dryRun: false, store,
    registration: { getParticipants: async () => { markStarted(); return participants; } },
    discordManager: {
      load: async () => undefined,
      handleMatchEvent: async () => { processed += 1; throw new Error("Must not execute"); }
    } as unknown as CsDiscordManager,
    report: () => undefined
  });
  try {
    await runtime.start();
    const body = Buffer.from(JSON.stringify({
      id: "inflight-source-event", type: "match.live", test: false,
      data: { sequence: 1, match: {
        id: "source-match", slug: "source-match", status: "live", game: "cs2", tournament: null,
        team1: { id: "a", players: [steamOne, steamTwo].map(steam_id64 => ({ steam_id64 })) },
        team2: { id: "b", players: ["76561198000000003", "76561198000000004"].map(steam_id64 => ({ steam_id64 })) }
      } }
    }));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
    const response = await fetch(`http://127.0.0.1:${runtime.address!.port}/webhooks/mat`, {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-at-signature": `t=${timestamp},v1=${digest}` }
    });
    assert.equal(response.status, 202);
    await started;
    mode = "off";
    releaseParticipants(new Map());
    await runtime.stop();
    assert.equal(processed, 0);
    assert.deepEqual(await store.getPending(), []);
    mode = "live";
    await runtime.start();
    await runtime.stop();
    assert.equal(processed, 0);
  } finally {
    releaseParticipants(new Map());
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabled MAT source does not query tournament APIs during receiver startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-mat-source-off-"));
  let matCalls = 0;
  const runtime = new CsWebhookRuntime({
    secret, port: 0, host: "127.0.0.1", intervalMs: 60_000,
    getMode: () => "off",
    mat: { getTournaments: async () => { matCalls += 1; throw new Error("MAT unavailable"); } } as unknown as MatClient,
    registration: { getParticipants: async () => new Map() },
    store: new CsEventStore(join(directory, "events.json"))
  });
  try {
    await runtime.start();
    assert.equal(runtime.address?.port !== undefined, true);
    assert.equal(matCalls, 0);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("signed room-start events produce aggregate dry-run plans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-webhook-runtime-"));
  const store = new CsEventStore(join(directory, "events.json"));
  const participants = new Map<string, RegisteredPerson>([
    [discordOne, { name: "private player one", firstName: "Player", steamId: steamOne }],
    [discordTwo, { name: "private player two", firstName: "Player", steamId: steamTwo }]
  ]);
  const reports: CsWebhookDryRunReport[] = [];
  let participantFetches = 0;
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
      getCsParticipants: async () => {
        participantFetches += 1;
        return participants;
      }
    },
    store,
    report: summary => reports.push(summary)
  });

  try {
    await runtime.start();
    const address = runtime.address;
    assert.ok(address);
    const sendEvent = async (eventType: string, sequence: number, matchId: number, slug: string) => {
      const body = Buffer.from(JSON.stringify({
        id: `runtime-${eventType}-${matchId}`,
        type: eventType,
        test: false,
        data: {
          sequence,
          match: {
            id: matchId,
            slug,
            status: "loaded",
            game: "cs2",
            tournament: { id: 3 },
            team1: { id: "team-one", name: "private", tag: "A", players: [{ steam_id64: steamOne }] },
            team2: { id: "team-two", name: "private", tag: "B", players: [{ steam_id64: steamTwo }] },
            connect: { password: "must-not-be-retained" }
          }
        }
      }));
      const timestamp = Math.floor(Date.now() / 1000);
      const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
      const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/mat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-at-signature": `t=${timestamp},v1=${digest}` },
        body
      });
      assert.equal(response.status, 202);
      for (let attempt = 0; attempt < 400 && (await store.getPending()).length; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.deepEqual(await store.getPending(), [], `${eventType} was not processed`);
    };
    await sendEvent("match.ready", 1, 12, "fixture-match");
    await sendEvent("match.live", 2, 12, "fixture-match");
    await sendEvent("match.map_started", 3, 12, "fixture-match");
    await sendEvent("match.map_started", 1, 13, "map-started-only-match");
    assert.deepEqual(reports.map(report => report.eventType), ["match.ready", "match.live", "match.map_started"]);
    assert.deepEqual(reports.map(report => [report.plannedRooms, report.plannedMembers]), [[2, 2], [2, 2], [2, 2]]);
    assert.equal(participantFetches, 3);
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
  const receivedEvents: Array<{ eventType: string; matchStatus: string; sequence: number; team1Players: number; team2Players: number }> = [];
  const ignoredEvents: Array<{ eventType: string; reason: string }> = [];
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
    onEventReceived: event => receivedEvents.push(event),
    onEventIgnored: (eventType, reason) => ignoredEvents.push({ eventType, reason }),
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
    assert.deepEqual(receivedEvents, [{
      eventType: "match.ready", matchStatus: "loaded", sequence: 1, team1Players: 1, team2Players: 1
    }]);
    assert.deepEqual(ignoredEvents, [{
      eventType: "match.ready",
      reason: "turnering ikke aktiv og roster 1v1 støttes ikke (krever 5v5 eller 2v2)"
    }]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing MAT discovery removes tournament IDs that are no longer active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-webhook-stale-scope-"));
  const ignoredEvents: Array<{ eventType: string; reason: string }> = [];
  const reportedEvents: string[] = [];
  let ignoredCount = 0;
  let resolveFirstIgnored!: () => void;
  let resolveSecondIgnored!: () => void;
  const firstIgnored = new Promise<void>(resolve => { resolveFirstIgnored = resolve; });
  const secondIgnored = new Promise<void>(resolve => { resolveSecondIgnored = resolve; });
  let discoveryCalls = 0;
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    mat: {
      getTournaments: async () => {
        discoveryCalls += 1;
        return discoveryCalls === 1
          ? [{ id: 3, type: "single_elimination", status: "active", teamSize: 5 }]
          : [];
      }
    } as unknown as MatClient,
    registration: { getParticipants: async () => new Map() },
    store: new CsEventStore(join(directory, "events.json")),
    onEventIgnored: (eventType, reason) => {
      ignoredEvents.push({ eventType, reason });
      ignoredCount += 1;
      if (ignoredCount === 1) resolveFirstIgnored();
      if (ignoredCount === 2) resolveSecondIgnored();
    },
    report: summary => reportedEvents.push(summary.eventType)
  });

  try {
    await runtime.start();
    const address = runtime.address;
    assert.ok(address);
    for (const [id, tournamentId, ignored] of [
      ["removed-tournament", 99, firstIgnored],
      ["stale-tournament", 3, secondIgnored]
    ] as const) {
      const request = signedReadyRequest(tournamentId, id);
      const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/mat`, {
        method: "POST",
        headers: request.headers,
        body: request.body
      });
      assert.equal(response.status, 202);
      await ignored;
    }
    assert.deepEqual(ignoredEvents, [
      { eventType: "match.ready", reason: "turnering ikke aktiv og roster 1v1 støttes ikke (krever 5v5 eller 2v2)" },
      { eventType: "match.ready", reason: "turnering ikke aktiv og roster 1v1 støttes ikke (krever 5v5 eller 2v2)" }
    ]);
    assert.deepEqual(reportedEvents, []);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown MAT tournament IDs classify complete 5v5 and 2v2 room-start rosters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-webhook-roster-fallback-"));
  const steamIds = [steamOne, steamTwo, ...Array.from({ length: 8 }, (_, index) =>
    `765611980000000${String(index + 3).padStart(2, "0")}`)];
  const participants = new Map<string, RegisteredPerson>(steamIds.map((steamId, index) => [
    String(BigInt(discordOne) + BigInt(index)),
    { name: `Private Player ${index + 1}`, firstName: `Player ${index + 1}`, steamId }
  ]));
  const reports: CsWebhookDryRunReport[] = [];
  const store = new CsEventStore(join(directory, "events.json"));
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    mat: { getTournaments: async () => [] } as unknown as MatClient,
    registration: { getParticipants: async () => participants, getCsParticipants: async () => participants },
    store,
    report: summary => reports.push(summary)
  });

  try {
    await runtime.start();
    const address = runtime.address;
    assert.ok(address);
    const sendEvent = async (input: {
      eventType: string;
      id: string;
      matchId: number;
      tournamentId?: number;
      sequence: number;
      teamSize: number;
      nullTeamIds?: boolean;
    }) => {
      const makeTeam = (number: 1 | 2) => ({
        id: input.nullTeamIds ? null : `team-${input.matchId}-${number}`,
        name: `private-team-${number}`,
        tag: `T${number}`,
        players: steamIds.slice((number - 1) * input.teamSize, number * input.teamSize)
          .map(steam_id64 => ({ steam_id64, name: "private-player" }))
      });
      const body = Buffer.from(JSON.stringify({
        id: input.id,
        type: input.eventType,
        test: false,
        data: {
          sequence: input.sequence,
          match: {
            id: input.matchId,
            slug: `fallback-${input.matchId}`,
            status: input.eventType === "match.live" ? "live" : "loaded",
            game: "cs2",
            tournament: input.tournamentId === undefined ? null : { id: input.tournamentId },
            team1: makeTeam(1),
            team2: makeTeam(2)
          }
        }
      }));
      const timestamp = Math.floor(Date.now() / 1000);
      const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
      const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/mat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-at-signature": `t=${timestamp},v1=${digest}` },
        body
      });
      assert.equal(response.status, 202);
      for (let attempt = 0; attempt < 400 && (await store.getPending()).length; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.deepEqual(await store.getPending(), []);
    };

    await sendEvent({ eventType: "match.score_updated", id: "main-score", matchId: 42, sequence: 1, teamSize: 5, nullTeamIds: true });
    await sendEvent({ eventType: "match.map_started", id: "main-map", matchId: 42, sequence: 2, teamSize: 5, nullTeamIds: true });
    await sendEvent({ eventType: "match.score_updated", id: "wingman-score", matchId: 43, sequence: 1, teamSize: 2, nullTeamIds: true });

    assert.deepEqual(reports.map(report => [report.eventType, report.tournament, report.tournamentSource, report.plannedRooms, report.plannedMembers]), [
      ["match.score_updated", "main", "roster", 2, 10],
      ["match.score_updated", "wingman", "roster", 2, 4]
    ]);
  } finally {
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
  const testEvents: string[] = [];
  const realEvents: Array<{ eventType: string; matchStatus: string; sequence: number; team1Players: number; team2Players: number }> = [];
  const rejectedEvents: string[] = [];
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    registration: { getParticipants: async () => new Map() },
    store,
    onTestEvent: eventType => testEvents.push(eventType),
    onEventReceived: event => realEvents.push(event),
    onEventRejected: (_eventType, reason) => rejectedEvents.push(reason),
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
    assert.deepEqual(testEvents, ["match.ready"]);
    assert.deepEqual(await store.getPending(), []);

    const realEvent = signedReadyRequest(3, "real-event");
    const realResponse = await fetch(`http://127.0.0.1:${address.port}/webhooks/mat`, {
      method: "POST",
      headers: realEvent.headers,
      body: realEvent.body
    });
    assert.equal(realResponse.status, 202);
    for (let attempt = 0; attempt < 200 && (await store.getPending()).length; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const duplicateResponse = await fetch(`http://127.0.0.1:${address.port}/webhooks/mat`, {
      method: "POST",
      headers: realEvent.headers,
      body: realEvent.body
    });
    assert.equal(duplicateResponse.status, 202);
    assert.deepEqual(realEvents, [{
      eventType: "match.ready", matchStatus: "loaded", sequence: 1, team1Players: 1, team2Players: 1
    }]);
    assert.deepEqual(rejectedEvents, ["duplikat event-ID; allerede kvittert tidligere"]);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("processing failures emit safe diagnostics and leave accepted events queued", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-webhook-processing-error-"));
  const store = new CsEventStore(join(directory, "events.json"));
  const failures: Array<{ eventType: string; stage: string; reason: string }> = [];
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    registration: {
      getParticipants: async () => new Map(),
      getCsParticipants: async () => { throw new Error("private name and SteamID 76561198000000001"); }
    },
    store,
    onProcessingFailed: (eventType, stage, reason) => failures.push({ eventType, stage, reason }),
    report: () => undefined
  });

  try {
    await runtime.start();
    const address = runtime.address;
    assert.ok(address);
    const steamIds = [steamOne, steamTwo, "76561198000000003", "76561198000000004", "76561198000000005"];
    const payload = {
      id: "processing-error-event",
      type: "match.ready",
      test: false,
      data: {
        sequence: 1,
        match: {
          id: 75,
          slug: "processing-error-match",
          status: "loaded",
          game: "cs2",
          tournament: null,
          team1: { id: "team-one", name: "private team", tag: null, players: steamIds.map(steam_id64 => ({ steam_id64 })) },
          team2: {
            id: "team-two", name: "private team", tag: null,
            players: ["76561198000000006", "76561198000000007", "76561198000000008", "76561198000000009", "76561198000000010"]
              .map(steam_id64 => ({ steam_id64 }))
          }
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
    for (let attempt = 0; attempt < 200 && failures.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.deepEqual(failures, [{
      eventType: "match.ready",
      stage: "event-behandling",
      reason: "Error; feildetaljer er skjult."
    }]);
    assert.equal(JSON.stringify(failures).includes("76561198000000001"), false);
    assert.equal(JSON.stringify(failures).includes("private name"), false);
    assert.equal((await store.getPending()).length, 1);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("signed match.finished with an inactive tournament ID releases the matching Wingman assignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-webhook-finished-"));
  const roomStatePath = join(directory, "rooms.json");
  const eventStore = new CsEventStore(join(directory, "events.json"));
  const manager = new CsDiscordManager({} as unknown as CsDiscordAdapter, "111111111111111180", 5_000, roomStatePath, true);
  const cleanupResults: Array<{ eventType: string; released: number | null }> = [];
  const participants = new Map<string, RegisteredPerson>([
    [discordOne, { name: "One", firstName: "One", steamId: steamOne }],
    [discordTwo, { name: "Two", firstName: "Two", steamId: steamTwo }],
    ["123456789012345680", { name: "Three", firstName: "Three", steamId: "76561198000000003" }],
    ["123456789012345681", { name: "Four", firstName: "Four", steamId: "76561198000000004" }]
  ]);
  const runtime = new CsWebhookRuntime({
    secret,
    port: 0,
    host: "127.0.0.1",
    intervalMs: 60_000,
    registration: { getParticipants: async () => new Map() },
    discordManager: manager,
    store: eventStore,
    onTerminalCleanup: (eventType, releasedAssignments) => cleanupResults.push({ eventType, released: releasedAssignments }),
    report: () => undefined
  });

  try {
    await manager.load();
    await manager.reconcileWingmanSnapshot("4", {
      id: "28",
      slug: "mm-cb98061b",
      status: "live",
      tournamentId: "4",
      round: 0,
      team1: { id: "pair-a", name: "Pair A", tag: null, steamIds: [steamOne, steamTwo] },
      team2: { id: "pair-b", name: "Pair B", tag: null, steamIds: ["76561198000000003", "76561198000000004"] }
    }, participants, true);
    assert.equal((await manager.getAssignments()).length, 2);

    await runtime.start();
    const address = runtime.address;
    assert.ok(address);
    const payload = {
      id: "finished-inactive-tournament",
      type: "match.finished",
      test: false,
      data: {
        sequence: 10,
        match: {
          id: 28,
          slug: "mm-cb98061b",
          status: "completed",
          game: "cs2",
          tournament: { id: 99, name: "Inactive tournament" },
          team1: { id: null, players: [] },
          team2: { id: null, players: [] }
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
    await runtime.stop();

    assert.deepEqual(await manager.getAssignments(), []);
    assert.deepEqual(await eventStore.getPending(), []);
    assert.deepEqual(cleanupResults, [{ eventType: "match.finished", released: 2 }]);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});