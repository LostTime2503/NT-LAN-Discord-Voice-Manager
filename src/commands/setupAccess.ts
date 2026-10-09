import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { restoreAccessPermissions } from "../accessPermissions.js";
import { getBotText } from "../messages.js";

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
      await interaction.editReply(getBotText("setupAccess.notConfigured"));
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!isCrewMember(member, accessManager.settings.crewRoleId)) {
      await interaction.editReply(getBotText("setupAccess.crewOnly"));
      return;
    }
    const restore = interaction.options.getBoolean("gjenopprett") ?? false;
    if (restore && !interaction.options.getBoolean("bekreft")) {
      await interaction.editReply(getBotText("setupAccess.confirmRestore"));
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
        ? getBotText("setupAccess.dryRun")
        : restore ? getBotText("setupAccess.restored", { count })
          : getBotText("setupAccess.published", { websiteUrl: accessManager.settings.websiteUrl }));
    } catch (error) {
      console.error(getBotText("setupAccess.failed", {}, "logs"));
      await interaction.editReply(getBotText("setupAccess.failed"));
    }
  }
};