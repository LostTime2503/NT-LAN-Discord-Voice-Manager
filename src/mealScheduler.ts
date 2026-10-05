import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ChannelType, type Client, type TextChannel } from "discord.js";
import { isValidMealTime, type MealPulje } from "./mealSettings.js";

const timeZone = "Europe/Oslo";
const lateDeliveryToleranceMs = 5 * 60 * 1000;
const schedulerIntervalMs = 10 * 1000;
const schedulesPath = join(process.cwd(), "data", "meal-notifications.json");

export interface MealSchedule {
  id: string;
  guildId: string;
  channelId: string;
  pulje: MealPulje;
  eventDate: string;
  serviceTime: string;
  serviceAt: string;
  reminders: ScheduledMealReminder[];
}

interface ScheduledMealReminder {
  minutesBefore: 0 | 10 | 30;
  sent: boolean;
}

export interface PlannedMealGroup {
  pulje: MealPulje;
  serviceTime: string;
  reminderOffsets: Array<0 | 10 | 30>;
}

let schedules: MealSchedule[] = [];
let isLoaded = false;
let loadPromise: Promise<void> | undefined;
let updateQueue: Promise<void> = Promise.resolve();
let isProcessing = false;
let schedulerStarted = false;

export function getCurrentOsloDate(now = new Date()): string {
  const parts = getZonedDateParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isValidEventDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

export async function scheduleMealPlan(
  guildId: string,
  channelId: string,
  eventDate: string,
  plannedGroups: PlannedMealGroup[]
): Promise<void> {
  if (!isValidEventDate(eventDate)) {
    throw new Error("INVALID_EVENT_DATE");
  }

  const now = Date.now();
  const schedulesToSave = plannedGroups.flatMap((group) => {
    if (!isValidMealTime(group.serviceTime)) {
      throw new Error("INVALID_MEAL_TIME");
    }
    const serviceAt = osloDateTimeToUtc(eventDate, group.serviceTime);
    if (!serviceAt) {
      throw new Error("INVALID_OSLO_DATETIME");
    }
    if (group.reminderOffsets.length > 0 && serviceAt.getTime() <= now) {
      throw new Error("SERVICE_TIME_NOT_IN_FUTURE");
    }

    if (group.reminderOffsets.length === 0) {
      return [];
    }

    const reminderOffsets = [...new Set(group.reminderOffsets)];
    if (reminderOffsets.some((offset) => ![0, 10, 30].includes(offset))) {
      throw new Error("INVALID_REMINDER_OFFSET");
    }

    return [{
      id: `${guildId}:${eventDate}:${group.pulje}`,
      guildId,
      channelId,
      pulje: group.pulje,
      eventDate,
      serviceTime: group.serviceTime,
      serviceAt: serviceAt.toISOString(),
      reminders: reminderOffsets.map((minutesBefore) => ({ minutesBefore, sent: false }))
    }];
  });

  await updateSchedules(() => {
    schedules = schedules.filter((existing) => existing.guildId !== guildId || existing.eventDate !== eventDate);
    schedules.push(...schedulesToSave);
    return true;
  });
}

export async function getMealSchedules(guildId: string, eventDate?: string): Promise<MealSchedule[]> {
  let result: MealSchedule[] = [];
  await updateSchedules(() => {
    result = schedules
      .filter((schedule) => schedule.guildId === guildId && (!eventDate || schedule.eventDate === eventDate))
      .map((schedule) => ({
        ...schedule,
        reminders: schedule.reminders.map((reminder) => ({ ...reminder }))
      }));
    return false;
  });
  return result;
}

export async function cancelMealSchedules(guildId: string, eventDate: string, pulje?: MealPulje): Promise<number> {
  let cancelledCount = 0;
  await updateSchedules(() => {
    const retainedSchedules = schedules.filter((schedule) => {
      const shouldCancel = schedule.guildId === guildId
        && schedule.eventDate === eventDate
        && (pulje === undefined || schedule.pulje === pulje);
      if (shouldCancel) {
        cancelledCount += 1;
      }
      return !shouldCancel;
    });

    if (cancelledCount > 0) {
      schedules = retainedSchedules;
    }
    return cancelledCount > 0;
  });
  return cancelledCount;
}

export async function startMealNotificationScheduler(client: Client): Promise<void> {
  if (schedulerStarted) {
    return;
  }

  await loadSchedules();
  schedulerStarted = true;
  runSchedulerTick(client);
  const timer = setInterval(() => {
    runSchedulerTick(client);
  }, schedulerIntervalMs);
  timer.unref();
}

function runSchedulerTick(client: Client): void {
  void processDueSchedules(client).catch((error) => {
    console.error("Failed to process scheduled meal notifications", error);
  });
}

async function processDueSchedules(client: Client): Promise<void> {
  if (isProcessing) {
    return;
  }

  isProcessing = true;
  try {
    await updateSchedules(async () => {
      const now = Date.now();
      let changed = false;

      for (const schedule of schedules) {
        const serviceAt = new Date(schedule.serviceAt).getTime();

        for (const reminder of schedule.reminders) {
          if (reminder.sent) {
            continue;
          }

          const dueAt = serviceAt - reminder.minutesBefore * 60_000;
          if (now < dueAt) {
            continue;
          }

          const isStartNotice = reminder.minutesBefore === 0;
          if (isStartNotice && now - serviceAt > lateDeliveryToleranceMs) {
            reminder.sent = true;
            changed = true;
            continue;
          }

          if (!isStartNotice && (now >= serviceAt || now - dueAt > lateDeliveryToleranceMs)) {
            reminder.sent = true;
            changed = true;
            continue;
          }

          const notice = isStartNotice
            ? "Serveringen starter nå. Maten er klar."
            : `Serveringen starter om ${Math.max(1, Math.ceil((serviceAt - now) / 60_000))} minutter (kl. ${schedule.serviceTime}).`;
          try {
            await sendNotice(client, schedule, notice);
            reminder.sent = true;
            changed = true;
          } catch (error) {
            console.error(`Failed to send reminder for meal schedule ${schedule.id}`, error);
          }
        }
      }

      const remainingSchedules = schedules.filter((schedule) => schedule.reminders.some((reminder) => !reminder.sent));
      if (remainingSchedules.length !== schedules.length) {
        schedules = remainingSchedules;
        changed = true;
      }

      return changed;
    });
  } finally {
    isProcessing = false;
  }
}

async function sendNotice(client: Client, schedule: MealSchedule, notice: string): Promise<void> {
  const guild = await client.guilds.fetch(schedule.guildId);
  const channel = await guild.channels.fetch(schedule.channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`Announcement channel ${schedule.channelId} is unavailable or is not a text channel.`);
  }

  await guild.roles.fetch();
  const roleName = `Matpulje ${schedule.pulje}`;
  const role = guild.roles.cache.find((candidate) => candidate.name === roleName)
    ?? await guild.roles.create({ name: roleName, reason: "Create meal group notification role" });

  await (channel as TextChannel).send({
    content: `<@&${role.id}> Matpulje ${schedule.pulje}: ${notice}`,
    allowedMentions: { roles: [role.id] }
  });
}

