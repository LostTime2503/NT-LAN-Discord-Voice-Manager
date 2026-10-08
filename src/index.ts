import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { findCommand } from "./commands/index.js";
import { config } from "./config.js";
import { sendCrewLogMessage } from "./crewLog.js";
import { ACCESS_BUTTON_ID, startAccessSync } from "./accessManager.js";
import { accessInitializationError, accessManager } from "./accessRuntime.js";
import { cleanupEmptyVoiceChannelsOnStartup, handleVoiceStateUpdate, logVoiceManagerStatus } from "./voiceManager.js";
import { MatClient } from "./matClient.js";
import { RegistrationClient } from "./registrationClient.js";
import { CsSyncRuntime } from "./csSyncRuntime.js";
import { CsWebhookRuntime } from "./csWebhookRuntime.js";
import { CsDiscordManager } from "./csDiscordManager.js";
import { DiscordJsCsVoiceAdapter } from "./discordCsVoiceAdapter.js";
import { manualOverrideStore } from "./manualOverrides.js";
import { giveAccessCommand } from "./commands/giveAccess.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, ...(accessManager ? [GatewayIntentBits.GuildMembers] : [])]
});
let csSyncRuntime: CsSyncRuntime | undefined;
let csWebhookRuntime: CsWebhookRuntime | undefined;
let csDiscordManager: CsDiscordManager | undefined;

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
  console.log(`Logged in as ${readyClient.user.tag}.`);
  logVoiceManagerStatus(readyClient);
  if (accessInitializationError) {
    console.error(`Access sync paused: ${accessInitializationError} Existing voice channels remain unchanged; new channel creation is blocked until configuration is fixed.`);
  }
  if (accessManager) {
    await startAccessSync(accessManager, readyClient);
  }
  await startCsSyncDryRun();
  void cleanupEmptyVoiceChannelsOnStartup(readyClient).catch((error) => {
    console.error("Failed to clean up empty voice channels on startup", error);
  });
  void sendCrewLogMessage(readyClient, "NT-LAN Voice Manager er online.");
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
  await csWebhookRuntime?.stop();
  await sendCrewLogMessage(client, "NT-LAN Voice Manager gar offline (planlagt stopp).");
  client.destroy();
  process.exit(0);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === giveAccessCommand.data.name) {
      await giveAccessCommand.autocomplete(interaction).catch(() => interaction.respond([]).catch(() => undefined));
    }
    return;
  }
  if (interaction.isButton() && interaction.customId === ACCESS_BUTTON_ID) {
    if (accessManager) {
      await accessManager.handleButton(interaction).catch(() => console.error("Access button response failed."));
    } else {
      await interaction.reply({ content: "Tilgangskontrollen er ikke aktivert.", flags: MessageFlags.Ephemeral });
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

    const message = `Noe gikk galt da /${interaction.commandName} skulle kjores.`;

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
  if (!accessManager || member.guild.id !== config.guildId || member.user.bot) return;
  void accessManager.check(member).catch(() => console.error("Access check failed for a joining member."));
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  if (!accessManager || newMember.guild.id !== config.guildId) return;
  void accessManager.handleNicknameUpdate(oldMember, newMember).catch(() => {
    console.error("Failed to restore a linked member's managed nickname.");
  });
});

await client.login(config.token);

async function startCsSyncDryRun(): Promise<void> {
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
    config.crewRoleId,
    config.csMainTournamentId,
    config.csWingmanTournamentId
  ].every(Boolean);
  if (!config.csSyncDryRun && (!discordConfigured || !config.matWebhookSecret || !config.matUrl
    || !config.matApiToken || !registrationConfigured)) {
    console.error("CS live sync paused; configure the CS category/lobby/roles, tournament IDs, MAT API/token, webhook secret, and registration API first.");
    return;
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
    console.error("CS webhook registration API configuration is invalid; receiver is paused.");
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
          config.crewRoleId!,
          config.emptyChannelDeleteDelayMs
        );
        if (!config.csSyncDryRun) await adapter.validate();
        csDiscordManager = new CsDiscordManager(
          adapter,
          config.csLobbyChannelId!,
          config.emptyChannelDeleteDelayMs,
          undefined,
          config.csSyncDryRun
        );
      }
      csWebhookRuntime = new CsWebhookRuntime({
        secret: config.matWebhookSecret,
        port: config.csWebhookPort,
        intervalMs: config.csSyncIntervalMs,
        mainTournamentId: config.csMainTournamentId,
        wingmanTournamentId: config.csWingmanTournamentId,
        mat,
        registration: csRegistration,
        dryRun: config.csSyncDryRun,
        discordManager: csDiscordManager
      });
      await csWebhookRuntime.start();
      console.log(`CS MAT webhook receiver listening on private container port ${config.csWebhookPort}.`);
    } catch {
      csWebhookRuntime = undefined;
      csDiscordManager = undefined;
      console.error("CS MAT webhook receiver failed to start; no Discord changes were made.");
    }
  } else {
    console.log("CS MAT webhook receiver is paused until MAT_WEBHOOK_SECRET and registration API settings are configured.");
  }

  if (config.csSyncDryRun && config.matUrl && config.matApiToken
    && config.csMainTournamentId && config.csWingmanTournamentId && registration && csRegistration) {
    try {
      const mat = new MatClient({ baseUrl: config.matUrl, apiToken: config.matApiToken });
      csSyncRuntime = new CsSyncRuntime(
        mat,
        csRegistration,
        config.csMainTournamentId,
        config.csWingmanTournamentId,
        config.csSyncIntervalMs
      );
      csSyncRuntime.start();
    } catch {
      console.error("CS MAT recovery configuration is invalid; webhook receiver remains read-only.");
    }
  } else if (config.csSyncDryRun) {
    console.log("CS MAT GET recovery is paused until both tournament IDs and MAT read-only settings are configured.");
  }
}