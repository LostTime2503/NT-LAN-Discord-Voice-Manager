import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CsNotificationPreferencesStore } from "../src/csNotificationSchedules.js";
import { createCsNotificationSettingsModal } from "../src/commands/csNotificationModalCommand.js";

test("CS notification settings are one modal with separate competition times and native reminder checkbox groups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-notification-modal-"));
  try {
    const store = new CsNotificationPreferencesStore(join(directory, "preferences.json"));
    await store.load();
    await store.updateCompetition("main", { startAt: Date.now() + 60_000 });
    const modal = createCsNotificationSettingsModal("modal-test-token", store.get()).toJSON();

    assert.equal(modal.title, "CS-påminnelser");
    assert.equal(modal.components.length, 4);
    assert.equal(modal.components[0]?.label, "Hovedturnering · starttid");
    assert.equal(modal.components[1]?.label, "Hovedturnering · påminnelser");
    assert.equal(modal.components[2]?.label, "Wingman · starttid");
    assert.equal(modal.components[3]?.label, "Wingman · påminnelser");
    assert.equal(modal.components[1]?.component.type, 22);
    assert.equal(modal.components[3]?.component.type, 22);
    assert.equal(modal.components[1]?.component.options.length, 6);
    assert.deepEqual(modal.components[1]?.component.options.filter(option => option.default).map(option => option.value), ["30", "10", "0"]);
    assert.deepEqual(modal.components[3]?.component.options.filter(option => option.default).map(option => option.value), ["30", "10", "0"]);
    assert.equal(modal.components[1]?.component.options.find(option => option.value === "ping")?.default, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});