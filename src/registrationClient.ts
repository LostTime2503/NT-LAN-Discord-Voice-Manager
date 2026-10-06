export interface RegisteredPerson {
  name: string;
  firstName: string;
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
    result.set(discordId, { name: person.name, firstName: person.firstName });
  }
  return result;
}

export function createNickname(person: RegisteredPerson): string | null {
  const name = person.name.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!name || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  if (name.length <= 32) return name;
  const firstName = person.firstName.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!firstName || !name.startsWith(`${firstName} `)) return null;
  const lastName = name.split(" ").at(-1)!;
  const shortened = `${firstName} ${lastName}`;
  return shortened.length <= 32 ? shortened : null;
}

export class RegistrationClient {
  private token = "";
  private tokenExpiresAt = 0;
  private cached: Map<string, RegisteredPerson> | undefined;
  private cachedAt = 0;
  private pending: Promise<Map<string, RegisteredPerson>> | undefined;

  constructor(private readonly options: RegistrationOptions, private readonly request: typeof fetch = fetch) {
    for (const url of [options.apiUrl, options.tokenUrl]) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("Registration URLs must use HTTPS without embedded credentials.");
      }
    }
  }

  async getParticipants(): Promise<Map<string, RegisteredPerson>> {
    if (this.cached && Date.now() - this.cachedAt < 10_000) return this.cached;
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

  private async loadParticipants(): Promise<Map<string, RegisteredPerson>> {
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
      const people = parseParticipants(await response.json());
      this.cached = people;
      this.cachedAt = Date.now();
      return people;
    }
    throw new Error("Registration authentication failed.");
  }
}