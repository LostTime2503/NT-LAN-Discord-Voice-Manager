import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualOverrideStore } from "../src/manualOverrides.js";

const discordOne = "123456789012345678";
const discordTwo = "123456789012345679";
const steamOne = "76561198000000001";

test("manual CS links persist and cannot assign one SteamID64 to two Discord members", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-cs-links-"));
  const path = join(directory, "overrides.json");
  try {
    const store = new ManualOverrideStore(path);
    await store.load();
    await store.linkCsPlayer(discordOne, steamOne, discordTwo);
    await assert.rejects(store.linkCsPlayer(discordTwo, steamOne, discordOne), /already linked/);

    const restarted = new ManualOverrideStore(path);
    await restarted.load();
    const participants = await restarted.getCsParticipants(new Map());
    assert.deepEqual(participants.get(discordOne), {
      name: "CS participant", firstName: "CS participant", steamId: steamOne, manualCsLink: true
    });
    assert.equal(participants.has(discordTwo), false);
    assert.equal(await restarted.unlinkCsPlayer(discordOne), true);
    assert.deepEqual(await restarted.getCsParticipants(new Map()), new Map());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual CS link overrides a conflicting API Steam identity without modifying the API map", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-cs-api-"));
  try {
    const store = new ManualOverrideStore(join(directory, "overrides.json"));
    await store.load();
    await store.linkCsPlayer(discordTwo, steamOne, discordOne);
    const apiParticipants = new Map([[discordOne, { name: "API member", firstName: "API", steamId: steamOne }]]);
    const csParticipants = await store.getCsParticipants(apiParticipants);
    assert.equal(apiParticipants.has(discordOne), true);
    assert.equal(csParticipants.has(discordOne), false);
    assert.equal(csParticipants.get(discordTwo)?.steamId, steamOne);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});