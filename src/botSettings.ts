import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const botFeatures = ["access", "normalVoice", "csRoles", "csVoice"] as const;
export type BotFeature = typeof botFeatures[number];
export type BotFeatureSettings = Record<BotFeature, boolean>;
export const liveFeatures = ["access", "csRoles", "csVoice"] as const;
export type LiveFeature = typeof liveFeatures[number];
export type BotLiveSettings = Record<LiveFeature, boolean>;
export type CrewLogMode = "full" | "minimal";

interface PersistedBotSettings {
  version: 1;
  features: BotFeatureSettings;
  live: BotLiveSettings;
  crewLogMode: CrewLogMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class BotSettingsStore {
  private settings: BotFeatureSettings;
  private liveSettings: BotLiveSettings;
  private crewLogMode: CrewLogMode = "full";
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = "data/bot-settings.json",
    defaults: BotFeatureSettings = { access: false, normalVoice: false, csRoles: false, csVoice: false },
    liveDefaults: BotLiveSettings = { access: false, csRoles: false, csVoice: false }
  ) {
    this.settings = { ...defaults };
    this.liveSettings = { ...liveDefaults };
  }

  async load(): Promise<BotFeatureSettings> {
    if (this.loaded) return this.getAll();
    try {
      const payload: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      const features = isRecord(payload) && isRecord(payload.features) ? payload.features : undefined;
      const live = isRecord(payload) && isRecord(payload.live) ? payload.live : undefined;
      const crewLogMode = isRecord(payload) ? payload.crewLogMode : undefined;
      if (!isRecord(payload) || payload.version !== 1 || !features || !live
        || botFeatures.some(feature => typeof features[feature] !== "boolean")
        || liveFeatures.some(feature => typeof live[feature] !== "boolean")
        || liveFeatures.some(feature => live[feature] === true && features[feature] !== true)
        || (crewLogMode !== undefined && crewLogMode !== "full" && crewLogMode !== "minimal")) {
        throw new Error("Bot settings have invalid structure.");
      }
      this.settings = Object.fromEntries(botFeatures.map(feature => [feature, features[feature]])) as BotFeatureSettings;
      this.liveSettings = Object.fromEntries(liveFeatures.map(feature => [feature, live[feature]])) as BotLiveSettings;
      this.crewLogMode = crewLogMode === "minimal" ? "minimal" : "full";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Bot settings could not be loaded.");
    }
    this.loaded = true;
    return this.getAll();
  }

  getAll(): BotFeatureSettings {
    if (!this.loaded) throw new Error("Bot settings have not been loaded.");
    return { ...this.settings };
  }

  getLive(): BotLiveSettings {
    if (!this.loaded) throw new Error("Bot settings have not been loaded.");
    return { ...this.liveSettings };
  }

  getCrewLogMode(): CrewLogMode {
    if (!this.loaded) throw new Error("Bot settings have not been loaded.");
    return this.crewLogMode;
  }

  async setCrewLogMode(mode: CrewLogMode): Promise<void> {
    await this.load();
    const previous = this.crewLogMode;
    this.crewLogMode = mode;
    try {
      await this.persist();
    } catch (error) {
      this.crewLogMode = previous;
      throw error;
    }
  }

  async set(feature: BotFeature, enabled: boolean): Promise<void> {
    await this.load();
    const previous = this.settings[feature];
    const previousLive = feature !== "normalVoice" ? this.liveSettings[feature] : false;
    this.settings[feature] = enabled;
    if (feature !== "normalVoice" && (!enabled || !previous)) this.liveSettings[feature] = false;
    try {
      await this.persist();
    } catch (error) {
      this.settings[feature] = previous;
      if (feature !== "normalVoice") this.liveSettings[feature] = previousLive;
      throw error;
    }
  }

  async setLive(feature: LiveFeature, enabled: boolean): Promise<void> {
    await this.load();
    if (enabled && !this.settings[feature]) throw new Error("Enable the feature in preview mode before confirming live mode.");
    const previous = this.liveSettings[feature];
    this.liveSettings[feature] = enabled;
    try {
      await this.persist();
    } catch (error) {
      this.liveSettings[feature] = previous;
      throw error;
    }
  }

  private persist(): Promise<void> {
    const snapshot: PersistedBotSettings = {
      version: 1,
      features: this.getAll(),
      live: this.getLive(),
      crewLogMode: this.getCrewLogMode()
    };
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