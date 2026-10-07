import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";

export const setupFamilyAccessCommand = {
  data: new SlashCommandBuilder()
    .setName("setup-family-access")
    .setDescription("Publiser familietilgangsmeldingen med foresatt- og barneknapper.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { accessManager } = await import("../accessRuntime.js");
    if (!accessManager || !interaction.guild || interaction.guildId !== accessManager.settings.guildId) {
      await interaction.editReply("Tilgangskontrollen er ikke konfigurert for denne serveren.");
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!isCrewMember(member, accessManager.settings.crewRoleId)) {
      await interaction.editReply("Bare Crew og hoyere kan bruke denne kommandoen.");
      return;
    }
    try {
      await accessManager.publishFamilyEntry(interaction.guild);
      await interaction.editReply(accessManager.settings.dryRun
        ? "Torrkjoring fullfort. Ingen familietilgangsmelding eller kanalrettigheter er endret."
        : "Familietilgangsmeldingen er publisert. Knappene starter privat kobling/godkjenning; kanalrettighetene er ikke endret.");
    } catch (error) {
      console.error("Family access setup failed; check the configured channel and bot permissions.");
      await interaction.editReply(error instanceof Error ? error.message : "Kunne ikke publisere familietilgangsmeldingen.");
    }
  }
};