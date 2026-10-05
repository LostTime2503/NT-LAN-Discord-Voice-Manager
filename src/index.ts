import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { findCommand } from "./commands/index.js";
import { handleMealPlanReplacementButton } from "./commands/matCatering.js";
import { handleMealPlanModalSubmit } from "./commands/matCatering.js";
import { config } from "./config.js";
import { sendCrewLogMessage } from "./crewLog.js";
import { handleMatRegistrationButton, handleMatRegistrationModalSubmit } from "./matRegistration.js";
import { startMealNotificationScheduler } from "./mealScheduler.js";
import { handleSetNicknameButton, handleSetNicknameModalSubmit, sendWelcomeMessage } from "./onboarding.js";
import { startTeamSync } from "./teamSync.js";
import { cleanupEmptyVoiceChannelsOnStartup, handleVoiceStateUpdate, logVoiceManagerStatus } from "./voiceManager.js";

const client = new Client({
  // GuildMembers er en privilegert intent - ma skrus pa for boten i Discord Developer Portal.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers]
});

// Gir en tydelig logglinje for Dockhand/Docker for prosessen dor, i stedet for a henge i ukjent tilstand.
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception, shutting down", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection, shutting down", error);
  process.exit(1);
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  logVoiceManagerStatus(readyClient);
  void startMealNotificationScheduler(readyClient).catch((error) => {
    console.error("Failed to start meal notification scheduler", error);
  });
  void cleanupEmptyVoiceChannelsOnStartup(readyClient).catch((error) => {
    console.error("Failed to clean up empty voice channels on startup", error);
  });
  if (config.teamSyncEnabled) {
    startTeamSync(readyClient);
  } else {
    console.log("Team sync is disabled. Set ENABLE_TEAM_SYNC=true to enable it.");
  }
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
  await sendCrewLogMessage(client, "NT-LAN Voice Manager gar offline (planlagt stopp).");
  client.destroy();
  process.exit(0);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (await handleMealPlanReplacementButton(interaction)) {
      return;
    }

    if (await handleMatRegistrationButton(interaction)) {
      return;
    }

    await handleSetNicknameButton(interaction).catch((error) => {
      console.error("Failed to handle set-nickname button", error);
    });
    return;
  }

  if (interaction.isModalSubmit()) {
    if (await handleMealPlanModalSubmit(interaction)) {
      return;
    }

    if (await handleMatRegistrationModalSubmit(interaction)) {
      return;
    }

    await handleSetNicknameModalSubmit(interaction).catch((error) => {
      console.error("Failed to handle set-nickname modal submit", error);
    });
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
});

client.on(Events.GuildMemberAdd, (member) => {
  void sendWelcomeMessage(member).catch((error) => {
    console.error("Failed to send welcome message", error);
  });
});

await client.login(config.token);