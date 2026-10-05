import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type MealPulje = 1 | 2;
export type MealReminderOffset = 0 | 10 | 30;
type MealTimes = Record<MealPulje, string>;
export type MealReminderSelections = Record<MealPulje, MealReminderOffset[]>;

const settingsPath = join(process.cwd(), "data", "meal-times.json");
const reminderSettingsPath = join(process.cwd(), "data", "meal-reminders.json");
const defaultMealTimes: MealTimes = { 1: "17:00", 2: "18:00" };
const defaultReminderSelections: MealReminderSelections = { 1: [0, 10], 2: [0, 10] };

let mealTimes: MealTimes = { ...defaultMealTimes };
let isLoaded = false;
let loadPromise: Promise<void> | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let reminderSelections: MealReminderSelections = cloneReminderSelections(defaultReminderSelections);
let lastMealPlanDate: string | null = null;
let reminderSettingsLoaded = false;
let reminderLoadPromise: Promise<void> | undefined;
let reminderWriteQueue: Promise<void> = Promise.resolve();

export async function getMealTimes(): Promise<MealTimes> {
  await loadSettings();
  return { ...mealTimes };
}

export async function getMealTime(pulje: MealPulje): Promise<string> {
  await loadSettings();
  return mealTimes[pulje];
}

export async function setMealTime(pulje: MealPulje, time: string): Promise<void> {
  const write = writeQueue.then(async () => {
    await loadSettings();
    const updatedTimes = { ...mealTimes, [pulje]: time };
    await mkdir(dirname(settingsPath), { recursive: true });
    const temporaryPath = `${settingsPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(updatedTimes, null, 2)}\n`, "utf8");
    await rename(temporaryPath, settingsPath);
    mealTimes = updatedTimes;
  });

  writeQueue = write.catch(() => undefined);
  await write;
}

export function isValidMealTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

async function loadSettings(): Promise<void> {
  if (isLoaded) {
    return;
  }

  loadPromise ??= readSettingsFile();
  await loadPromise;
}

async function readSettingsFile(): Promise<void> {
  try {
    const contents = await readFile(settingsPath, "utf8");
    const saved = JSON.parse(contents) as Partial<Record<MealPulje, unknown>>;
    mealTimes = {
      1: typeof saved[1] === "string" && isValidMealTime(saved[1]) ? saved[1] : defaultMealTimes[1],
      2: typeof saved[2] === "string" && isValidMealTime(saved[2]) ? saved[2] : defaultMealTimes[2]
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    mealTimes = { ...defaultMealTimes };
  }

  isLoaded = true;
}

export async function getMealReminderSelections(): Promise<MealReminderSelections> {
  await loadReminderSettings();
  return cloneReminderSelections(reminderSelections);
}

export async function getLastMealPlanDate(): Promise<string | null> {
  await loadReminderSettings();
  return lastMealPlanDate;
}

export async function setMealReminderSelections(
  selections: MealReminderSelections,
  eventDate: string
): Promise<void> {
  const write = reminderWriteQueue.then(async () => {
    await loadReminderSettings();
    const updatedSelections = cloneReminderSelections(selections);
    await mkdir(dirname(reminderSettingsPath), { recursive: true });
    const temporaryPath = `${reminderSettingsPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ ...updatedSelections, lastEventDate: eventDate }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, reminderSettingsPath);
    reminderSelections = updatedSelections;
    lastMealPlanDate = eventDate;
  });

  reminderWriteQueue = write.catch(() => undefined);
  await write;
}

async function loadReminderSettings(): Promise<void> {
  if (reminderSettingsLoaded) {
    return;
  }

  reminderLoadPromise ??= readReminderSettingsFile();
  await reminderLoadPromise;
}

async function readReminderSettingsFile(): Promise<void> {
  try {
    const contents = await readFile(reminderSettingsPath, "utf8");
    const saved = JSON.parse(contents) as Partial<Record<MealPulje, unknown>> & { lastEventDate?: unknown };
    reminderSelections = {
      1: parseReminderOffsets(saved[1]),
      2: parseReminderOffsets(saved[2])
    };
    lastMealPlanDate = isValidStoredDate(saved.lastEventDate) ? saved.lastEventDate : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    reminderSelections = cloneReminderSelections(defaultReminderSelections);
  lastMealPlanDate = null;
  }

  reminderSettingsLoaded = true;
}

function parseReminderOffsets(value: unknown): MealReminderOffset[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((offset): offset is MealReminderOffset =>
    offset === 0 || offset === 10 || offset === 30
  ))];
}

function cloneReminderSelections(selections: MealReminderSelections): MealReminderSelections {
  return { 1: [...selections[1]], 2: [...selections[2]] };
}

function isValidStoredDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}