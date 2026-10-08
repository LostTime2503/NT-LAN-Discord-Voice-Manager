import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CsEventStore } from "../src/csEventStore.js";
import type { MatWebhookEvent } from "../src/csWebhookServer.js";

function event(id: string, sequence: number, matchId = "match-1"): MatWebhookEvent {
  return {
    id,
    type: "match.ready",
    test: false,
    sequence,
    match: {
      id: matchId,
      slug: matchId,
      status: "loaded",
      tournamentId: "tournament-1",
      team1: null,
      team2: null
    }
  };
}

test("event store deduplicates IDs and rejects stale sequence per match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-event-store-"));
  const path = join(directory, "events.json");
  try {
    const store = new CsEventStore(path);
    await store.load();
    assert.equal(await store.accept(event("event-4", 4)), "accepted");
    assert.equal(await store.accept(event("event-4", 4)), "duplicate");
    assert.equal(await store.accept(event("event-3", 3)), "stale");
    assert.equal(await store.accept(event("other-match-event-1", 1, "match-2")), "accepted");
    assert.deepEqual((await store.getPending()).map(item => item.id), ["event-4", "other-match-event-1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending events survive restart and are removed only after processing succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-event-store-"));
  const path = join(directory, "events.json");
  try {
    const first = new CsEventStore(path);
    await first.load();
    await first.accept(event("event-1", 1));

    const restarted = new CsEventStore(path);
    await restarted.load();
    assert.deepEqual((await restarted.getPending()).map(item => item.id), ["event-1"]);
    assert.equal(await restarted.accept(event("event-1", 1)), "duplicate");
    await restarted.markProcessed("event-1");
    assert.deepEqual(await restarted.getPending(), []);

    const afterProcessing = new CsEventStore(path);
    await afterProcessing.load();
    assert.deepEqual(await afterProcessing.getPending(), []);
    assert.equal(await afterProcessing.accept(event("event-1", 1)), "duplicate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});