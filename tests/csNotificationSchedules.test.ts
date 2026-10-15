import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, type Client } from "discord.js";
import { test } from "node:test";
import { renderCsNotification } from "../src/messages.js";
import {
  CsNotificationPreferencesStore,
  CsNotificationScheduleStore,
  CsNotificationScheduler,
  parseOsloLocalDateTime
} from "../src/csNotificationSchedules.js";

const guildId = "123456789012345678";
const channelId = "123456789012345679";
const actorId = "123456789012345680";

test("notification preferences persist independent competition schedules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-notification-preferences-"));
  const filePath = join(directory, "preferences.json");
  try {
    const preferences = new CsNotificationPreferencesStore(filePath);
    await preferences.load();
    assert.deepEqual(preferences.get().competitions.main.reminderOffsets, [30, 10, 0]);
    assert.deepEqual(preferences.get().competitions.wingman.reminderOffsets, [30, 10, 0]);
    assert.equal(preferences.get().competitions.main.startAt, undefined);
    await preferences.updateCompetition("main", { startAt: Date.now() + 60_000, reminderOffsets: [60, 15, 0, 15] });

    const restarted = new CsNotificationPreferencesStore(filePath);
    await restarted.load();
    assert.deepEqual(restarted.get().competitions.main.reminderOffsets, [60, 15, 0]);
    assert.equal(restarted.get().competitions.wingman.startAt, undefined);
    assert.deepEqual(restarted.get().competitions.wingman.reminderOffsets, [30, 10, 0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Oslo datetime conversion handles winter, summer, and nonexistent DST times", () => {
  assert.equal(parseOsloLocalDateTime("2026-01-12 12:00"), Date.parse("2026-01-12T11:00:00.000Z"));
  assert.equal(parseOsloLocalDateTime("2026-07-12 12:00"), Date.parse("2026-07-12T10:00:00.000Z"));
  assert.equal(parseOsloLocalDateTime("17:00 12.10.2026"), Date.parse("2026-10-12T15:00:00.000Z"));
  assert.equal(parseOsloLocalDateTime("12.10.2026 17:00"), Date.parse("2026-10-12T15:00:00.000Z"));
  assert.throws(() => parseOsloLocalDateTime("2026-03-29 02:30"), /sommertid/);
  assert.throws(() => parseOsloLocalDateTime("not a time"), /17:00 12.10.2026/);
});

test("notification schedule store persists and updates schedule status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-notification-schedules-"));
  const filePath = join(directory, "schedules.json");
  try {
    const store = new CsNotificationScheduleStore(filePath);
    await store.load();
    const created = await store.create({
      competition: "main", channelId, content: "Turnering starter snart", ping: false,
      sendAt: Date.now() + 60_000, createdBy: actorId
    });
    assert.equal(created.status, "scheduled");
    assert.equal(created.id.length, 8);
    assert.equal(await store.updateStatus(created.id, "cancelled"), true);

    const restarted = new CsNotificationScheduleStore(filePath);
    await restarted.load();
    assert.equal((await restarted.list())[0]?.status, "cancelled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scheduler sends due message without broad mentions and marks it sent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-notification-scheduler-"));
  const filePath = join(directory, "schedules.json");
  const sent: Array<{ content: string; allowedMentions: { parse: string[]; roles: string[] } }> = [];
  const fakeChannel = {
    guildId,
    type: ChannelType.GuildText,
    send: async (payload: (typeof sent)[number]) => { sent.push(payload); }
  };
  const client = {
    guilds: { fetch: async (id: string) => ({
      id,
      channels: { fetch: async () => fakeChannel }
    }) }
  } as unknown as Client;
  try {
    const store = new CsNotificationScheduleStore(filePath);
    await store.load();
    const sendAt = Date.now() - 1_000;
    const schedule = await store.create({
      competition: "wingman", channelId, content: "Turneringen starter nå.",
      ping: true, sendAt, createdBy: actorId
    });
    const scheduler = new CsNotificationScheduler(client, guildId, "999999999999999999", "999999999999999998", store);
    await scheduler.runOnce();

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.content, "<@&999999999999999999> <@&999999999999999998>\nTurneringen starter nå.");
    assert.deepEqual(sent[0]?.allowedMentions, { parse: [], roles: ["999999999999999999", "999999999999999998"] });
    assert.equal((await store.list()).find(item => item.id === schedule.id)?.status, "sent");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scheduler marks stale notifications missed instead of sending old announcements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-notification-stale-"));
  const filePath = join(directory, "schedules.json");
  let sendCount = 0;
  const client = {
    guilds: { fetch: async () => ({ channels: { fetch: async () => ({ send: async () => { sendCount += 1; } }) } }) }
  } as unknown as Client;
  try {
    const store = new CsNotificationScheduleStore(filePath);
    await store.load();
    const now = Date.now();
    const schedule = await store.create({
      competition: "main", channelId, content: "Utløpt varsling", ping: false,
      sendAt: now - 20 * 60_000, createdBy: actorId
    });
    const scheduler = new CsNotificationScheduler(client, guildId, undefined, undefined, store, () => now);
    await scheduler.runOnce();
    assert.equal(sendCount, 0);
    assert.equal((await store.list()).find(item => item.id === schedule.id)?.status, "missed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CS reminders only call players to the lobby at ten minutes and start", () => {
  const early = renderCsNotification("turnering-snart", { competition: "Wingman", minutes: "60" });
  const lobbyCall = renderCsNotification("turnering-venterom", {
    competition: "Wingman", minutes: "10", lobby: `<#${channelId}>`
  });
  const start = renderCsNotification("turnering-na", { lobby: `<#${channelId}>` });
  assert.match(early, /starter om 60 minutter/);
  assert.doesNotMatch(early, /Bli med i/);
  assert.match(lobbyCall, /Bli med i <#123456789012345679> nå/);
  assert.match(start, /starter nå.*Bli med i/);
});