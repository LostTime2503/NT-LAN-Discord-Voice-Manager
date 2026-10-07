import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FamilyLink {
  parentDiscordId: string;
  childName: string;
  childDiscordId: string;
  linkedAt: number;
}

export interface FamilyRequest {
  id: string;
  parentDiscordId: string;
  childDiscordId: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingFamilyInvite {
  id: string;
  parentDiscordId: string;
  childName: string;
  discordUsername: string;
  createdAt: number;
  expiresAt: number;
}

export interface FamilyClaim {
  id: string;
  parentDiscordId: string;
  childName: string;
  childDiscordId: string;
  createdAt: number;
  expiresAt: number;
}

interface FamilyData {
  version: 1;
  links: FamilyLink[];
  requests: FamilyRequest[];
  invites: PendingFamilyInvite[];
  claims: FamilyClaim[];
}

const EMPTY_DATA: FamilyData = { version: 1, links: [], requests: [], invites: [], claims: [] };
const FAMILY_REQUEST_TTL_MS = 48 * 60 * 60 * 1000;
const FAMILY_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeChildName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("nb");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

function validateData(value: unknown): FamilyData {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1
    || !("links" in value) || !Array.isArray(value.links)
    || !("requests" in value) || !Array.isArray(value.requests)
    || !("invites" in value) || !Array.isArray(value.invites)
    || !("claims" in value) || !Array.isArray(value.claims)) {
    throw new Error("Family access data has an unsupported format.");
  }
  const data = value as FamilyData;
  if (data.links.some((link) => !validId(link.parentDiscordId) || !validId(link.childDiscordId)
    || typeof link.childName !== "string" || !Number.isFinite(link.linkedAt))
    || data.requests.some((request) => typeof request.id !== "string" || !validId(request.parentDiscordId)
      || !validId(request.childDiscordId) || !Number.isFinite(request.createdAt) || !Number.isFinite(request.expiresAt))
    || data.invites.some((invite) => typeof invite.id !== "string" || !validId(invite.parentDiscordId)
      || typeof invite.childName !== "string" || typeof invite.discordUsername !== "string"
      || !Number.isFinite(invite.createdAt) || !Number.isFinite(invite.expiresAt))
    || data.claims.some((claim) => typeof claim.id !== "string" || !validId(claim.parentDiscordId)
      || !validId(claim.childDiscordId) || typeof claim.childName !== "string"
      || !Number.isFinite(claim.createdAt) || !Number.isFinite(claim.expiresAt))) {
    throw new Error("Family access data contains an invalid record.");
  }
  return data;
}

