import "dotenv/config";

function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOptionalPositiveInteger(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }

  return value;
}

export const config = {
  token: readRequiredEnv("DISCORD_TOKEN"),
  clientId: readRequiredEnv("DISCORD_CLIENT_ID"),
  guildId: readRequiredEnv("DISCORD_GUILD_ID"),
  joinToCreateChannelId: process.env.JOIN_TO_CREATE_CHANNEL_ID,
  csTeamCategoryId: process.env.CS_TEAM_CATEGORY_ID,
  crewLogChannelId: process.env.CREW_LOG_CHANNEL_ID,
  crewRoleId: process.env.CREW_ROLE_ID,
  welcomeChannelId: process.env.WELCOME_CHANNEL_ID,
  modalChannelId: process.env.MODAL_CHANNEL_ID,
  announcementChannelId: process.env.ANNOUNCEMENT_CHANNEL_ID,
  emptyChannelDeleteDelayMs: readOptionalPositiveInteger("EMPTY_CHANNEL_DELETE_DELAY_MS", 300_000),
  teamSyncEnabled: process.env.ENABLE_TEAM_SYNC === "true",
  matUrl: process.env.MAT_URL,
  matApiToken: process.env.MAT_API_TOKEN,
  teamSyncIntervalMs: readOptionalPositiveInteger("TEAM_SYNC_INTERVAL_MS", 60_000)
};