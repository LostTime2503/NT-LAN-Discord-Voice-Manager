import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { findCommand } from "./commands/index.js";
import { config } from "./config.js";
import { sendCrewLogMessage } from "./crewLog.js";
import { ACCESS_BUTTON_ID, startAccessSync, type AccessAuditAction } from "./accessManager.js";
import { accessInitializationError, accessManager } from "./accessRuntime.js";
import { handleVoiceStateUpdate, logVoiceManagerStatus, restoreTemporaryChannelOwners, setVoiceManagerEnabled } from "./voiceManager.js";
import { MatClient } from "./matClient.js";
import { RegistrationClient } from "./registrationClient.js";
import { CsSyncRuntime } from "./csSyncRuntime.js";
import { CsWebhookRuntime } from "./csWebhookRuntime.js";
import { CsDiscordManager } from "./csDiscordManager.js";
import { DiscordJsCsVoiceAdapter } from "./discordCsVoiceAdapter.js";
import { manualOverrideStore } from "./manualOverrides.js";
import { giveAccessCommand } from "./commands/giveAccess.js";
import { CsParticipantRoleRuntime } from "./csParticipantRoleRuntime.js";
import { loadBotMessages } from "./messages.js";
import { BotSettingsStore, type BotFeature } from "./botSettings.js";
import { BotSettingsController, configureBotSettingsController } from "./botSettingsController.js";
import { notifyCsParticipantsCommand } from "./commands/notifyCsParticipants.js";
import { getBotText } from "./messages.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, ...(accessManager ? [GatewayIntentBits.GuildMembers] : [])]
});
let csSyncRuntime: CsSyncRuntime | undefined;
let csWebhookRuntime: CsWebhookRuntime | undefined;
let csDiscordManager: CsDiscordManager | undefined;
let csParticipantRoleRuntime: CsParticipantRoleRuntime | undefined;
let accessSyncEnabled = false;
let csRoleSyncEnabled = false;
let csVoiceSyncEnabled = false;
let lastAccessAuditKey = "";
let lastAccessAuditAt = 0;

function reportAccessAction(action: AccessAuditAction): void {
  const keys: Record<AccessAuditAction["action"], string> = {
    "nickname-set": "access.nicknameSet",
    "website-role-granted": "access.websiteRoleGranted",
    "manual-role-granted": "access.manualRoleGranted",
    "manual-role-promoted": "access.manualRolePromoted",
    "website-role-revoked": "access.websiteRoleRevoked",
    "manual-role-revoked": "access.manualRoleRevoked"
  };
  const entry = getBotText(keys[action.action], {
    username: action.username,
    nickname: action.nickname ?? ""
  }, "logs");
  console.info(`[crew-audit] ${entry}`);
  void sendCrewLogMessage(client, entry);
}

// Gir en tydelig logglinje for Dockhand/Docker for prosessen dor, i stedet for a henge i ukjent tilstand.
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception, shutting down", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection, shutting down", error);
  process.exit(1);
});

client.once(Events.ClientReady, async (readyClient) => {
  await loadBotMessages();
  console.log(`Logged in as ${readyClient.user.tag}.`);
  logVoiceManagerStatus(readyClient);
  if (accessInitializationError) {
    console.error(`Access sync paused: ${accessInitializationError} Existing voice channels remain unchanged; new channel creation is blocked until configuration is fixed.`);
  }
  const settingsStore = new BotSettingsStore("data/bot-settings.json", {
    access: Boolean(accessManager),
    normalVoice: Boolean(config.joinToCreateChannelId),
    csRoles: config.csRoleSyncEnabled,
    csVoice: config.csVoiceSyncEnabled
  }, {
    access: Boolean(accessManager && !config.accessDryRun),
    csRoles: config.csRoleSyncEnabled && !config.csRoleSyncDryRun,
    csVoice: config.csVoiceSyncEnabled && !config.csVoiceSyncDryRun
  });
  const settingsController = new BotSettingsController(settingsStore,
    (feature, enabled, live) => applyBotFeature(readyClient, feature, enabled, live));
  try {
    const settings = await settingsController.load();
    configureBotSettingsController(settingsController);
    accessManager?.setActionReporter(reportAccessAction);
    const live = settingsStore.getLive();
    for (const [feature, enabled, isLive] of [
      ["access", settings.access, live.access],
      ["normalVoice", settings.normalVoice, false],
      ["csRoles", settings.csRoles, live.csRoles],
      ["csVoice", settings.csVoice, live.csVoice]
    ] as const) {
      try {
        await applyBotFeature(readyClient, feature, enabled, isLive);
      } catch (error) {
        console.error(`Feature ${feature} could not start; it was disabled without changing other features.`,
          error instanceof Error ? error.message : "runtime start failed");
        await settingsStore.set(feature, false);
      }
    }
  } catch {
    console.error("Bot settings could not be loaded; automated features remain stopped. Check data/bot-settings.json.");
    return;
  }
  void sendCrewLogMessage(readyClient, getBotText("bot.online", {}, "logs"));
});

