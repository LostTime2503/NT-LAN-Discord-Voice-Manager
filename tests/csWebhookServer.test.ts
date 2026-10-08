import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createMatWebhookReceiver, type MatWebhookEvent } from "../src/csWebhookServer.js";

const secret = "synthetic-webhook-secret-with-enough-entropy";
const now = Date.parse("2026-10-07T12:00:00Z");
const fixture = {
  id: "event-1",
  type: "match.ready",
  created_at: "2026-10-07T12:00:00.000Z",
  api_version: "1",
  test: false,
  data: {
    sequence: 4,
    match: {
      id: 41,
      slug: "round-1-match-1",
      status: "loaded",
      game: "cs2",
      tournament: { id: 3, name: "sample" },
      team1: { id: "team-a", name: "private team name", tag: "A", players: [{ steam_id64: "76561198000000001", name: "private player" }] },
      team2: { id: "team-b", name: "private team name", tag: "B", players: [{ steam_id64: "76561198000000002", name: "private player" }] },
      connect: { password: "never-store-or-log" }
    }
  }
};

function signedHeaders(body: Buffer, timestamp = Math.floor(now / 1000)): Record<string, string> {
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  return { "content-type": "application/json", "x-at-signature": `t=${timestamp},v1=${digest}` };
}

async function withReceiver(
  onEvent: (event: MatWebhookEvent) => void | Promise<void>,
  run: (url: string) => Promise<void>,
  maxBodyBytes?: number
): Promise<void> {
  const receiver = createMatWebhookReceiver({ secret, now: () => now, onEvent, maxBodyBytes });
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(0, "127.0.0.1", resolve);
  });
  const address = receiver.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
  }
}

test("valid webhook verifies raw-body signature and strips connect credentials and player names", async () => {
  const received: MatWebhookEvent[] = [];
  await withReceiver(event => { received.push(event); }, async url => {
    const body = Buffer.from(JSON.stringify(fixture));
    const response = await fetch(`${url}/webhooks/mat`, { method: "POST", headers: signedHeaders(body), body });
    assert.equal(response.status, 202);
  });
  assert.deepEqual(received, [{
    id: "event-1",
    type: "match.ready",
    test: false,
    sequence: 4,
    match: {
      id: "41",
      slug: "round-1-match-1",
      status: "loaded",
      tournamentId: "3",
      team1: { id: "team-a", name: "private team name", tag: "A", steamIds: ["76561198000000001"] },
      team2: { id: "team-b", name: "private team name", tag: "B", steamIds: ["76561198000000002"] }
    }
  }]);
  assert.equal(JSON.stringify(received).includes("never-store-or-log"), false);
  assert.equal(JSON.stringify(received).includes("private player"), false);
});

test("invalid signature and stale timestamp are rejected without invoking the handler", async () => {
  let calls = 0;
  await withReceiver(() => { calls += 1; }, async url => {
    const body = Buffer.from(JSON.stringify(fixture));
    const invalid = await fetch(`${url}/webhooks/mat`, {
      method: "POST",
      headers: { ...signedHeaders(body), "x-at-signature": `t=${Math.floor(now / 1000)},v1=${"0".repeat(64)}` },
      body
    });
    const stale = await fetch(`${url}/webhooks/mat`, {
      method: "POST",
      headers: signedHeaders(body, Math.floor(now / 1000) - 600),
      body
    });
    assert.equal(invalid.status, 401);
    assert.equal(stale.status, 401);
  });
  assert.equal(calls, 0);
});

test("test events are acknowledged but never passed to the business handler", async () => {
  let calls = 0;
  await withReceiver(() => { calls += 1; }, async url => {
    const body = Buffer.from(JSON.stringify({ ...fixture, test: true }));
    const response = await fetch(`${url}/webhooks/mat`, { method: "POST", headers: signedHeaders(body), body });
    assert.equal(response.status, 202);
  });
  assert.equal(calls, 0);
});

test("score and map updates are acknowledged without entering the voice event queue", async () => {
  let calls = 0;
  await withReceiver(() => { calls += 1; }, async url => {
    const payload = { test: false, type: "match.score_updated" };
    const body = Buffer.from(JSON.stringify(payload));
    const response = await fetch(`${url}/webhooks/mat`, { method: "POST", headers: signedHeaders(body), body });
    assert.equal(response.status, 202);
  });
  assert.equal(calls, 0);
});

test("oversized, malformed, and wrong-method requests fail closed", async () => {
  await withReceiver(() => undefined, async url => {
    const oversizedBody = Buffer.from(JSON.stringify(fixture));
    const oversized = await fetch(`${url}/webhooks/mat`, {
      method: "POST", headers: signedHeaders(oversizedBody), body: oversizedBody
    });
    const wrongMethod = await fetch(`${url}/webhooks/mat`);
    const badJson = Buffer.from("{");
    const malformed = await fetch(`${url}/webhooks/mat`, {
      method: "POST", headers: signedHeaders(badJson), body: badJson
    });
    assert.equal(oversized.status, 413);
    assert.equal(wrongMethod.status, 405);
    assert.equal(malformed.status, 400);
  }, 32);
});