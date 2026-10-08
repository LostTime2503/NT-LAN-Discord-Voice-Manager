import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CsEventStore } from "../src/csEventStore.js";
import { CsWebhookRuntime, type CsWebhookDryRunReport } from "../src/csWebhookRuntime.js";
import type { RegisteredPerson } from "../src/registrationClient.js";

const secret = "synthetic-webhook-secret-with-enough-entropy";
const discordOne = "123456789012345678";
const discordTwo = "123456789012345679";
const steamOne = "76561198000000001";
const steamTwo = "76561198000000002";

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