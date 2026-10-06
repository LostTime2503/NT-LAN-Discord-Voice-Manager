import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { restoreAccessPermissions } from "../accessPermissions.js";

export const setupAccessCommand = {
  data: new SlashCommandBuilder()
    .setName("setup-access")
    .setDescription("Kontroller tilgang og publiser inngangsmeldingen.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((option) => option.setName("gjenopprett").setDescription("Gjenopprett kanalrettigheter fra lokal sikkerhetskopi."))
    .addBooleanOption((option) => option.setName("bekreft").setDescription("Bekreft at kanalrettigheter skal endres.")),

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
    const restore = interaction.options.getBoolean("gjenopprett") ?? false;
    if (restore && !interaction.options.getBoolean("bekreft")) {
      await interaction.editReply("Denne handlingen endrer kanalrettigheter. Bruk bekreft:true etter at oppsettet er kontrollert.");
      return;
    }
    try {
      let count = 0;
      if (restore) count = await restoreAccessPermissions(interaction.guild, accessManager);
      else {
        await accessManager.validateGuild(interaction.guild);
        await accessManager.publishEntry(interaction.guild);
      }
      await interaction.editReply(accessManager.settings.dryRun
        ? "Torrkjoring fullfort. Ingen meldinger eller kanalrettigheter endret."
        : restore ? `Rettigheter gjenopprettet for ${count} kanaler. Navn og roller er ikke tilbakestilt.`
          : "Inngangsmeldingen er publisert. Kanalrettighetene administreres manuelt i Discord og er ikke endret.");
    } catch (error) {
      console.error("Access setup failed; check configuration and access-channel permissions.");
      await interaction.editReply(error instanceof Error ? error.message : "Oppsettet feilet.");
    }
  }
};