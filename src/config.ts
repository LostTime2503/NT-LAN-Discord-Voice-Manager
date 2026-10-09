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

function readOptionalPositiveIntegerValue(name: string): number | undefined {
  const rawValue = process.env[name];
  if (!rawValue) return undefined;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }
  return value;
}

function readOptionalBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false.`);
  return value === "true";
}

export const config = {
  token: readRequiredEnv("DISCORD_TOKEN"),
  clientId: readRequiredEnv("DISCORD_CLIENT_ID"),
  guildId: readRequiredEnv("DISCORD_GUILD_ID"),
  joinToCreateChannelId: process.env.JOIN_TO_CREATE_CHANNEL_ID,
  csCategoryId: process.env.CS_CATEGORY_ID || process.env.CS_TEAM_CATEGORY_ID,
  csLobbyChannelId: process.env.CS_LOBBY_CHANNEL_ID,
  csParticipantRoleId: process.env.CS_PARTICIPANT_ROLE_ID,
  manualCsParticipantRoleId: process.env.MANUAL_CS_PARTICIPANT_ROLE_ID,
  csVoiceSyncEnabled: readOptionalBoolean("CS_VOICE_SYNC_ENABLED", false),
  csVoiceSyncDryRun: readOptionalBoolean("CS_VOICE_SYNC_DRY_RUN", readOptionalBoolean("CS_SYNC_DRY_RUN", true)),
  csRoleSyncEnabled: readOptionalBoolean("CS_ROLE_SYNC_ENABLED", false),
  csRoleSyncDryRun: readOptionalBoolean("CS_ROLE_SYNC_DRY_RUN", true),
  csSyncIntervalMs: readOptionalPositiveInteger("CS_SYNC_INTERVAL_MS", 300_000),
  csMainTournamentId: readOptionalPositiveIntegerValue("CS_MAIN_TOURNAMENT_ID"),
  csWingmanTournamentId: readOptionalPositiveIntegerValue("CS_WINGMAN_TOURNAMENT_ID"),
  csWebhookPort: readOptionalPositiveInteger("CS_WEBHOOK_PORT", 8787),
  matWebhookSecret: process.env.MAT_WEBHOOK_SECRET,
  crewLogChannelId: process.env.CREW_LOG_CHANNEL_ID,
  emptyChannelDeleteDelayMs: readOptionalPositiveInteger("EMPTY_CHANNEL_DELETE_DELAY_MS", 300_000),
  accessChannelId: process.env.ACCESS_CHANNEL_ID,
  accessRoleId: process.env.ACCESS_ROLE_ID,
  manualAccessRoleId: process.env.MANUAL_ACCESS_ROLE_ID,
  crewRoleId: process.env.CREW_ROLE_ID,
  accessDryRun: readOptionalBoolean("ACCESS_DRY_RUN", true),
  accessSyncIntervalMs: readOptionalPositiveInteger("ACCESS_SYNC_INTERVAL_MS", 15_000),
  registrationUrl: process.env.REGISTRATION_URL,
  registrationApiUrl: process.env.REGISTRATION_API_URL,
  registrationTokenUrl: process.env.REGISTRATION_TOKEN_URL,
  registrationClientId: process.env.REGISTRATION_CLIENT_ID,
  registrationClientSecret: process.env.REGISTRATION_CLIENT_SECRET,
  matUrl: process.env.MAT_URL,
  matApiToken: process.env.MAT_API_TOKEN
};
