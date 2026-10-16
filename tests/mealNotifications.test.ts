import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, type Client } from "discord.js";
import { test } from "node:test";
import { MealNotificationScheduler, MealNotificationPreferencesStore, MealNotificationStore, osloMealTimestamp, parseMealEventDate } from "../src/mealNotifications.js";
import { createMealNotificationsModal } from "../src/commands/mealNotifications.js";

const guildId = "123456789012345678";
const channelId = "123456789012345679";
const roundOneRole = "123456789012345680";
const roundTwoRole = "123456789012345681";

function futureOsloDate(): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(Date.now() + 48 * 60 * 60_000).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

test("meal event date accepts the Norwegian date format", () => {
  assert.equal(parseMealEventDate("17.10.2026"), "2026-10-17");
  assert.equal(parseMealEventDate("2026-10-17"), "2026-10-17");
  assert.throws(() => parseMealEventDate("31.02.2026"), /DD.MM.YYYY/);
});

test("meal settings are one modal with event date, two times, and per-pulje reminder checkboxes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meal-modal-"));
  try {
    const preferences = new MealNotificationPreferencesStore(join(directory, "times.json"), join(directory, "reminders.json"));
    await preferences.load();
    await preferences.save({
      lastEventDate: "2026-10-17",
      times: { 1: "17:00", 2: "18:00" },
      reminders: { 1: [30, 10, 0], 2: [30, 10, 0] },
      mentionAtServing: { 1: false, 2: true }
    });
    const modal = createMealNotificationsModal("meal-test", preferences.get()).toJSON();
    assert.equal(modal.title, "Måltidsvarsler");
    assert.equal(modal.components.length, 5);
    assert.equal(modal.components[0]?.label, "Serveringsdato");
    assert.equal(modal.components[2]?.label, "Pulje 1 · påminnelser");
    assert.equal(modal.components[4]?.label, "Pulje 2 · påminnelser");
    assert.deepEqual(modal.components[2]?.component.options.filter(option => option.default).map(option => option.value), ["30", "10", "0"]);
    assert.equal(modal.components[2]?.component.options.find(option => option.value === "mentionAtServing")?.default, false);
    assert.equal(modal.components[4]?.component.options.find(option => option.value === "mentionAtServing")?.default, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("meal schedule store replaces both puljes and empty reminders disable that pulje", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meal-notifications-"));
  try {
    const store = new MealNotificationStore(join(directory, "meal-notifications.json"));
    await store.load();
    const eventDate = futureOsloDate();
    const result = await store.replaceEvent({
      guildId, channelId, eventDate,
      times: { 1: "17:00", 2: "18:00" },
      reminders: { 1: [30, 10, 0], 2: [0] },
      mentionAtServing: { 1: false, 2: true }
    });
    assert.equal(result.created, 4);
    let schedules = await store.list();
    assert.equal(schedules.length, 2);
    assert.deepEqual(schedules.find(item => item.pulje === 1)?.reminders.map(item => item.minutesBefore), [30, 10, 0]);
    assert.equal(schedules.find(item => item.pulje === 1)?.mentionRoleAtServing, false);
    assert.equal(schedules.find(item => item.pulje === 2)?.mentionRoleAtServing, true);
    assert.equal(schedules.find(item => item.pulje === 2)?.serviceTime, "18:00");

    const disabled = await store.replaceEvent({
      guildId, channelId, eventDate,
      times: { 1: "17:30", 2: "18:30" },
      reminders: { 1: [], 2: [10] }
    });
    assert.equal(disabled.created, 1);
    schedules = await store.list();
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]?.pulje, 2);
    assert.equal(schedules[0]?.serviceTime, "18:30");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("meal scheduler pings only the role for the selected pulje", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meal-notification-scheduler-"));
  const sent: Array<{ content: string; allowedMentions: { parse: string[]; roles: string[] } }> = [];
  try {
    const store = new MealNotificationStore(join(directory, "meal-notifications.json"));
    await store.load();
    const eventDate = futureOsloDate();
    await store.replaceEvent({
      guildId, channelId, eventDate,
      times: { 1: "17:00", 2: "18:00" },
      reminders: { 1: [], 2: [0] }
    });
    const schedule = (await store.list())[0]!;
    const channel = { guildId, type: ChannelType.GuildText, send: async (payload: (typeof sent)[number]) => { sent.push(payload); } };
    const client = { guilds: { fetch: async () => ({ channels: { fetch: async () => channel } }) } } as unknown as Client;
    const scheduler = new MealNotificationScheduler(
      client, guildId, channelId, roundOneRole, roundTwoRole, store,
      () => ({ reminder: "Pulje {pulje} om {minutes} min ({time})", atServing: "Pulje {pulje} serveres nå ({time})" }),
      () => Date.parse(schedule.serviceAt)
    );
    await scheduler.runOnce();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.content, `<@&${roundTwoRole}>\nPulje 2 serveres nå (18:00)`);
    assert.deepEqual(sent[0]?.allowedMentions, { parse: [], roles: [roundTwoRole] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("meal scheduler can suppress the role ping only at serving time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meal-notification-no-ping-"));
  const sent: Array<{ content: string; allowedMentions: { parse: string[]; roles: string[] } }> = [];
  try {
    const store = new MealNotificationStore(join(directory, "meal-notifications.json"));
    await store.load();
    const eventDate = futureOsloDate();
    await store.replaceEvent({
      guildId, channelId, eventDate,
      times: { 1: "17:00", 2: "18:00" },
      reminders: { 1: [0], 2: [] },
      mentionAtServing: { 1: false, 2: true }
    });
    const schedule = (await store.list())[0]!;
    const channel = { guildId, type: ChannelType.GuildText, send: async (payload: (typeof sent)[number]) => { sent.push(payload); } };
    const client = { guilds: { fetch: async () => ({ channels: { fetch: async () => channel } }) } } as unknown as Client;
    const scheduler = new MealNotificationScheduler(
      client, guildId, channelId, roundOneRole, roundTwoRole, store,
      () => ({ reminder: "Pulje {pulje} om {minutes} min ({time})", atServing: "Pulje {pulje} serveres nå ({time})" }),
      () => Date.parse(schedule.serviceAt)
    );
    await scheduler.runOnce();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.content, "Pulje 1 serveres nå (17:00)");
    assert.deepEqual(sent[0]?.allowedMentions, { parse: [], roles: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
