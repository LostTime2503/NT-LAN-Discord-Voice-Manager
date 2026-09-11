import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { findCommand } from "./commands/index.js";
import { config } from "./config.js";
import { sendCrewLogMessage } from "./crewLog.js";
import { cleanupEmptyVoiceChannelsOnStartup, handleVoiceStateUpdate, logVoiceManagerStatus } from "./voiceManager.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
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
  await sendCrewLogMessage(client, "NT-LAN Voice Manager gar offline (planlagt stopp).");
  client.destroy();
  process.exit(0);
}

client.on(Events.InteractionCreate, async (interaction) => {
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

await client.login(config.token);