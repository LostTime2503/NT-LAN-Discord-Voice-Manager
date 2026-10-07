import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { findCommand } from "./commands/index.js";
import { config } from "./config.js";
import { sendCrewLogMessage } from "./crewLog.js";
import { ACCESS_BUTTON_ID, FAMILY_PARENT_BUTTON_ID, FAMILY_CHILD_BUTTON_ID, startAccessSync } from "./accessManager.js";
import { accessInitializationError, accessManager, familyStore } from "./accessRuntime.js";
import { FamilyAccessFlow } from "./familyAccess.js";
import { cleanupEmptyVoiceChannelsOnStartup, handleVoiceStateUpdate, logVoiceManagerStatus } from "./voiceManager.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, ...(accessManager ? [GatewayIntentBits.GuildMembers] : [])]
});
const familyAccessFlow = (() => {
  const manager = accessManager;
  return manager ? new FamilyAccessFlow(manager, familyStore, () => manager.getRegistrationSnapshot(), client) : undefined;
})();

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
  if (interaction.isButton() && interaction.customId.startsWith("family:")) {
    if (familyAccessFlow) {
      await familyAccessFlow.handleButton(interaction).catch((error) => {
        const content = error instanceof Error ? error.message : "Familiehandlingen kunne ikke fullfores.";
        if (interaction.deferred || interaction.replied) void interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        else void interaction.reply({ content, flags: MessageFlags.Ephemeral });
      });
    }
    return;
  }
  if (interaction.isButton() && [FAMILY_PARENT_BUTTON_ID, FAMILY_CHILD_BUTTON_ID].includes(interaction.customId)) {
    if (accessManager) {
      await familyAccessFlow?.handleButton(interaction).catch((error) => {
        const content = error instanceof Error ? error.message : "Familiehandlingen kunne ikke fullfores.";
        if (interaction.deferred || interaction.replied) void interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        else void interaction.reply({ content, flags: MessageFlags.Ephemeral });
      });
    } else {
      await interaction.reply({ content: "Familietilgang er ikke konfigurert.", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("family:")) {
    if (!familyAccessFlow) return;
    await familyAccessFlow.handleStringSelect(interaction).catch((error) => {
      const content = error instanceof Error ? error.message : "Familiehandlingen kunne ikke fullfores.";
      if (interaction.deferred || interaction.replied) void interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else void interaction.reply({ content, flags: MessageFlags.Ephemeral });
    });
    return;
  }
  if (interaction.isUserSelectMenu() && interaction.customId.startsWith("family:")) {
    if (!familyAccessFlow) return;
    await familyAccessFlow.handleUserSelect(interaction).catch((error) => {
      const content = error instanceof Error ? error.message : "Familiehandlingen kunne ikke fullfores.";
      if (interaction.deferred || interaction.replied) void interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else void interaction.reply({ content, flags: MessageFlags.Ephemeral });
    });
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("family:")) {
    if (!familyAccessFlow) return;
    await familyAccessFlow.handleModal(interaction).catch((error) => {
      const content = error instanceof Error ? error.message : "Familiehandlingen kunne ikke fullfores.";
      if (interaction.deferred || interaction.replied) void interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else void interaction.reply({ content, flags: MessageFlags.Ephemeral });
    });
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
});

client.on(Events.GuildMemberAdd, (member) => {
  if (!accessManager || member.guild.id !== config.guildId || member.user.bot) return;
  void familyAccessFlow?.handleJoin(member).catch(() => console.error("Family invite matching failed."));
  void accessManager.check(member).catch(() => console.error("Access check failed for a joining member."));
});

await client.login(config.token);