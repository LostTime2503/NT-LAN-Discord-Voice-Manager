import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getBotText, loadBotMessages } from "../messages.js";
import { sendCrewLogMessage } from "../crewLog.js";

export const reloadMessagesCommand = {
  data: new SlashCommandBuilder()
    .setName("reload-messages")
    .setDescription("Last messages.json på nytt uten å starte boten.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("reloadMessages.notConfigured"));
      return;
    }
    const actor = await interaction.guild.members.fetch(interaction.user.id);
    if (!isCrewMember(actor, config.crewRoleId)) {
      await interaction.editReply(getBotText("reloadMessages.crewOnly"));
      return;
    }
    const loaded = await loadBotMessages();
    await interaction.editReply(getBotText(loaded ? "reloadMessages.loaded" : "reloadMessages.fallback"));
    await sendCrewLogMessage(interaction.client, getBotText("messages.reloaded", { status: loaded ? "OK" : "standardtekster" }, "logs"));
  }
};