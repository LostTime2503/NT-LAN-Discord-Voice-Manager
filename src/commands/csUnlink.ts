import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { manualOverrideStore } from "../manualOverrides.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { getBotText } from "../messages.js";

export const csUnlinkCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-unlink")
    .setDescription("Fjern en manuell Discord-til-Steam-kobling for CS.")
    .addUserOption(option => option.setName("person").setDescription("Discord-medlemmet som skal kobles fra.").setRequired(true)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("csUnlink.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("csUnlink.crewOnly"));
        return;
      }
      const user = interaction.options.getUser("person", true);
      const removed = await manualOverrideStore.unlinkCsPlayer(user.id);
      if (removed) void sendCrewLogMessage(interaction.client, getBotText("cs.linkRemoved", {}, "logs"));
      await interaction.editReply(removed
        ? getBotText("csUnlink.removed", { userId: user.id })
        : getBotText("csUnlink.notFound", { userId: user.id }));
    } catch (error) {
      await interaction.editReply(getBotText("csUnlink.failed"));
    }
  }
};