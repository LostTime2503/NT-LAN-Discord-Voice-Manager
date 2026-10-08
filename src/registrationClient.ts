export interface RegisteredPerson {
  name: string;
  firstName: string;
  steamId?: string;
  tournaments?: string[];
  manualCsLink?: boolean;
}

export interface RegistrationOptions {
  apiUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSteamId(value: unknown): string | undefined {
  return typeof value === "string" && /^7656119\d{10}$/.test(value) ? value : undefined;
}

function parseTournaments(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(tournament => typeof tournament !== "string" || !tournament.trim())) return undefined;
  return [...new Set(value as string[])];
}

export function parseParticipants(payload: unknown): Map<string, RegisteredPerson> {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.participants)) {
    throw new Error("Registration API returned an invalid participants object.");
  }
  const result = new Map<string, RegisteredPerson>();
  for (const [discordId, person] of Object.entries(payload.data.participants)) {
    if (!/^\d{17,20}$/.test(discordId) || !isRecord(person) || typeof person.name !== "string"
      || typeof person.firstName !== "string") {
      throw new Error("Registration API returned an invalid participant.");
    }
    const steamId = parseSteamId(person.steamId);
    result.set(discordId, { name: person.name, firstName: person.firstName, ...(steamId ? { steamId } : {}) });
  }
  return result;
}

export function parseCsParticipants(payload: unknown): Map<string, RegisteredPerson> {
  const participants = parseParticipants(payload);
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.participants)) return participants;
  const duplicateDiscordIds = new Set<string>();
  const topLevelDiscordIds = new Set(participants.keys());

  for (const [discordId, person] of Object.entries(payload.data.participants)) {
    if (!isRecord(person)) continue;
    const topLevel = participants.get(discordId);
    if (topLevel) {
      const tournaments = parseTournaments(person.tournaments);
      participants.set(discordId, {
        ...topLevel,
        ...(tournaments ? { tournaments } : {}),
        ...(parseSteamId(person.steamId) ? { steamId: parseSteamId(person.steamId) } : {})
      });
    }
    if (!Array.isArray(person.children)) continue;
    for (const child of person.children) {
      if (!isRecord(child) || typeof child.discordId !== "string" || !/^\d{17,20}$/.test(child.discordId)
        || typeof child.name !== "string" || typeof child.firstName !== "string") continue;
      if (participants.has(child.discordId)) {
        if (topLevelDiscordIds.has(child.discordId)) {
          const parent = participants.get(child.discordId)!;
          const { steamId: _steamId, ...withoutSteamId } = parent;
          participants.set(child.discordId, withoutSteamId);
        } else {
          duplicateDiscordIds.add(child.discordId);
        }
        continue;
      }
      const steamId = parseSteamId(child.steamId);
      const tournaments = parseTournaments(child.tournaments);
      participants.set(child.discordId, {
        name: child.name,
        firstName: child.firstName,
        ...(tournaments ? { tournaments } : {}),
        ...(steamId ? { steamId } : {})
      });
    }
  }

  for (const discordId of duplicateDiscordIds) {
    const person = participants.get(discordId);
    if (person) {
      const { steamId: _steamId, tournaments: _tournaments, ...ambiguousChild } = person;
      participants.set(discordId, ambiguousChild);
    }
  }
  return participants;
}

export function createNickname(person: RegisteredPerson): string | null {
  const name = person.name.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!name || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  const firstName = person.firstName.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!firstName || /[\p{Cc}\p{Cf}]/u.test(firstName)) return null;
  const nameParts = name.split(" ");
  const firstNameParts = firstName.split(" ");
  if (firstNameParts.some((part, index) => nameParts[index] !== part)) return null;
  const remainingInitials = nameParts.slice(firstNameParts.length)
    .map(part => `${Array.from(part)[0]?.toLocaleUpperCase("nb-NO") ?? ""}.`);
  const nickname = [firstName, ...remainingInitials].join(" ");
  return nickname && [...nickname].length <= 32 ? nickname : null;
}

export class RegistrationClient {
  private token = "";
  private tokenExpiresAt = 0;
  private cached: Map<string, RegisteredPerson> | undefined;
  private cachedCsParticipants: Map<string, RegisteredPerson> | undefined;
  private cachedAt = 0;
  private pending: Promise<{ participants: Map<string, RegisteredPerson>; csParticipants: Map<string, RegisteredPerson> }> | undefined;

  constructor(private readonly options: RegistrationOptions, private readonly request: typeof fetch = fetch) {
    for (const url of [options.apiUrl, options.tokenUrl]) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("Registration URLs must use HTTPS without embedded credentials.");
      }
    }
  }

  async getParticipants(): Promise<Map<string, RegisteredPerson>> {
    return (await this.getParticipantMaps()).participants;
  }

  async getCsParticipants(): Promise<Map<string, RegisteredPerson>> {
    return (await this.getParticipantMaps()).csParticipants;
  }

  private async getParticipantMaps(): Promise<{
    participants: Map<string, RegisteredPerson>;
    csParticipants: Map<string, RegisteredPerson>;
  }> {
    if (this.cached && this.cachedCsParticipants && Date.now() - this.cachedAt < 10_000) {
      return { participants: this.cached, csParticipants: this.cachedCsParticipants };
    }
    if (this.pending) return this.pending;
    this.pending = this.loadParticipants();
    try { return await this.pending; } finally { this.pending = undefined; }
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await this.request(this.options.tokenUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        scope: "openid",
        grant_type: "client_credentials"
      })
    });
    if (!response.ok) throw new Error(`Registration token request failed (${response.status}).`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.access_token !== "string" || !payload.access_token
      || typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
      throw new Error("Registration token response is invalid.");
    }
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(0, payload.expires_in - 30) * 1000;
    return this.token;
  }

  private async loadParticipants(): Promise<{
    participants: Map<string, RegisteredPerson>;
    csParticipants: Map<string, RegisteredPerson>;
  }> {
    for (const attempt of [0, 1]) {
      const token = await this.getToken();
      const response = await this.request(this.options.apiUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.status === 401 && attempt === 0) {
        this.token = "";
        continue;
      }
      if (!response.ok) throw new Error(`Registration API request failed (${response.status}).`);
      const payload: unknown = await response.json();
      const people = parseParticipants(payload);
      const csPeople = parseCsParticipants(payload);
      this.cached = people;
      this.cachedCsParticipants = csPeople;
      this.cachedAt = Date.now();
      return { participants: people, csParticipants: csPeople };
    }
    throw new Error("Registration authentication failed.");
  }
}