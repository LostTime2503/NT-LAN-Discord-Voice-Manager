import { config } from "./config.js";
import { AccessConfigurationError, AccessManager } from "./accessManager.js";
import { RegistrationClient } from "./registrationClient.js";
import { FamilyStore } from "./familyStore.js";

export const familyStore = new FamilyStore();

function createAccessManager(): AccessManager | undefined {
  const registrationValues = [config.registrationApiUrl, config.registrationTokenUrl, config.registrationClientId, config.registrationClientSecret];
  if (registrationValues.some(Boolean) && !registrationValues.every(Boolean)) {
    throw new AccessConfigurationError("Set all four REGISTRATION API/token/client settings or leave all empty.");
  }
  if (!config.registrationApiUrl) return undefined;
  if (!config.accessRoleId || !config.crewRoleId || !config.accessChannelId || !config.registrationUrl) {
    throw new AccessConfigurationError("Set ACCESS_ROLE_ID, CREW_ROLE_ID, ACCESS_CHANNEL_ID and REGISTRATION_URL for registration sync.");
  }
  const api = new RegistrationClient({
    apiUrl: config.registrationApiUrl,
    tokenUrl: config.registrationTokenUrl!,
    clientId: config.registrationClientId!,
    clientSecret: config.registrationClientSecret!
  });
  return new AccessManager({
    guildId: config.guildId,
    accessRoleId: config.accessRoleId,
    crewRoleId: config.crewRoleId,
    channelId: config.accessChannelId,
    familyChannelId: config.familyAccessChannelId,
    websiteUrl: config.registrationUrl,
    dryRun: config.accessDryRun,
    intervalMs: config.accessSyncIntervalMs
  }, () => api.getParticipants(), () => familyStore.getLinks());
}

function initializeAccess(): { accessManager?: AccessManager; accessInitializationError?: string } {
  try {
    return { accessManager: createAccessManager() };
  } catch (error) {
    return { accessInitializationError: error instanceof AccessConfigurationError
      ? error.message : "Kontroller tilgangs-ID-er og HTTPS-adresser i REGISTRATION-oppsettet." };
  }
}

export const { accessManager, accessInitializationError } = initializeAccess();