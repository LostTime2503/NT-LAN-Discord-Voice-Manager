import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotSettingsStore } from "../src/botSettings.js";
import { BotSettingsController } from "../src/botSettingsController.js";

test("bot feature settings persist across store instances and preserve other toggles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bot-settings-"));
  const path = join(directory, "settings.json");
  try {
    const first = new BotSettingsStore(path, { access: true, normalVoice: true, csRoles: false, csVoice: false },
      { access: true, csRoles: false, csVoice: false });
    assert.deepEqual(await first.load(), { access: true, normalVoice: true, csRoles: false, csVoice: false });
    assert.deepEqual(first.getLive(), { access: true, csRoles: false, csVoice: false });
    await first.set("csRoles", true);
    assert.deepEqual(first.getLive(), { access: true, csRoles: false, csVoice: false });
    await first.setLive("csRoles", true);
    const restarted = new BotSettingsStore(path, { access: false, normalVoice: false, csRoles: false, csVoice: false });
    assert.deepEqual(await restarted.load(), { access: true, normalVoice: true, csRoles: true, csVoice: false });
    assert.deepEqual(restarted.getLive(), { access: true, csRoles: true, csVoice: false });
    const persisted = JSON.parse(await readFile(path, "utf8")) as { version: number };
    assert.equal(persisted.version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid persisted feature settings fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bot-settings-invalid-"));
  const path = join(directory, "settings.json");
  try {
    await (await import("node:fs/promises")).writeFile(path, JSON.stringify({ version: 1, features: { access: "yes" }, live: {} }));
    const store = new BotSettingsStore(path);
    await assert.rejects(store.load(), /could not be loaded/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabling and re-enabling a live feature resets it to preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bot-settings-safe-toggle-"));
  const store = new BotSettingsStore(join(directory, "settings.json"),
    { access: false, normalVoice: false, csRoles: false, csVoice: false });
  try {
    await store.load();
    await store.set("csVoice", true);
    assert.equal(store.getLive().csVoice, false);
    await store.setLive("csVoice", true);
    await store.set("csVoice", false);
    await store.set("csVoice", true);
    assert.equal(store.getLive().csVoice, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings controller requires a second confirmation before live changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bot-settings-controller-"));
  const store = new BotSettingsStore(join(directory, "settings.json"),
    { access: false, normalVoice: false, csRoles: false, csVoice: false });
  const applied: Array<{ feature: string; enabled: boolean; live: boolean }> = [];
  const controller = new BotSettingsController(store, async (feature, enabled, live) => {
    applied.push({ feature, enabled, live });
  });
  try {
    await controller.load();
    const preview = await controller.setFeature("csVoice", true, true);
    assert.equal(preview.previewRequired, true);
    assert.deepEqual(applied, [{ feature: "csVoice", enabled: true, live: false }]);
    const live = await controller.setFeature("csVoice", true, true);
    assert.equal(live.previewRequired, false);
    assert.deepEqual(applied[1], { feature: "csVoice", enabled: true, live: true });
    const disabled = await controller.setFeature("csVoice", false);
    assert.equal(disabled.live.csVoice, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed runtime transition restores persisted settings and previous runtime mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bot-settings-rollback-"));
  const store = new BotSettingsStore(join(directory, "settings.json"),
    { access: false, normalVoice: false, csRoles: false, csVoice: false });
  let rejectNext = false;
  const applied: Array<{ enabled: boolean; live: boolean }> = [];
  const controller = new BotSettingsController(store, async (_feature, enabled, live) => {
    applied.push({ enabled, live });
    if (rejectNext) { rejectNext = false; throw new Error("synthetic transition failure"); }
  });
  try {
    await controller.load();
    rejectNext = true;
    await assert.rejects(controller.setFeature("normalVoice", true), /synthetic transition failure/);
    assert.equal(controller.getSettings().normalVoice, false);
    assert.deepEqual(applied, [{ enabled: true, live: false }, { enabled: false, live: false }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});