async function updateSchedules(update: () => boolean | Promise<boolean>): Promise<void> {
  const operation = updateQueue.then(async () => {
    await loadSchedules();
    if (await update()) {
      await saveSchedules();
    }
  });

  updateQueue = operation.catch(() => undefined);
  await operation;
}

async function loadSchedules(): Promise<void> {
  if (isLoaded) {
    return;
  }

  loadPromise ??= readSchedulesFile();
  await loadPromise;
}

async function readSchedulesFile(): Promise<void> {
  try {
    const contents = await readFile(schedulesPath, "utf8");
    const saved = JSON.parse(contents) as unknown;
    schedules = Array.isArray(saved) ? saved.filter(isMealSchedule) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    schedules = [];
  }

  isLoaded = true;
}

function isMealSchedule(value: unknown): value is MealSchedule {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const schedule = value as Partial<MealSchedule> & { reminderSent?: unknown; serviceSent?: unknown };
  if (!Array.isArray(schedule.reminders)) {
    if (typeof schedule.reminderSent !== "boolean" || typeof schedule.serviceSent !== "boolean") {
      return false;
    }
    schedule.reminders = [
      { minutesBefore: 10, sent: schedule.reminderSent },
      { minutesBefore: 0, sent: schedule.serviceSent }
    ];
  }

  return typeof schedule.id === "string"
    && typeof schedule.guildId === "string"
    && typeof schedule.channelId === "string"
    && (schedule.pulje === 1 || schedule.pulje === 2)
    && typeof schedule.eventDate === "string"
    && typeof schedule.serviceTime === "string"
    && typeof schedule.serviceAt === "string"
    && schedule.reminders.every((reminder) =>
      typeof reminder === "object"
      && reminder !== null
      && [0, 10, 30].includes(reminder.minutesBefore)
      && typeof reminder.sent === "boolean"
    );
}

async function saveSchedules(): Promise<void> {
  await mkdir(dirname(schedulesPath), { recursive: true });
  const temporaryPath = `${schedulesPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(schedules, null, 2)}\n`, "utf8");
  await rename(temporaryPath, schedulesPath);
}

function osloDateTimeToUtc(eventDate: string, eventTime: string): Date | null {
  if (!isValidEventDate(eventDate) || !/^\d{2}:\d{2}$/.test(eventTime)) {
    return null;
  }

  const [year, month, day] = eventDate.split("-").map(Number);
  const [hour, minute] = eventTime.split(":").map(Number);
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = desiredAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getZonedDateParts(new Date(timestamp));
    const representedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const offset = representedAsUtc - timestamp;
    const adjustedTimestamp = desiredAsUtc - offset;
    if (adjustedTimestamp === timestamp) {
      break;
    }
    timestamp = adjustedTimestamp;
  }

  const result = new Date(timestamp);
  const resultParts = getZonedDateParts(result);
  if (`${resultParts.year}-${resultParts.month}-${resultParts.day}` !== eventDate
    || `${resultParts.hour}:${resultParts.minute}` !== eventTime) {
    return null;
  }

  return result;
}

function getZonedDateParts(value: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(value).map((part) => [part.type, part.value])
  );
}

function formatOsloTime(value: Date): string {
  return new Intl.DateTimeFormat("nb-NO", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(value);
}