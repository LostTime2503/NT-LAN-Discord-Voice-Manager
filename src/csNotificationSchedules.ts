import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ChannelType, type Client } from "discord.js";

export type CsNotificationCompetition = "main" | "wingman";
export type CsNotificationStatus = "scheduled" | "paused" | "sending" | "sent" | "missed" | "failed" | "cancelled";

export interface CsNotificationSchedule {
  id: string;
  competition: CsNotificationCompetition;
  channelId: string;
  content: string;
  ping: boolean;
  sendAt: number;
  createdBy: string;
  status: CsNotificationStatus;
}

export interface CsNotificationCompetitionPreferences {
  startAt?: number;
  reminderOffsets: number[];
  ping: boolean;
}

export interface CsNotificationPreferences {
  competitions: Record<CsNotificationCompetition, CsNotificationCompetitionPreferences>;
}

interface PersistedSchedules {
  version: 1;
  schedules: CsNotificationSchedule[];
}

const discordIdPattern = /^\d{17,20}$/;
const statuses = new Set<CsNotificationStatus>(["scheduled", "paused", "sending", "sent", "missed", "failed", "cancelled"]);
const maxLateSendMs = 15 * 60_000;
const allowedReminderOffsets = new Set([60, 30, 15, 10, 0]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchedule(value: unknown): value is CsNotificationSchedule {
  return isRecord(value) && typeof value.id === "string" && /^[A-F0-9]{8}$/.test(value.id)
    && (value.competition === "main" || value.competition === "wingman")
    && typeof value.channelId === "string" && discordIdPattern.test(value.channelId)
    && typeof value.content === "string" && value.content.trim().length > 0 && value.content.length <= 2_000
    && typeof value.ping === "boolean" && typeof value.sendAt === "number" && Number.isFinite(value.sendAt)
    && typeof value.createdBy === "string" && discordIdPattern.test(value.createdBy)
    && typeof value.status === "string" && statuses.has(value.status as CsNotificationStatus);
}

export class CsNotificationScheduleStore {
  private schedules = new Map<string, CsNotificationSchedule>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = "data/cs-notification-schedules.json") {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.schedules)
        || parsed.schedules.some(item => !isSchedule(item))
        || new Set(parsed.schedules.map(item => (item as CsNotificationSchedule).id)).size !== parsed.schedules.length) {
        throw new Error("Invalid CS notification schedule state.");
      }
      for (const item of parsed.schedules as CsNotificationSchedule[]) {
        this.schedules.set(item.id, { ...item, status: item.status === "sending" ? "missed" : item.status });
      }
      if ([...this.schedules.values()].some(item => item.status === "missed")) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CS notification schedule state could not be loaded.");
    }
    this.loaded = true;
  }

  async list(): Promise<CsNotificationSchedule[]> {
    await this.writeQueue;
    this.assertLoaded();
    return [...this.schedules.values()].map(item => ({ ...item }));
  }

  async create(input: Omit<CsNotificationSchedule, "id" | "status">): Promise<CsNotificationSchedule> {
    this.assertLoaded();
    const item: CsNotificationSchedule = { ...input, id: randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase(), status: "scheduled" };
    this.schedules.set(item.id, item);
    await this.persist();
    return { ...item };
  }

  async updateStatus(id: string, status: CsNotificationStatus): Promise<boolean> {
    this.assertLoaded();
    const item = this.schedules.get(id);
    if (!item) return false;
    this.schedules.set(id, { ...item, status });
    await this.persist();
    return true;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("CS notification schedules have not been loaded.");
  }

  private persist(): Promise<void> {
    const payload: PersistedSchedules = { version: 1, schedules: [...this.schedules.values()] };
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = task;
    return task;
  }
}

