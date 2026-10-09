import { BotSettingsStore, type BotFeature, type BotFeatureSettings, type BotLiveSettings, type LiveFeature } from "./botSettings.js";

export interface BotSettingsApplyHandler {
  (feature: BotFeature, enabled: boolean, live: boolean): Promise<void>;
}

export interface BotSettingsResult {
  settings: BotFeatureSettings;
  live: BotLiveSettings;
  previewRequired: boolean;
}

export class BotSettingsController {
  constructor(private readonly store: BotSettingsStore, private readonly apply: BotSettingsApplyHandler) {}

  async load(): Promise<BotFeatureSettings> {
    return this.store.load();
  }

  getSettings(): BotFeatureSettings {
    return this.store.getAll();
  }

  getLiveSettings(): BotLiveSettings {
    return this.store.getLive();
  }

  async setFeature(feature: BotFeature, enabled: boolean, confirmLive = false): Promise<BotSettingsResult> {
    const before = this.store.getAll()[feature];
    const wasLive = feature !== "normalVoice" && this.store.getLive()[feature as LiveFeature];
    if (feature === "normalVoice" && confirmLive) throw new Error("Normal voice does not use live confirmation.");

    if (!enabled) {
      await this.store.set(feature, false);
      try {
        await this.apply(feature, false, false);
      } catch (error) {
        await this.store.set(feature, before);
        if (feature !== "normalVoice" && wasLive) await this.store.setLive(feature as LiveFeature, true);
        await this.apply(feature, before, wasLive).catch(() => undefined);
        throw error;
      }
    } else if (!before) {
      await this.store.set(feature, true);
      try {
        await this.apply(feature, true, false);
      } catch (error) {
        await this.store.set(feature, false);
        await this.apply(feature, false, false).catch(() => undefined);
        throw error;
      }
    } else if (confirmLive && feature !== "normalVoice" && !wasLive) {
      await this.store.setLive(feature as LiveFeature, true);
      try {
        await this.apply(feature, true, true);
      } catch (error) {
        await this.store.setLive(feature as LiveFeature, false);
        await this.apply(feature, true, false).catch(() => undefined);
        throw error;
      }
    }

    return {
      settings: this.store.getAll(),
      live: this.store.getLive(),
      previewRequired: enabled && feature !== "normalVoice" && !this.store.getLive()[feature as LiveFeature]
    };
  }
}

let activeController: BotSettingsController | undefined;

export function configureBotSettingsController(controller: BotSettingsController): void {
  activeController = controller;
}

export function getBotSettingsController(): BotSettingsController | undefined {
  return activeController;
}