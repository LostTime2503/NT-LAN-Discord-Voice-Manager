import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { manualOverrideStore } from "../manualOverrides.js";

export const csUnlinkCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-unlink")
    .setDescription("Fjern en manuell Discord-til-Steam-kobling for CS.")
    .addUserOption(option => option.setName("person").setDescription("Discord-medlemmet som skal kobles fra.").setRequired(true)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply("CS-link er ikke konfigurert for denne serveren.");
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply("Bare Crew og høyere kan fjerne CS-lenker.");
        return;
      }
      const user = interaction.options.getUser("person", true);
      const removed = await manualOverrideStore.unlinkCsPlayer(user.id);
      await interaction.editReply(removed
        ? `Den manuelle Steam-koblingen for <@${user.id}> er fjernet. CS-rollen endres ikke.`
        : `Fant ingen manuell CS-kobling for <@${user.id}>.`);
    } catch (error) {
      await interaction.editReply(error instanceof Error ? error.message : "Kunne ikke fjerne CS-lenken.");
    }
  }
};