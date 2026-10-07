import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { findCommand } from "./commands/index.js";
import { config } from "./config.js";
import { sendCrewLogMessage } from "./crewLog.js";
import { ACCESS_BUTTON_ID, startAccessSync } from "./accessManager.js";
import { accessInitializationError, accessManager } from "./accessRuntime.js";
import { cleanupEmptyVoiceChannelsOnStartup, handleVoiceStateUpdate, logVoiceManagerStatus } from "./voiceManager.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, ...(accessManager ? [GatewayIntentBits.GuildMembers] : [])]
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

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  logVoiceManagerStatus(readyClient);
  if (accessInitializationError) {
    console.error(`Access sync paused: ${accessInitializationError} Existing voice channels remain unchanged; new channel creation is blocked until configuration is fixed.`);
  }
  if (accessManager) {
    await startAccessSync(accessManager, readyClient);
  }
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
  await sendCrewLogMessage(client, "NT-LAN Voice Manager gar offline (planlagt stopp).");
  client.destroy();
  process.exit(0);
}

client.on(Events.InteractionCreate, async (interaction) => {
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