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
import { CsEventStore } from "./csEventStore.js";
import { isCsRoomAssignmentEvent } from "./csWebhookServer.js";
import { CsDiscordManager } from "./csDiscordManager.js";
import { DiscordJsCsVoiceAdapter } from "./discordCsVoiceAdapter.js";
import { manualOverrideStore } from "./manualOverrides.js";
import { giveAccessCommand } from "./commands/giveAccess.js";
import { CsParticipantRoleRuntime } from "./csParticipantRoleRuntime.js";
import { loadBotMessages } from "./messages.js";
import { BotSettingsStore, type BotFeature } from "./botSettings.js";
import { BotSettingsController, configureBotSettingsController, getBotSettingsController } from "./botSettingsController.js";
import { formatCsWebhookSourceStatus, setCsWebhookRuntime } from "./csWebhookDiagnostics.js";
import { notifyCsParticipantsCommand } from "./commands/notifyCsParticipants.js";
import { csNotificationModalCommand, csNotificationScheduleStore } from "./commands/csNotificationModalCommand.js";
import { CsNotificationScheduler } from "./csNotificationSchedules.js";
import { getBotMessages, getBotText } from "./messages.js";
import { MealParticipantRoleRuntime } from "./mealParticipantRoleRuntime.js";
import { DiscordJsMealRoleAdapter } from "./discordMealRoleAdapter.js";
import { MealNotificationScheduler } from "./mealNotifications.js";
import { mealNotificationsCommand, mealNotificationStore } from "./commands/mealNotifications.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
    ...(accessManager || (config.foodRoundOneRoleId && config.foodRoundTwoRoleId) ? [GatewayIntentBits.GuildMembers] : [])]
});
let csSyncRuntime: CsSyncRuntime | undefined;
let csWebhookRuntime: CsWebhookRuntime | undefined;
let csDiscordManager: CsDiscordManager | undefined;
let csTestWebhookRuntime: CsWebhookRuntime | undefined;
let csTestDiscordManager: CsDiscordManager | undefined;
let stopCsSourceMutations: (() => void) | undefined;
let csParticipantRoleRuntime: CsParticipantRoleRuntime | undefined;
let csNotificationScheduler: CsNotificationScheduler | undefined;
let mealParticipantRoleRuntime: MealParticipantRoleRuntime | undefined;
let mealNotificationScheduler: MealNotificationScheduler | undefined;
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
  const category = action.action === "website-role-granted" || action.action === "manual-role-promoted"
    ? "website-link"
    : "general";
  void sendCrewLogMessage(client, entry, category);
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
  csNotificationScheduler = new CsNotificationScheduler(
    readyClient,
    config.guildId,
    config.csParticipantRoleId,
    config.manualCsParticipantRoleId,
    csNotificationScheduleStore
  );
  await csNotificationScheduler.start().catch(() => {
    csNotificationScheduler = undefined;
    console.error("CS notification schedules could not start; saved schedules remain unchanged.");
  });
  await startMealParticipantRoleSync();
  if (config.mealTextChannelId && config.foodRoundOneRoleId && config.foodRoundTwoRoleId) {
    mealNotificationScheduler = new MealNotificationScheduler(
      readyClient,
      config.guildId,
      config.mealTextChannelId,
      config.foodRoundOneRoleId,
      config.foodRoundTwoRoleId,
      mealNotificationStore,
      () => getBotMessages().food
    );
    await mealNotificationScheduler.start().catch(() => {
      mealNotificationScheduler = undefined;
      console.error("Meal notifications could not start; saved meal schedules were preserved.");
    });
  }
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
  csNotificationScheduler?.stop();
  mealParticipantRoleRuntime?.stop();
  mealNotificationScheduler?.stop();
  stopCsSourceMutations?.();
  csDiscordManager?.cancelPendingRoomDeletions();
  csTestDiscordManager?.cancelPendingRoomDeletions();
  await csWebhookRuntime?.stop();
  await csTestWebhookRuntime?.stop();
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
  if (interaction.isModalSubmit() && interaction.customId.startsWith("mealnotifications:")) {
    await mealNotificationsCommand.handleModal(interaction).catch(() => {
      if (!interaction.replied) void interaction.reply({ content: getBotText("mealNotifications.failed"), flags: MessageFlags.Ephemeral });
    });
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("csnotifications:")) {
    await csNotificationModalCommand.handleModal(interaction).catch(() => {
      if (!interaction.replied) void interaction.reply({ content: getBotText("csNotificationConsole.failed"), flags: MessageFlags.Ephemeral });
    });
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
    void csDiscordManager.handleVoiceStateUpdate(newState, oldState.channelId ?? undefined).catch(() => {
      console.error("CS voice state handling failed.");
    });
  }
  if (csTestDiscordManager) {
    void csTestDiscordManager.handleVoiceStateUpdate(newState, oldState.channelId ?? undefined).catch(() => {
      void sendCrewLogMessage(client, "[TESTSCRIPT] CS voice-ruting feilet; ingen rå feildetaljer logget.", "cs-detail");
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

async function startMealParticipantRoleSync(): Promise<void> {
  mealParticipantRoleRuntime?.stop();
  mealParticipantRoleRuntime = undefined;
  if (!config.foodRoundOneRoleId || !config.foodRoundTwoRoleId) {
    console.info("Meal role sync is not configured; set FOOD_ROUND_1_ROLE_ID and FOOD_ROUND_2_ROLE_ID to enable it.");
    return;
  }
  const registrationConfigured = [config.registrationApiUrl, config.registrationTokenUrl,
    config.registrationClientId, config.registrationClientSecret].every(Boolean);
  if (!registrationConfigured) {
    console.error("Meal role sync is paused; Registration API configuration is missing. Existing Pulje roles were preserved.");
    return;
  }
  try {
    const registration = new RegistrationClient({
      apiUrl: config.registrationApiUrl!,
      tokenUrl: config.registrationTokenUrl!,
      clientId: config.registrationClientId!,
      clientSecret: config.registrationClientSecret!
    });
      const adapter = new DiscordJsMealRoleAdapter(client, config.guildId, config.foodRoundOneRoleId, config.foodRoundTwoRoleId);
    await adapter.validate();
    mealParticipantRoleRuntime = new MealParticipantRoleRuntime(
      { getParticipants: () => registration.getCsParticipants() },
      adapter,
      config.mealSyncIntervalMs,
      summary => {
        console.log("Meal role sync", summary);
        void sendCrewLogMessage(client, getBotText("meal.rolesSummary", {
          pulje1: summary.roundOneParticipants,
          pulje2: summary.roundTwoParticipants,
          added: summary.roundOneAdded + summary.roundTwoAdded,
          removed: summary.roundOneRemoved + summary.roundTwoRemoved,
          missing: summary.participantsMissingMealData
        }, "logs"));
      }
    );
    mealParticipantRoleRuntime.start();
  } catch (error) {
    mealParticipantRoleRuntime = undefined;
    console.error("Meal role sync could not start; existing Pulje roles were preserved.",
      error instanceof Error ? error.message : "unknown error");
  }
}

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
  stopCsSourceMutations?.();
  csDiscordManager?.cancelPendingRoomDeletions();
  csTestDiscordManager?.cancelPendingRoomDeletions();
  csSyncRuntime?.stop();
  csSyncRuntime = undefined;
  await csWebhookRuntime?.stop();
  await csTestWebhookRuntime?.stop();
  csTestWebhookRuntime = undefined;
  setCsWebhookRuntime(undefined, "test");
  csTestDiscordManager = undefined;
  csWebhookRuntime = undefined;
  setCsWebhookRuntime(undefined, "mat");
  csDiscordManager?.cancelPendingRoomDeletions();
  csDiscordManager = undefined;
  if (!enabled) {
    console.log("CS voice sync is disabled.");
    return;
  }
  let running = true;
  stopCsSourceMutations = () => { running = false; };
  if (config.csTestWebhookSecret && (config.csTestWebhookPort === config.csWebhookPort
    || config.csTestWebhookSecret === config.matWebhookSecret)) {
    throw new Error("CS test receiver needs a distinct port and signing secret.");
  }
  const registrationConfigured = [
    config.registrationApiUrl,
    config.registrationTokenUrl,
    config.registrationClientId,
    config.registrationClientSecret
  ].every(Boolean);
  const requiredCsVoiceSettings: Array<[string, string | undefined]> = [
    ["CS_CATEGORY_ID", config.csCategoryId],
    ["CS_LOBBY_CHANNEL_ID", config.csLobbyChannelId],
    ["CS_PARTICIPANT_ROLE_ID", config.csParticipantRoleId],
    ["MANUAL_CS_PARTICIPANT_ROLE_ID", config.manualCsParticipantRoleId],
    ["CREW_ROLE_ID", config.crewRoleId],
    ["MAT_URL", config.matUrl],
    ["MAT_API_TOKEN", config.matApiToken],
    ["MAT_WEBHOOK_SECRET", config.matWebhookSecret],
    ["REGISTRATION_API_URL", config.registrationApiUrl],
    ["REGISTRATION_TOKEN_URL", config.registrationTokenUrl],
    ["REGISTRATION_CLIENT_ID", config.registrationClientId],
    ["REGISTRATION_CLIENT_SECRET", config.registrationClientSecret]
  ];
  const discordConfigured = [config.csCategoryId, config.csLobbyChannelId, config.csParticipantRoleId,
    config.manualCsParticipantRoleId, config.crewRoleId].every(Boolean);
  const missingSettings = requiredCsVoiceSettings.filter(([, value]) => !value).map(([name]) => name);
  if (missingSettings.length || !registrationConfigured) {
    throw new Error(getBotText("botSettings.csVoiceMissingConfig", { missing: missingSettings.join(", ") }));
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
      const receiversToStart: Array<{
        source: "mat" | "test";
        runtime: CsWebhookRuntime;
        port: number;
        sourceLabel: string;
        getMode: () => "off" | "preview" | "live";
      }> = [];
      for (const source of ["mat", "test"] as const) {
        if (source === "test" && !config.csTestWebhookSecret) continue;
        const sourceLabel = source === "test" ? "TESTSCRIPT" : "MAT";
        const sourceMode = () => {
          if (!running) return "off" as const;
          const mode = getBotSettingsController()?.getCsSources()[source] ?? (source === "test" ? "off" : "live");
          return mode === "live" && !live ? "preview" as const : mode;
        };
        const logCs = (message: string, category: "cs-detail" | "cs-summary" = "cs-detail") =>
          sendCrewLogMessage(client, `[${sourceLabel}] ${message}`, category);
        let sourceManager: CsDiscordManager | undefined;
        const mat = source === "mat" && sourceMode() !== "off" && config.matUrl && config.matApiToken
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
            config.crewRoleId!,
            () => sourceMode() === "live"
          );
          const guardedAdapter = new Proxy(adapter, {
            get(target, property) {
              const value = Reflect.get(target, property);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                if (sourceMode() !== "live" && !["cancelRoomDeletion", "cancelAllRoomDeletions"].includes(String(property))) {
                  throw new Error("CS source is not live.");
                }
                return Reflect.apply(value, target, args);
              };
            }
          });
          sourceManager = new CsDiscordManager(
            guardedAdapter,
            config.csLobbyChannelId!,
            config.csEmptyChannelDeleteDelayMs,
            source === "test" ? "data/cs-test-owned-voice-channels.json" : undefined,
            sourceMode() !== "live",
            activity => {
              console.log("CS webhook action", activity);
              const competition = getBotText(`makeTeamChats.competition.${activity.scope}`);
              const messageKey = activity.type === "room-ready" ? "cs.webhookRoomReady"
                : activity.type === "member-moved" ? "cs.webhookMoved" : "cs.webhookRouteSkipped";
              const reason = activity.reason ? getBotText(`cs.webhookRouteSkip.${activity.reason}`) : "";
              void logCs(getBotText(messageKey, { competition, reason }, "logs"));
            },
            () => sourceMode() === "live",
            memberId => (source === "test" ? csDiscordManager : csTestDiscordManager)?.hasAssignedMember(memberId) ?? false
          );
          if (source === "test") csTestDiscordManager = sourceManager;
          else csDiscordManager = sourceManager;
        }
        const runtime = new CsWebhookRuntime({
          secret: source === "test" ? config.csTestWebhookSecret! : config.matWebhookSecret,
          port: source === "test" ? config.csTestWebhookPort : config.csWebhookPort,
          path: source === "test" ? "/webhooks/cs-test" : undefined,
          namespace: source === "test" ? "test" : undefined,
          getMode: sourceMode,
          store: source === "test" ? new CsEventStore("data/cs-test-webhook-events.json") : undefined,
          intervalMs: config.csSyncIntervalMs,
          mat,
          registration: source === "test" ? {
            getParticipants: () => manualOverrideStore.getCsParticipants(new Map()),
            getCsParticipants: () => manualOverrideStore.getCsParticipants(new Map())
          } : csRegistration,
          dryRun: !live,
          discordManager: sourceManager,
          onTestEvent: eventType => {
            console.log("CS webhook test event received", { eventType });
            void logCs(getBotText("cs.webhookTestReceived", { eventType }, "logs"));
          },
          onEventReceived: event => {
            console.log("CS webhook event queued", event);
            void logCs(getBotText("cs.webhookReceived", {
              eventType: event.eventType,
              matchStatus: event.matchStatus,
              sequence: event.sequence,
              team1Players: event.team1Players,
              team2Players: event.team2Players
            }, "logs"));
          },
          onEventRejected: (eventType, reason) => {
            void logCs(getBotText("cs.webhookRejected", { eventType, reason }, "logs"));
          },
          onEventIgnored: (eventType, reason) => {
            console.warn("CS webhook event ignored", { eventType, reason });
            void logCs(getBotText("cs.webhookIgnored", { eventType, reason }, "logs"));
          },
          onTerminalCleanup: (eventType, releasedAssignments) => {
            const released = releasedAssignments === null
              ? "match-slug tvetydig; ingen endret"
              : String(releasedAssignments);
            console.info("CS terminal webhook cleanup", { eventType, releasedAssignments });
            void logCs(getBotText("cs.webhookTerminalCleanup", { eventType, released }, "logs"));
          },
          onProcessingFailed: (eventType, stage, reason) => {
            void logCs(getBotText("cs.webhookProcessingFailed", {
              eventType, stage, reason
            }, "logs"));
          },
          report: summary => {
            console.log("CS webhook plan", summary);
            const noMoveReason = summary.dryRun
              ? getBotText("cs.webhookPreviewNoMutation", {}, "logs")
              : summary.skippedTeams > 0
                ? getBotText("cs.webhookTeamsSkippedReason", {}, "logs")
                : summary.plannedMembers > 0 && (summary.updatedRooms ?? 0) === 0
                ? getBotText("cs.webhookNoEligibleMove", {}, "logs") : "";
            void logCs(getBotText("cs.webhookSummary", {
              tournament: getBotText(`makeTeamChats.competition.${summary.tournament}`),
              eventType: summary.eventType,
              source: summary.tournamentSource === "roster" ? "roster fallback" : "MAT API",
              mode: summary.dryRun ? "forhåndsvisning" : "live",
              planned: summary.plannedRooms,
              members: summary.plannedMembers,
              ensured: summary.roomsEnsured ?? 0,
              moved: summary.updatedRooms ?? 0,
              skipped: summary.skippedTeams,
              unmatched: summary.unmatchedPlayers,
              ambiguous: summary.ambiguousSteamIds,
              noMoveReason
            }, "logs"), "cs-summary");
          }
        });
        if (source === "test") csTestWebhookRuntime = runtime;
        else csWebhookRuntime = runtime;
        receiversToStart.push({
          source,
          runtime,
          port: source === "test" ? config.csTestWebhookPort : config.csWebhookPort,
          sourceLabel,
          getMode: sourceMode
        });
      }
      await csDiscordManager?.load();
      await csTestDiscordManager?.load();
      for (const receiver of receiversToStart.sort((left, right) => left.source === "test" ? -1 : right.source === "test" ? 1 : 0)) {
        try {
          await receiver.runtime.start();
          setCsWebhookRuntime(receiver.runtime, receiver.source);
          const listeningKey = receiver.source === "test" ? "cs.webhookListening.test" : "cs.webhookListening.mat";
          const status = formatCsWebhookSourceStatus({
            configured: true,
            featureEnabled: enabled,
            featureLive: live,
            mode: receiver.getMode(),
            diagnostics: await receiver.runtime.getDiagnostics()
          });
          void sendCrewLogMessage(client, getBotText(listeningKey, { port: receiver.port, mode: status }, "logs"), "cs-detail");
        } catch (error) {
          if (receiver.source === "test") throw error;
          csWebhookRuntime = undefined;
          setCsWebhookRuntime(undefined, "mat");
          csDiscordManager?.cancelPendingRoomDeletions();
          console.error("MAT webhook could not start; test receiver remains available.",
            error instanceof Error ? error.name : "UnknownError");
          void sendCrewLogMessage(client, "[MAT] Mottakeren startet ikke; TESTSCRIPT fortsetter separat.", "cs-detail");
        }
      }
    } catch (error) {
      running = false;
      csDiscordManager?.cancelPendingRoomDeletions();
      csTestDiscordManager?.cancelPendingRoomDeletions();
      await csWebhookRuntime?.stop();
      await csTestWebhookRuntime?.stop();
      csTestWebhookRuntime = undefined;
      csTestDiscordManager = undefined;
      setCsWebhookRuntime(undefined, "test");
      csWebhookRuntime = undefined;
      setCsWebhookRuntime(undefined, "mat");
      csDiscordManager = undefined;
      const reason = error instanceof Error ? error.message : "ukjent oppstartsfeil";
      throw new Error(`CS MAT webhook kunne ikke starte: ${reason}`);
    }
  } else {
    throw new Error("CS MAT webhook trenger MAT_WEBHOOK_SECRET og Registration API.");
  }

  if (enabled && !live && getBotSettingsController()?.getCsSources().mat !== "off"
    && config.matUrl && config.matApiToken && registration && csRegistration) {
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
          }, "logs"), "cs-summary");
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