// Dekker kontrollert stopp (Ctrl+C, Docker stop), ikke krasj eller stromstans.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  accessManager?.stop();
  csSyncRuntime?.stop();
  csParticipantRoleRuntime?.stop();
  await csWebhookRuntime?.stop();
  await sendCrewLogMessage(client, getBotText("bot.offline", {}, "logs"));
  client.destroy();
  process.exit(0);
}

async function applyBotFeature(
  readyClient: Client,
  feature: BotFeature,
  enabled: boolean,
  live: boolean
): Promise<void> {
  if (feature === "normalVoice") {
    if (enabled && !config.joinToCreateChannelId) throw new Error("JOIN_TO_CREATE_CHANNEL_ID må være konfigurert før vanlig voice kan startes.");
    setVoiceManagerEnabled(enabled);
    if (enabled) await restoreTemporaryChannelOwners();
    void sendCrewLogMessage(readyClient, getBotText("settings.normalVoice", { status: enabled ? "aktivert" : "pauset" }, "logs"));
    return;
  }
  if (feature === "access") {
    accessSyncEnabled = false;
    if (!enabled) {
      accessManager?.stop();
      void sendCrewLogMessage(readyClient, getBotText("settings.accessPaused", {}, "logs"));
      return;
    }
    if (!accessManager) {
      throw new Error("Nettsidetilgang er ikke konfigurert. Sett rolle-, kanal- og API-innstillinger før aktivering.");
    }
    accessSyncEnabled = true;
    accessManager.settings.dryRun = !live;
    accessManager.setSummaryReporter(summary => {
      console.log("Access sync summary", summary);
      const key = JSON.stringify(summary);
      const now = Date.now();
      if (key === lastAccessAuditKey && now - lastAccessAuditAt < 300_000) return;
      lastAccessAuditKey = key;
      lastAccessAuditAt = now;
      const counts = Object.entries(summary.counts).map(([name, count]) => `${name}:${count}`).join(", ") || "ingen endringer";
      void sendCrewLogMessage(readyClient, getBotText("access.summary", {
        mode: summary.dryRun ? getBotText("botSettings.mode.preview") : getBotText("botSettings.mode.live"), counts
      }, "logs"));
    });
    if (!await startAccessSync(accessManager, readyClient)) {
      accessSyncEnabled = false;
      throw new Error("Nettsidetilgang kunne ikke starte. Kontroller roller og botrettigheter.");
    }
    void sendCrewLogMessage(readyClient, getBotText("settings.accessState", {
      status: live ? "aktivert live" : "aktivert i forhåndsvisning"
    }, "logs"));
    return;
  }
  if (feature === "csRoles") {
    csRoleSyncEnabled = enabled;
    await startCsParticipantRoleSync(enabled, live);
    void sendCrewLogMessage(readyClient, getBotText("settings.csRoles", {
      status: !enabled ? "pauset" : live ? "aktivert live" : "aktivert i forhåndsvisning"
    }, "logs"));
    return;
  }
  csVoiceSyncEnabled = enabled;
  await startCsVoiceSync(enabled, live);
  void sendCrewLogMessage(readyClient, getBotText("settings.csVoice", {
    status: !enabled ? "pauset" : live ? "aktivert live" : "aktivert i forhåndsvisning"
  }, "logs"));
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === giveAccessCommand.data.name) {
      await giveAccessCommand.autocomplete(interaction).catch(() => interaction.respond([]).catch(() => undefined));
    } else if (interaction.commandName === notifyCsParticipantsCommand.data.name) {
      await notifyCsParticipantsCommand.autocomplete(interaction).catch(() => interaction.respond([]).catch(() => undefined));
    }
    return;
  }
  if (interaction.isButton() && interaction.customId === ACCESS_BUTTON_ID) {
    if (accessManager && accessSyncEnabled) {
      await accessManager.handleButton(interaction).catch(() => console.error("Access button response failed."));
    } else {
      await interaction.reply({ content: getBotText("index.accessPaused"), flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = findCommand(interaction.commandName);

  if (!command) {
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Failed to execute /${interaction.commandName}`, error);

    const message = getBotText("index.commandFailed", { command: interaction.commandName });

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  void handleVoiceStateUpdate(oldState, newState).catch((error) => {
    console.error("Failed to handle voice state update", error);
  });
  if (csDiscordManager) {
    void csDiscordManager.handleVoiceStateUpdate(newState).catch(() => {
      console.error("CS lobby routing failed; member remains in the lobby.");
    });
  }
});

client.on(Events.GuildMemberAdd, (member) => {
  if (!accessManager || !accessSyncEnabled || member.guild.id !== config.guildId || member.user.bot) return;
  void accessManager.check(member).catch(() => console.error("Access check failed for a joining member."));
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  if (!accessManager || newMember.guild.id !== config.guildId) return;
  void (async () => {
    await accessManager.handleManualAccessRoleRemoval(oldMember, newMember, accessSyncEnabled);
    if (accessSyncEnabled) await accessManager.handleNicknameUpdate(oldMember, newMember);
  })().catch(() => console.error("Failed to process an access-role or nickname update."));
});

await client.login(config.token);

async function startCsParticipantRoleSync(enabled = config.csRoleSyncEnabled, live = !config.csRoleSyncDryRun): Promise<void> {
  csParticipantRoleRuntime?.stop();
  csParticipantRoleRuntime = undefined;
  if (!enabled) return;
  const registrationConfigured = [
    config.registrationApiUrl,
    config.registrationTokenUrl,
    config.registrationClientId,
    config.registrationClientSecret
  ].every(Boolean);
  if (!registrationConfigured || !config.csParticipantRoleId || !config.crewRoleId) {
    throw new Error("CS_PARTICIPANT_ROLE_ID, CREW_ROLE_ID og alle REGISTRATION_* må være konfigurert.");
  }
  try {
    const registration = new RegistrationClient({
      apiUrl: config.registrationApiUrl!,
      tokenUrl: config.registrationTokenUrl!,
      clientId: config.registrationClientId!,
      clientSecret: config.registrationClientSecret!
    });
    const registrationSource = {
      getParticipants: () => registration.getParticipants(),
      getCsParticipants: async () => manualOverrideStore.getCsParticipants(await registration.getCsParticipants())
    };
    const adapter = new DiscordJsCsVoiceAdapter(
      client,
      config.guildId,
      config.csCategoryId ?? "",
      config.csLobbyChannelId ?? "",
      config.csParticipantRoleId,
      config.manualCsParticipantRoleId,
      config.crewRoleId
    );
    await manualOverrideStore.load();
    await adapter.validateParticipantRoleManagement();
    csParticipantRoleRuntime = new CsParticipantRoleRuntime(
      registrationSource,
      adapter,
      config.csSyncIntervalMs,
      !live,
      summary => {
        console.log("CS participant role sync", summary);
        void sendCrewLogMessage(client, getBotText("cs.roleSummary", {
          mode: summary.dryRun ? getBotText("botSettings.mode.preview") : getBotText("botSettings.mode.live"),
          enrolled: summary.enrolled,
          added: summary.rolesAdded,
          removed: summary.rolesRemoved,
          missing: summary.missingEnrollmentData
        }, "logs"));
      }
    );
    csParticipantRoleRuntime.start();
  } catch {
    csParticipantRoleRuntime = undefined;
    throw new Error("CS-rolletildeling kunne ikke starte. Kontroller API-et og rollehierarkiet.");
  }
}

async function startCsVoiceSync(enabled = config.csVoiceSyncEnabled, live = !config.csVoiceSyncDryRun): Promise<void> {
  csSyncRuntime?.stop();
  csSyncRuntime = undefined;
  await csWebhookRuntime?.stop();
  csWebhookRuntime = undefined;
  csDiscordManager = undefined;
  if (!enabled) {
    console.log("CS voice sync is disabled.");
    return;
  }
  const registrationConfigured = [
    config.registrationApiUrl,
    config.registrationTokenUrl,
    config.registrationClientId,
    config.registrationClientSecret
  ].every(Boolean);
  const discordConfigured = [
    config.csCategoryId,
    config.csLobbyChannelId,
    config.csParticipantRoleId,
    config.manualCsParticipantRoleId,
    config.crewRoleId
  ].every(Boolean);
  if (!discordConfigured || !config.matWebhookSecret || !config.matUrl
    || !config.matApiToken || !registrationConfigured) {
    throw new Error("CS-kategori, lobby, begge roller, MAT API/token, webhook-secret og Registration API må være konfigurert.");
  }

  let registration: RegistrationClient | undefined;
  try {
    if (registrationConfigured) {
      registration = new RegistrationClient({
        apiUrl: config.registrationApiUrl!,
        tokenUrl: config.registrationTokenUrl!,
        clientId: config.registrationClientId!,
        clientSecret: config.registrationClientSecret!
      });
    }
  } catch {
    throw new Error("CS Registration API-konfigurasjonen er ugyldig.");
  }
  const csRegistration = registration ? {
    getParticipants: () => registration!.getParticipants(),
    getCsParticipants: async () => manualOverrideStore.getCsParticipants(await registration!.getCsParticipants())
  } : undefined;

  if (config.matWebhookSecret && registration && csRegistration) {
    try {
      await manualOverrideStore.load();
      const mat = config.matUrl && config.matApiToken
        ? new MatClient({ baseUrl: config.matUrl, apiToken: config.matApiToken })
        : undefined;
      if (discordConfigured) {
        const adapter = new DiscordJsCsVoiceAdapter(
          client,
          config.guildId,
          config.csCategoryId!,
          config.csLobbyChannelId!,
          config.csParticipantRoleId!,
          config.manualCsParticipantRoleId,
          config.crewRoleId!
        );
        if (live) await adapter.validate();
        csDiscordManager = new CsDiscordManager(
          adapter,
          config.csLobbyChannelId!,
          config.emptyChannelDeleteDelayMs,
          undefined,
          !live
        );
      }
      csWebhookRuntime = new CsWebhookRuntime({
        secret: config.matWebhookSecret,
        port: config.csWebhookPort,
        intervalMs: config.csSyncIntervalMs,
        mat,
        registration: csRegistration,
        dryRun: !live,
        discordManager: csDiscordManager,
        report: summary => {
          console.log("CS webhook plan", summary);
          void sendCrewLogMessage(client, getBotText("cs.webhookSummary", {
            tournament: summary.tournament,
            eventType: summary.eventType,
            planned: summary.plannedRooms,
            updated: summary.updatedRooms ?? 0,
            skipped: summary.skippedTeams
          }, "logs"));
        }
      });
      await csWebhookRuntime.start();
      console.log(`CS MAT webhook receiver listening on private container port ${config.csWebhookPort}.`);
    } catch {
      csWebhookRuntime = undefined;
      csDiscordManager = undefined;
      throw new Error("CS MAT webhook kunne ikke starte; ingen nye Discord-endringer ble gjort.");
    }
  } else {
    throw new Error("CS MAT webhook trenger MAT_WEBHOOK_SECRET og Registration API.");
  }

  if (enabled && !live && config.matUrl && config.matApiToken && registration && csRegistration) {
    try {
      const mat = new MatClient({ baseUrl: config.matUrl, apiToken: config.matApiToken });
      csSyncRuntime = new CsSyncRuntime(
        mat,
        csRegistration,
        config.csSyncIntervalMs,
        summary => {
          console.log("CS sync preview", summary);
          void sendCrewLogMessage(client, getBotText("cs.recoverySummary", {
            main: summary.mainTeamRoomCount,
            wingman: summary.wingmanPairRoomCount,
            unmatched: summary.unmatchedParticipantCount
          }, "logs"));
        }
      );
      csSyncRuntime.start();
    } catch {
      console.error("CS MAT recovery configuration is invalid; webhook receiver remains read-only.");
    }
  } else if (enabled && !live) {
    console.log("CS MAT GET recovery is paused until both tournament IDs and MAT read-only settings are configured.");
  }
}