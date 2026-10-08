import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { accessManager } from "../accessRuntime.js";

export const clearAccessOverrideCommand = {
  data: new SlashCommandBuilder()
    .setName("clearaccessoverride")
    .setDescription("Fjern manuell tilgang og la automatisk sync avgjøre tilgangen igjen.")
    .addUserOption(option => option.setName("person").setDescription("Medlemmet som skal fjernes fra overstyringen.").setRequired(true)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || !accessManager || interaction.guildId !== accessManager.settings.guildId) {
      await interaction.editReply("Manuelle access-overrides er ikke konfigurert for denne serveren.");
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, accessManager.settings.crewRoleId)) {
        await interaction.editReply("Bare Crew og høyere kan fjerne manuelle access-overrides.");
        return;
      }
      const user = interaction.options.getUser("person", true);
      const target = await interaction.guild.members.fetch(user.id);
      const removed = await accessManager.clearManualAccess(target);
      await interaction.editReply(removed
        ? `Manuell overstyring fjernet for <@${target.id}>. Automatisk sync har fått kontrollen tilbake.`
        : `Fant ingen manuell overstyring for <@${target.id}>.`);
    } catch (error) {
      await interaction.editReply(error instanceof Error ? error.message : "Kunne ikke fjerne overstyringen.");
    }
  }
};