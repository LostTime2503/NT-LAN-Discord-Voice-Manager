import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Client } from "discord.js";

export type MealRound = 1 | 2;
export interface MealReminder { minutesBefore: number; sent: boolean }
export interface MealNotification {
  id: string;
  guildId: string;
  channelId: string;
  pulje: MealRound;
  eventDate: string;
  serviceTime: string;
  serviceAt: string;
  reminders: MealReminder[];
}

export interface MealNotificationPreferences {
  times: Record<MealRound, string>;
  reminders: Record<MealRound, number[]>;
  lastEventDate?: string;
}

const snowflakePattern = /^\d{17,20}$/;
const allowedOffsets = new Set([60, 30, 15, 10, 0]);
const defaultTimes: Record<MealRound, string> = { 1: "17:00", 2: "18:00" };
const defaultReminders: Record<MealRound, number[]> = { 1: [30, 10, 0], 2: [30, 10, 0] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour! <= 23 && minute! <= 59;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validNotification(value: unknown): value is MealNotification {
  return isRecord(value) && typeof value.id === "string"
    && typeof value.guildId === "string" && snowflakePattern.test(value.guildId)
    && typeof value.channelId === "string" && snowflakePattern.test(value.channelId)
    && (value.pulje === 1 || value.pulje === 2)
    && validDate(value.eventDate) && validTime(value.serviceTime)
    && typeof value.serviceAt === "string" && Number.isFinite(Date.parse(value.serviceAt))
    && Array.isArray(value.reminders) && value.reminders.every(reminder => isRecord(reminder)
      && typeof reminder.minutesBefore === "number" && allowedOffsets.has(reminder.minutesBefore)
      && typeof reminder.sent === "boolean");
}

export class MealNotificationStore {
  private items: MealNotification[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = "data/meal-notifications.json") {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(data) || data.some(item => !validNotification(item))) {
        throw new Error("Meal notification data is invalid.");
      }
      this.items = data as MealNotification[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Meal notification schedules could not be loaded.");
    }
    this.loaded = true;
  }

  async list(): Promise<MealNotification[]> {
    await this.writeQueue;
    this.assertLoaded();
    return this.items.map(item => ({ ...item, reminders: item.reminders.map(reminder => ({ ...reminder })) }));
  }

  async replaceEvent(input: {
    guildId: string;
    channelId: string;
    eventDate: string;
    times: Record<MealRound, string>;
    reminders: Record<MealRound, number[]>;
  }): Promise<{ created: number; skipped: number }> {
    this.assertLoaded();
    if (!snowflakePattern.test(input.guildId) || !snowflakePattern.test(input.channelId) || !validDate(input.eventDate)
      || !validTime(input.times[1]) || !validTime(input.times[2])) throw new Error("Meal notification settings are invalid.");
    const retained = this.items.filter(item => !(item.guildId === input.guildId && item.eventDate === input.eventDate));
    const now = Date.now();
    let created = 0;
    let skipped = 0;
    for (const pulje of [1, 2] as const) {
      const uniqueOffsets = [...new Set(input.reminders[pulje].filter(offset => allowedOffsets.has(offset)))];
      if (!uniqueOffsets.length) continue;
      const serviceAt = osloMealTimestamp(input.eventDate, input.times[pulje]);
      const reminders = uniqueOffsets.map(minutesBefore => ({ minutesBefore, sent: false }));
      const futureReminders = reminders.filter(reminder => serviceAt - reminder.minutesBefore * 60_000 >= now + 60_000);
      skipped += reminders.length - futureReminders.length;
      if (!futureReminders.length) continue;
      retained.push({
        id: `${input.guildId}:${input.eventDate}:${pulje}`,
        guildId: input.guildId,
        channelId: input.channelId,
        pulje,
        eventDate: input.eventDate,
        serviceTime: input.times[pulje],
        serviceAt: new Date(serviceAt).toISOString(),
        reminders: futureReminders
      });
      created += futureReminders.length;
    }
    this.items = retained;
    await this.persist();
    return { created, skipped };
  }

  async markReminderSent(id: string, minutesBefore: number): Promise<void> {
    this.assertLoaded();
    this.items = this.items.map(item => item.id !== id ? item : {
      ...item,
      reminders: item.reminders.map(reminder => reminder.minutesBefore === minutesBefore ? { ...reminder, sent: true } : reminder)
    });
    await this.persist();
  }

  async markAllSent(id: string): Promise<void> {
    this.assertLoaded();
    this.items = this.items.map(item => item.id !== id ? item : {
      ...item, reminders: item.reminders.map(reminder => ({ ...reminder, sent: true }))
    });
    await this.persist();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Meal notification schedules have not been loaded.");
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.items);
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, snapshot, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = task;
    return task;
  }
}

export function osloMealTimestamp(eventDate: string, time: string): number {
  if (!validDate(eventDate) || !validTime(time)) throw new Error("Use a valid event date and HH:mm meal time.");
  const [year, month, day] = eventDate.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const targetUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let candidate = targetUtc;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
    const representedUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
    const adjustment = targetUtc - representedUtc;
    if (!adjustment) return candidate;
    candidate += adjustment;
  }
  throw new Error("Meal time does not exist in Europe/Oslo due to the daylight-saving transition.");
}

export function parseMealEventDate(value: string): string {
  const input = value.trim();
  const date = /^([0-3]?\d)\.([01]?\d)\.(\d{4})$/.exec(input);
  const normalized = date ? `${date[3]}-${date[2]!.padStart(2, "0")}-${date[1]!.padStart(2, "0")}` : input;
  if (!validDate(normalized)) throw new Error("Skriv dato som DD.MM.YYYY, f.eks. 17.10.2026.");
  return normalized;
}