export function parseOsloLocalDateTime(value: string): number {
  const input = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(input);
  const norwegianClockFirst = /^(\d{2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(input);
  const norwegianDateFirst = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(input);
  let desired: number[];
  if (iso) {
    desired = iso.slice(1).map(Number);
  } else if (norwegianClockFirst) {
    const [, hour, minute, day, month, year] = norwegianClockFirst;
    desired = [Number(year), Number(month), Number(day), Number(hour), Number(minute)];
  } else if (norwegianDateFirst) {
    const [, day, month, year, hour, minute] = norwegianDateFirst;
    desired = [Number(year), Number(month), Number(day), Number(hour), Number(minute)];
  } else {
    throw new Error("Skriv f.eks. 17:00 12.10.2026 (Europe/Oslo).");
  }
  const [year, month, day, hour, minute] = desired;
  const targetAsUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  if (new Date(targetAsUtc).getUTCFullYear() !== year || new Date(targetAsUtc).getUTCMonth() !== month! - 1
    || new Date(targetAsUtc).getUTCDate() !== day || hour! > 23 || minute! > 59) {
    throw new Error("Dato eller klokkeslett er ugyldig.");
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
    const representedAsUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
    const adjustment = targetAsUtc - representedAsUtc;
    if (!adjustment) return candidate;
    candidate += adjustment;
  }
  throw new Error("Klokkeslettet finnes ikke i Europe/Oslo på grunn av overgang til sommertid.");
}

export class CsNotificationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private processing = false;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly automaticRoleId: string | undefined,
    private readonly manualRoleId: string | undefined,
    private readonly store: CsNotificationScheduleStore,
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
    if (this.processing) return;
    this.processing = true;
    try {
      const due = (await this.store.list()).filter(item => item.status === "scheduled" && item.sendAt <= this.now());
      for (const item of due) await this.send(item);
    } finally {
      this.processing = false;
    }
  }

  private async send(item: CsNotificationSchedule): Promise<void> {
    if (this.now() - item.sendAt > maxLateSendMs) {
      await this.store.updateStatus(item.id, "missed");
      return;
    }
    await this.store.updateStatus(item.id, "sending");
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channel = await guild.channels.fetch(item.channelId);
      if (!channel || channel.guildId !== this.guildId
        || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        await this.store.updateStatus(item.id, "failed");
        return;
      }
      const roles = item.ping ? [this.automaticRoleId, this.manualRoleId].filter((id): id is string => Boolean(id)) : [];
      if (item.ping && roles.length !== 2) {
        await this.store.updateStatus(item.id, "failed");
        return;
      }
      const roleMentions = roles.map(roleId => `<@&${roleId}>`).join(" ");
      const content = roleMentions ? `${roleMentions}\n${item.content}` : item.content;
      await channel.send({ content, allowedMentions: { parse: [], roles } });
      await this.store.updateStatus(item.id, "sent");
      console.info("CS scheduled notification sent", { competition: item.competition, ping: item.ping });
    } catch {
      await this.store.updateStatus(item.id, "failed");
      console.error("CS scheduled notification failed", { competition: item.competition });
    }
  }
}

export class CsNotificationPreferencesStore {
  private preferences: CsNotificationPreferences = {
    competitions: {
      main: { reminderOffsets: [30, 10, 0], ping: false },
      wingman: { reminderOffsets: [30, 10, 0], ping: false }
    }
  };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = "data/cs-notification-preferences.json") {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1) throw new Error("Invalid CS notification preferences.");
      const source = isRecord(parsed.preferences) ? parsed.preferences : {};
      const rawCompetitions = isRecord(source.competitions) ? source.competitions : {};
      for (const competition of ["main", "wingman"] as const) {
        const raw = isRecord(rawCompetitions[competition]) ? rawCompetitions[competition] : {};
        const reminderOffsets = Array.isArray(raw.reminderOffsets)
          ? [...new Set(raw.reminderOffsets.filter((offset): offset is number => Number.isInteger(offset) && allowedReminderOffsets.has(offset)))].sort((a, b) => b - a)
          : [30, 10, 0];
        const startAt = typeof raw.startAt === "number" && Number.isFinite(raw.startAt) ? raw.startAt : undefined;
        this.preferences.competitions[competition] = {
          ...(startAt ? { startAt } : {}),
          reminderOffsets,
          ping: raw.ping === true
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CS notification preferences could not be loaded.");
    }
    this.loaded = true;
  }

  get(): CsNotificationPreferences {
    this.assertLoaded();
    return {
      competitions: {
        main: { ...this.preferences.competitions.main, reminderOffsets: [...this.preferences.competitions.main.reminderOffsets] },
        wingman: { ...this.preferences.competitions.wingman, reminderOffsets: [...this.preferences.competitions.wingman.reminderOffsets] }
      }
    };
  }

  async updateCompetition(
    competition: CsNotificationCompetition,
    updates: { startAt?: number | null; reminderOffsets?: number[]; ping?: boolean }
  ): Promise<void> {
    this.assertLoaded();
    const current = this.preferences.competitions[competition];
    const reminderOffsets = updates.reminderOffsets === undefined
      ? current.reminderOffsets
      : [...new Set(updates.reminderOffsets.filter(offset => Number.isInteger(offset) && allowedReminderOffsets.has(offset)))].sort((a, b) => b - a);
    const startAt = updates.startAt === undefined ? current.startAt : updates.startAt ?? undefined;
    if (startAt !== undefined && (!Number.isFinite(startAt) || startAt <= Date.now())) {
      throw new Error("Competition start time must be in the future.");
    }
    this.preferences.competitions[competition] = {
      ...(startAt === undefined ? {} : { startAt }),
      reminderOffsets,
      ping: updates.ping ?? current.ping
    };
    await this.persist();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("CS notification preferences have not been loaded.");
  }

  private persist(): Promise<void> {
    const snapshot = { version: 1, preferences: this.get() };
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = task;
    return task;
  }
}