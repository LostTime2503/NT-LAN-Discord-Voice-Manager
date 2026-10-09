import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { accessManager } from "../accessRuntime.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { getBotSettingsController } from "../botSettingsController.js";
import { getBotText } from "../messages.js";

export const clearAccessOverrideCommand = {
  data: new SlashCommandBuilder()
    .setName("clearaccessoverride")
    .setDescription("Fjern manuell tilgang og la automatisk sync avgjøre tilgangen igjen.")
    .addUserOption(option => option.setName("person").setDescription("Medlemmet som skal fjernes fra overstyringen.").setRequired(true))
    .addBooleanOption(option => option.setName("bekreft").setDescription("Bekreft at den manuelle rollen skal fjernes.").setRequired(true)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || !accessManager || interaction.guildId !== accessManager.settings.guildId) {
      await interaction.editReply(getBotText("clearAccessOverride.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, accessManager.settings.crewRoleId)) {
        await interaction.editReply(getBotText("clearAccessOverride.crewOnly"));
        return;
      }
      const user = interaction.options.getUser("person", true);
      const target = await interaction.guild.members.fetch(user.id);
      if (!interaction.options.getBoolean("bekreft", true)) {
        await interaction.editReply(getBotText("clearAccessOverride.confirm"));
        return;
      }
      const automaticSyncEnabled = getBotSettingsController()?.getSettings().access ?? true;
      const removed = await accessManager.clearManualAccess(target, true, automaticSyncEnabled);
      if (removed) void sendCrewLogMessage(interaction.client, getBotText("access.manualCleared", {}, "logs"));
      await interaction.editReply(removed
        ? getBotText("clearAccessOverride.removed", { userId: target.id })
        : getBotText("clearAccessOverride.notFound", { userId: target.id }));
    } catch (error) {
      await interaction.editReply(getBotText("clearAccessOverride.failed"));
    }
  }
};