export class MealNotificationPreferencesStore {
  private preferences: MealNotificationPreferences = {
    times: { ...defaultTimes },
    reminders: { 1: [...defaultReminders[1]], 2: [...defaultReminders[2]] }
  };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastEventDate: string | undefined;

  constructor(
    private readonly timesPath = "data/meal-times.json",
    private readonly remindersPath = "data/meal-reminders.json"
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const rawTimes: unknown = JSON.parse(await readFile(this.timesPath, "utf8"));
      if (isRecord(rawTimes) && validTime(rawTimes["1"]) && validTime(rawTimes["2"])) {
        this.preferences.times = { 1: rawTimes["1"], 2: rawTimes["2"] };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Meal times could not be loaded.");
    }
    try {
      const rawReminders: unknown = JSON.parse(await readFile(this.remindersPath, "utf8"));
      if (isRecord(rawReminders)) {
        for (const pulje of [1, 2] as const) {
          const values = rawReminders[String(pulje)];
          if (Array.isArray(values)) this.preferences.reminders[pulje] = [...new Set(values.filter((value): value is number =>
            typeof value === "number" && allowedOffsets.has(value)))].sort((a, b) => b - a);
        }
        if (typeof rawReminders.lastEventDate === "string" && validDate(rawReminders.lastEventDate)) {
          this.lastEventDate = rawReminders.lastEventDate;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Meal reminder settings could not be loaded.");
    }
    this.loaded = true;
  }

  get(): MealNotificationPreferences {
    this.assertLoaded();
    return {
      ...(this.lastEventDate ? { lastEventDate: this.lastEventDate } : {}),
      times: { ...this.preferences.times },
      reminders: { 1: [...this.preferences.reminders[1]], 2: [...this.preferences.reminders[2]] }
    };
  }

  async save(input: MealNotificationPreferences): Promise<void> {
    this.assertLoaded();
    if (!validTime(input.times[1]) || !validTime(input.times[2])
      || (input.lastEventDate !== undefined && !validDate(input.lastEventDate))) {
      throw new Error("Meal notification preferences are invalid.");
    }
    this.preferences = {
      ...(input.lastEventDate ? { lastEventDate: input.lastEventDate } : {}),
      times: { ...input.times },
      reminders: {
        1: [...new Set(input.reminders[1].filter(offset => allowedOffsets.has(offset)))].sort((a, b) => b - a),
        2: [...new Set(input.reminders[2].filter(offset => allowedOffsets.has(offset)))].sort((a, b) => b - a)
      }
    };
    this.lastEventDate = input.lastEventDate;
    const timesSnapshot = JSON.stringify({ "1": this.preferences.times[1], "2": this.preferences.times[2] });
    const remindersSnapshot = JSON.stringify({
      "1": this.preferences.reminders[1], "2": this.preferences.reminders[2],
      ...(this.lastEventDate ? { lastEventDate: this.lastEventDate } : {})
    });
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.timesPath), { recursive: true });
      await writeFile(`${this.timesPath}.tmp`, timesSnapshot, { mode: 0o600 });
      await rename(`${this.timesPath}.tmp`, this.timesPath);
      await writeFile(`${this.remindersPath}.tmp`, remindersSnapshot, { mode: 0o600 });
      await rename(`${this.remindersPath}.tmp`, this.remindersPath);
    });
    this.writeQueue = task;
    await task;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Meal notification preferences have not been loaded.");
  }
}

export interface MealMessageTemplates {
  reminder: string;
  atServing: string;
}

export class MealNotificationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly mealTextChannelId: string,
    private readonly roundOneRoleId: string,
    private readonly roundTwoRoleId: string,
    private readonly store: MealNotificationStore,
    private readonly getTemplates: () => MealMessageTemplates,
    private readonly now: () => number = Date.now
  ) {}

  async start(): Promise<void> {
    await this.store.load();
    await this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const schedule of await this.store.list()) {
        for (const reminder of schedule.reminders.filter(item => !item.sent)) {
          const sendAt = Date.parse(schedule.serviceAt) - reminder.minutesBefore * 60_000;
          const now = this.now();
          if (now < sendAt) continue;
          if (now - sendAt > 15 * 60_000) {
            await this.store.markReminderSent(schedule.id, reminder.minutesBefore);
            continue;
          }
          await this.sendReminder(schedule, reminder.minutesBefore);
          await this.store.markReminderSent(schedule.id, reminder.minutesBefore);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async sendReminder(schedule: MealNotification, minutesBefore: number): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channel = await guild.channels.fetch(this.mealTextChannelId);
      if (!channel || channel.guildId !== this.guildId || !("send" in channel)) return;
      const roleId = schedule.pulje === 1 ? this.roundOneRoleId : this.roundTwoRoleId;
      const templates = this.getTemplates();
      const template = minutesBefore === 0 ? templates.atServing : templates.reminder;
      const message = template
        .replace(/\{pulje\}/g, String(schedule.pulje))
        .replace(/\{time\}/g, schedule.serviceTime)
        .replace(/\{minutes\}/g, String(minutesBefore));
      await channel.send({ content: `<@&${roleId}>\n${message}`, allowedMentions: { parse: [], roles: [roleId] } });
      console.info("Meal reminder sent", { pulje: schedule.pulje, minutesBefore });
    } catch {
      console.error("Meal reminder send failed", { pulje: schedule.pulje });
    }
  }
}
