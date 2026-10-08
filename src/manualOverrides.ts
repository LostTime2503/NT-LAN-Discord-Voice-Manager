import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RegisteredPerson } from "./registrationClient.js";

export interface ManualAccessOverride {
  nickname: string;
  grantedBy: string;
  grantedAt: string;
}

export interface ManualCsLink {
  steamId: string;
  linkedBy: string;
  linkedAt: string;
}

interface PersistedManualOverrideState {
  version: 1;
  access: Record<string, ManualAccessOverride>;
  csLinks: Record<string, ManualCsLink>;
}

const discordIdPattern = /^\d{17,20}$/;
const steamId64Pattern = /^7656119\d{10}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ManualOverrideStore {
  private state: PersistedManualOverrideState = { version: 1, access: {}, csLinks: {} };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = "data/manual-access-overrides.json") {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const payload: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isRecord(payload) || payload.version !== 1 || !isRecord(payload.access) || !isRecord(payload.csLinks)) {
        throw new Error("Manual override state has invalid structure.");
      }
      for (const [discordId, override] of Object.entries(payload.access)) {
        if (!discordIdPattern.test(discordId) || !isRecord(override) || typeof override.nickname !== "string"
          || !override.nickname || typeof override.grantedBy !== "string" || typeof override.grantedAt !== "string") {
          throw new Error("Manual access override is invalid.");
        }
      }
      for (const [discordId, link] of Object.entries(payload.csLinks)) {
        if (!discordIdPattern.test(discordId) || !isRecord(link) || typeof link.steamId !== "string"
          || !steamId64Pattern.test(link.steamId) || typeof link.linkedBy !== "string" || typeof link.linkedAt !== "string") {
          throw new Error("Manual CS link is invalid.");
        }
      }
      const duplicateSteamIds = new Set<string>();
      const seenSteamIds = new Set<string>();
      for (const link of Object.values(payload.csLinks) as ManualCsLink[]) {
        if (seenSteamIds.has(link.steamId)) duplicateSteamIds.add(link.steamId);
        seenSteamIds.add(link.steamId);
      }
      if (duplicateSteamIds.size) throw new Error("Manual CS SteamID links are ambiguous.");
      this.state = {
        version: 1,
        access: payload.access as Record<string, ManualAccessOverride>,
        csLinks: payload.csLinks as Record<string, ManualCsLink>
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Manual override state could not be loaded.");
    }
    this.loaded = true;
  }

  async grantAccess(discordId: string, nickname: string, actorId: string): Promise<ManualAccessOverride> {
    await this.load();
    this.validateDiscordId(discordId);
    this.validateDiscordId(actorId);
    const normalizedNickname = nickname.normalize("NFC").trim().replace(/\s+/g, " ");
    if (!normalizedNickname || /[\p{Cc}\p{Cf}]/u.test(normalizedNickname) || [...normalizedNickname].length > 32) {
      throw new Error("Nickname must be 1-32 safe characters.");
    }
    const previousState = structuredClone(this.state);
    const override = { nickname: normalizedNickname, grantedBy: actorId, grantedAt: new Date().toISOString() };
    this.state.access[discordId] = override;
    try { await this.persist(); } catch (error) { this.state = previousState; throw error; }
    return override;
  }

  async removeAccessOverride(discordId: string): Promise<boolean> {
    await this.load();
    this.validateDiscordId(discordId);
    if (!this.state.access[discordId]) return false;
    const previousState = structuredClone(this.state);
    delete this.state.access[discordId];
    try { await this.persist(); } catch (error) { this.state = previousState; throw error; }
    return true;
  }

  async linkCsPlayer(discordId: string, steamId: string, actorId: string): Promise<ManualCsLink> {
    await this.load();
    this.validateDiscordId(discordId);
    this.validateDiscordId(actorId);
    if (!steamId64Pattern.test(steamId)) throw new Error("SteamID64 is invalid.");
    const duplicate = Object.entries(this.state.csLinks).find(([otherDiscordId, link]) =>
      otherDiscordId !== discordId && link.steamId === steamId);
    if (duplicate) throw new Error("This SteamID64 is already linked to another Discord member.");
    const previousState = structuredClone(this.state);
    const link = { steamId, linkedBy: actorId, linkedAt: new Date().toISOString() };
    this.state.csLinks[discordId] = link;
    try { await this.persist(); } catch (error) { this.state = previousState; throw error; }
    return link;
  }

  async unlinkCsPlayer(discordId: string): Promise<boolean> {
    await this.load();
    this.validateDiscordId(discordId);
    if (!this.state.csLinks[discordId]) return false;
    const previousState = structuredClone(this.state);
    delete this.state.csLinks[discordId];
    try { await this.persist(); } catch (error) { this.state = previousState; throw error; }
    return true;
  }

  async getAccessOverride(discordId: string): Promise<ManualAccessOverride | undefined> {
    await this.load();
    const override = this.state.access[discordId];
    return override ? { ...override } : undefined;
  }

  async getCsParticipants(baseParticipants: Map<string, RegisteredPerson>): Promise<Map<string, RegisteredPerson>> {
    await this.load();
    const result = new Map(baseParticipants);
    for (const [discordId, link] of Object.entries(this.state.csLinks)) {
      for (const [otherDiscordId, participant] of result) {
        if (otherDiscordId !== discordId && participant.steamId === link.steamId) result.delete(otherDiscordId);
      }
      const current = result.get(discordId);
      result.set(discordId, {
        name: current?.name ?? "CS participant",
        firstName: current?.firstName ?? "CS participant",
        steamId: link.steamId,
        manualCsLink: true
      });
    }
    return result;
  }

  private validateDiscordId(discordId: string): void {
    if (!discordIdPattern.test(discordId)) throw new Error("Discord ID is invalid.");
  }

  private persist(): Promise<void> {
    const task = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(this.state), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.writeQueue = task;
    return task;
  }
}

export const manualOverrideStore = new ManualOverrideStore();