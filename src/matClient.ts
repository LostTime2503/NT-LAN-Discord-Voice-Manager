export interface MatClientOptions {
  baseUrl: string;
  apiToken?: string;
}

export interface MatTournamentSummary {
  id: number;
  type: string;
  status: string;
  teamSize: number;
}

export interface MatSignupSummary {
  registrationCount: number;
  registrationOpen: boolean | null;
}

export interface MatBracketSummary {
  tournament: MatTournamentSummary;
  totalRounds: number;
  matches: Array<{
    slug: string | null;
    round: number | null;
    status: string | null;
    team1Id: string | null;
    team2Id: string | null;
  }>;
}

export interface MatTeam {
  id: string;
  name: string;
  tag: string | null;
  players: Array<{ steamId: string | null }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function parseTournament(value: unknown): MatTournamentSummary {
  if (!isRecord(value) || !positiveInteger(value.id) || typeof value.type !== "string"
    || typeof value.status !== "string" || !positiveInteger(value.teamSize)) {
    throw new Error("MAT API returned invalid tournament metadata.");
  }
  return { id: value.id, type: value.type, status: value.status, teamSize: value.teamSize };
}

export class MatClient {
  private readonly baseUrl: URL;

  constructor(private readonly options: MatClientOptions, private readonly request: typeof fetch = fetch) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "https:" || this.baseUrl.username || this.baseUrl.password
      || this.baseUrl.search || this.baseUrl.hash || this.baseUrl.pathname !== "/") {
      throw new Error("MAT_URL must be an HTTPS origin without credentials, path, query, or fragment.");
    }
    if (options.apiToken !== undefined && !options.apiToken.trim()) {
      throw new Error("MAT_API_TOKEN must not be empty when configured.");
    }
  }

  async getTournaments(): Promise<MatTournamentSummary[]> {
    const payload = await this.get("/api/tournaments");
    if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.tournaments)) {
      throw new Error("MAT API returned an invalid tournaments response.");
    }
    return payload.tournaments.map(parseTournament);
  }

  async getTeams(): Promise<MatTeam[]> {
    if (!this.options.apiToken) throw new Error("MAT_API_TOKEN is required for team lookups.");
    const payload = await this.get("/api/teams");
    if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.teams)) {
      throw new Error("MAT API returned an invalid teams response.");
    }
    return payload.teams.map(team => {
      if (!isRecord(team) || (typeof team.id !== "string" && typeof team.id !== "number")
        || typeof team.name !== "string" || !Array.isArray(team.players)) {
        throw new Error("MAT API returned invalid team metadata.");
      }
      return {
        id: String(team.id),
        name: team.name,
        tag: typeof team.tag === "string" ? team.tag : null,
        players: team.players.map(player => {
          if (!isRecord(player)) throw new Error("MAT API returned an invalid team player.");
          const steamId = typeof player.steamId === "string" && /^7656119\d{10}$/.test(player.steamId)
            ? player.steamId
            : null;
          return { steamId };
        })
      };
    });
  }

  async getSignupSummary(tournamentId: number): Promise<MatSignupSummary> {
    const payload = await this.get(`/api/tournament-signup/${this.tournamentId(tournamentId)}`);
    if (!isRecord(payload) || payload.success !== true || !isRecord(payload.window)
      || !Array.isArray(payload.registrations)) {
      throw new Error("MAT API returned an invalid signup response.");
    }
    return {
      registrationCount: payload.registrations.length,
      registrationOpen: typeof payload.window.registrationOpen === "boolean" ? payload.window.registrationOpen : null
    };
  }

  async getBracketSummary(tournamentId: number): Promise<MatBracketSummary> {
    const payload = await this.get(`/api/tournament/${this.tournamentId(tournamentId)}/bracket`);
    if (!isRecord(payload) || payload.success !== true || !nonNegativeInteger(payload.totalRounds)
      || !isRecord(payload.tournament) || !Array.isArray(payload.matches)) {
      throw new Error("MAT API returned an invalid bracket response.");
    }
    return {
      tournament: parseTournament(payload.tournament),
      totalRounds: payload.totalRounds,
      matches: payload.matches.map(match => {
        if (!isRecord(match)) throw new Error("MAT API returned an invalid bracket match.");
        return {
          slug: typeof match.slug === "string" ? match.slug : null,
          round: Number.isSafeInteger(match.round) ? match.round as number : null,
          status: typeof match.status === "string" ? match.status : null,
          team1Id: isRecord(match.team1) && (typeof match.team1.id === "string" || typeof match.team1.id === "number")
            ? String(match.team1.id)
            : null,
          team2Id: isRecord(match.team2) && (typeof match.team2.id === "string" || typeof match.team2.id === "number")
            ? String(match.team2.id)
            : null
        };
      })
    };
  }

  async getPlayerMatchCount(discordId: string): Promise<number> {
    if (!/^\d{17,20}$/.test(discordId)) throw new Error("Discord ID is invalid.");
    if (!this.options.apiToken) throw new Error("MAT_API_TOKEN is required for player lookups.");
    const payload = await this.get(`/api/players/by-discord-id/${discordId}`);
    if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.players)) {
      throw new Error("MAT API returned an invalid player lookup response.");
    }
    return payload.players.length;
  }

  private tournamentId(value: number): number {
    if (!positiveInteger(value)) throw new Error("MAT tournament ID is invalid.");
    return value;
  }

  private async get(path: string): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.options.apiToken) headers.Authorization = `Bearer ${this.options.apiToken}`;
    const response = await this.request(new URL(path, this.baseUrl), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers
    });
    if (!response.ok) throw new Error(`MAT API request failed (${response.status}).`);
    try {
      return await response.json();
    } catch {
      throw new Error("MAT API returned invalid JSON.");
    }
  }
}