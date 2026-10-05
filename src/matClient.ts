import { config } from "./config.js";

export interface MatPlayer {
  steamId: string;
  name: string;
  avatar?: string;
  discordId: string | null;
}

export interface MatTeam {
  id: string;
  name: string;
  tag: string | null;
  discordRoleId: string | null;
  players: MatPlayer[];
  createdAt: number;
  updatedAt: number;
}

interface MatTeamsResponse {
  success: boolean;
  count: number;
  teams: MatTeam[];
}

interface MatPlayersByDiscordIdResponse {
  success: boolean;
  players: MatPlayer[];
}

function isConfigured(): boolean {
  return Boolean(config.matUrl && config.matApiToken);
}

async function matFetch<T>(path: string): Promise<T> {
  if (!isConfigured()) {
    throw new Error("MAT_URL and MAT_API_TOKEN must be set to use the MAT API.");
  }

  const response = await fetch(new URL(path, config.matUrl), {
    headers: { Authorization: `Bearer ${config.matApiToken}` }
  });

  if (!response.ok) {
    throw new Error(`MAT ${path} -> ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function getTeams(): Promise<MatTeam[]> {
  const data = await matFetch<MatTeamsResponse>("/api/teams");
  return data.teams;
}

export async function getPlayersByDiscordId(discordId: string): Promise<MatPlayer[]> {
  const data = await matFetch<MatPlayersByDiscordIdResponse>(
    `/api/players/by-discord-id/${encodeURIComponent(discordId)}`
  );
  return data.players;
}