export class FamilyStore {
  private data: FamilyData | undefined;
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = "data/family-access.json") {}

  private async load(): Promise<FamilyData> {
    if (this.data) {
      this.pruneExpired(this.data);
      return this.data;
    }
    try {
      this.data = validateData(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = structuredClone(EMPTY_DATA);
    }
    this.pruneExpired(this.data);
    return this.data;
  }

  private pruneExpired(data: FamilyData, now = Date.now()): void {
    data.requests = data.requests.filter((item) => item.expiresAt > now);
    data.invites = data.invites.filter((item) => item.expiresAt > now);
    data.claims = data.claims.filter((item) => item.expiresAt > now);
  }

  private async update<T>(operation: (data: FamilyData) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.serial;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const data = await this.load();
      this.pruneExpired(data);
      const result = await operation(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return result;
    } finally { release(); }
  }

  async getLinks(): Promise<FamilyLink[]> {
    const data = await this.load();
    return data.links.map((link) => ({ ...link }));
  }

  async getLinksForParent(parentDiscordId: string): Promise<FamilyLink[]> {
    return (await this.getLinks()).filter((link) => link.parentDiscordId === parentDiscordId);
  }

  async getRequestsForParent(parentDiscordId: string): Promise<FamilyRequest[]> {
    const data = await this.load();
    return data.requests.filter((item) => item.parentDiscordId === parentDiscordId).map((item) => ({ ...item }));
  }

  async getInvitesForParent(parentDiscordId: string): Promise<PendingFamilyInvite[]> {
    const data = await this.load();
    return data.invites.filter((item) => item.parentDiscordId === parentDiscordId).map((item) => ({ ...item }));
  }

  async getClaimsForChild(childDiscordId: string): Promise<FamilyClaim[]> {
    const data = await this.load();
    return data.claims.filter((item) => item.childDiscordId === childDiscordId).map((item) => ({ ...item }));
  }

  async getClaimsForParent(parentDiscordId: string): Promise<FamilyClaim[]> {
    const data = await this.load();
    return data.claims.filter((item) => item.parentDiscordId === parentDiscordId).map((item) => ({ ...item }));
  }

  async createRequest(parentDiscordId: string, childDiscordId: string): Promise<FamilyRequest> {
    return this.update((data) => {
      if (data.links.some((link) => link.childDiscordId === childDiscordId)) throw new Error("Denne Discord-kontoen er allerede koblet til et barn.");
      const existing = data.requests.find((item) => item.parentDiscordId === parentDiscordId && item.childDiscordId === childDiscordId);
      if (existing) return existing;
      if (data.requests.filter((item) => item.childDiscordId === childDiscordId).length >= 3) {
        throw new Error("Det finnes allerede flere ventende foresporsler for kontoen. Kontakt foresatt direkte.");
      }
      const request: FamilyRequest = { id: randomUUID(), parentDiscordId, childDiscordId, createdAt: Date.now(), expiresAt: Date.now() + FAMILY_REQUEST_TTL_MS };
      data.requests.push(request);
      return request;
    });
  }

  async createInvite(parentDiscordId: string, childName: string, discordUsername: string): Promise<PendingFamilyInvite> {
    return this.update((data) => {
      const key = normalizeChildName(childName);
      if (!key) throw new Error("Barnets navn kan ikke vaere tomt.");
      if (data.links.some((link) => link.parentDiscordId === parentDiscordId && normalizeChildName(link.childName) === key)) {
        throw new Error("Dette barnet har allerede en lagret Discord-kobling.");
      }
      if (data.invites.some((invite) => invite.parentDiscordId === parentDiscordId && normalizeChildName(invite.childName) === key)) {
        throw new Error("Dette barnet har allerede en ventende invitasjon.");
      }
      if (data.invites.some((invite) => invite.discordUsername.toLocaleLowerCase("en-US") === discordUsername.toLocaleLowerCase("en-US"))) {
        throw new Error("Dette brukernavnet har allerede en ventende familiekobling.");
      }
      const invite: PendingFamilyInvite = {
        id: randomUUID(), parentDiscordId, childName: childName.trim(),
        discordUsername: discordUsername.trim(), createdAt: Date.now(), expiresAt: Date.now() + FAMILY_INVITE_TTL_MS
      };
      data.invites.push(invite);
      return invite;
    });
  }

  async addClaim(invite: PendingFamilyInvite, childDiscordId: string): Promise<FamilyClaim> {
    return this.update((data) => {
      const current = data.invites.find((item) => item.id === invite.id);
      if (!current) throw new Error("Invitasjonen er utloept eller allerede behandlet.");
      if (data.links.some((link) => link.childDiscordId === childDiscordId)
        || data.claims.some((claim) => claim.childDiscordId === childDiscordId)) {
        throw new Error("Denne Discord-kontoen har allerede en familiekobling eller forespoersel.");
      }
      const claim: FamilyClaim = {
        id: current.id, parentDiscordId: current.parentDiscordId, childName: current.childName,
        childDiscordId, createdAt: Date.now(), expiresAt: current.expiresAt
      };
      data.invites = data.invites.filter((item) => item.id !== current.id);
      data.claims.push(claim);
      return claim;
    });
  }

  async getInvites(): Promise<PendingFamilyInvite[]> {
    return (await this.load()).invites.map((item) => ({ ...item }));
  }

  async findInviteByUsername(username: string): Promise<PendingFamilyInvite | undefined> {
    const normalized = username.trim().toLocaleLowerCase("en-US");
    const matches = (await this.getInvites()).filter((item) => item.discordUsername.toLocaleLowerCase("en-US") === normalized);
    if (matches.length > 1) throw new Error("Discord-brukernavnet matcher flere ventende familiekoblinger.");
    return matches[0];
  }

  async createLink(parentDiscordId: string, childName: string, childDiscordId: string): Promise<FamilyLink> {
    return this.update((data) => {
      const nameKey = normalizeChildName(childName);
      if (!nameKey) throw new Error("Barnets API-navn er tomt; ingen kobling ble lagret.");
      const existing = data.links.find((link) => link.childDiscordId === childDiscordId);
      if (existing && existing.parentDiscordId === parentDiscordId && normalizeChildName(existing.childName) === nameKey) return existing;
      if (existing) throw new Error("Denne Discord-kontoen er allerede koblet til et annet barn.");
      if (data.links.some((link) => link.parentDiscordId === parentDiscordId && normalizeChildName(link.childName) === nameKey)) {
        throw new Error("Et barn med dette navnet er allerede koblet. Be foresatt avklare navnekollisjonen.");
      }
      const link: FamilyLink = { parentDiscordId, childName: childName.trim(), childDiscordId, linkedAt: Date.now() };
      data.links.push(link);
      data.requests = data.requests.filter((request) => request.childDiscordId !== childDiscordId);
      data.claims = data.claims.filter((claim) => claim.childDiscordId !== childDiscordId);
      return link;
    });
  }

  async rejectRequest(parentDiscordId: string, requestId: string): Promise<boolean> {
    return this.update((data) => {
      const before = data.requests.length;
      data.requests = data.requests.filter((item) => item.id !== requestId || item.parentDiscordId !== parentDiscordId);
      return data.requests.length !== before;
    });
  }

  async rejectClaim(childDiscordId: string, claimId: string): Promise<boolean> {
    return this.update((data) => {
      const before = data.claims.length;
      data.claims = data.claims.filter((item) => item.id !== claimId || item.childDiscordId !== childDiscordId);
      return data.claims.length !== before;
    });
  }

  async rejectClaimByParent(parentDiscordId: string, claimId: string): Promise<boolean> {
    return this.update((data) => {
      const before = data.claims.length;
      data.claims = data.claims.filter((item) => item.id !== claimId || item.parentDiscordId !== parentDiscordId);
      return data.claims.length !== before;
    });
  }

  async rejectInvite(parentDiscordId: string, inviteId: string): Promise<boolean> {
    return this.update((data) => {
      const before = data.invites.length;
      data.invites = data.invites.filter((item) => item.id !== inviteId || item.parentDiscordId !== parentDiscordId);
      return data.invites.length !== before;
    });
  }

  async removeLink(parentDiscordId: string, childDiscordId: string): Promise<boolean> {
    return this.update((data) => {
      const before = data.links.length;
      data.links = data.links.filter((item) => item.parentDiscordId !== parentDiscordId || item.childDiscordId !== childDiscordId);
      return data.links.length !== before;
    });
  }
}