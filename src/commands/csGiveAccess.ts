import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { getBotText } from "../messages.js";

export const csGiveAccessCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-giveaccess")
    .setDescription("Gi eller fjern manuell tilgang til CS-konkurranserommene.")
    .addUserOption(option => option.setName("person").setDescription("Medlemmet som skal endres.").setRequired(true))
    .addStringOption(option => option.setName("handling").setDescription("Velg om manuell CS-tilgang skal gis eller fjernes.").setRequired(true)
      .addChoices({ name: "Gi manuell CS-tilgang", value: "grant" }, { name: "Fjern manuell CS-tilgang", value: "revoke" })),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.manualCsParticipantRoleId || !config.crewRoleId) {
      await interaction.editReply(getBotText("csGiveAccess.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("csGiveAccess.crewOnly"));
        return;
      }
      const target = await interaction.guild.members.fetch(interaction.options.getUser("person", true).id);
      const role = await interaction.guild.roles.fetch(config.manualCsParticipantRoleId);
      const bot = await interaction.guild.members.fetchMe();
      if (target.user.bot || !role || role.managed || role.id === interaction.guild.id
        || !bot.permissions.has(PermissionFlagsBits.ManageRoles)
        || bot.roles.highest.comparePositionTo(role) <= 0
        || target.roles.highest.comparePositionTo(bot.roles.highest) >= 0) {
        await interaction.editReply(getBotText("csGiveAccess.cannotManage"));
        return;
      }
      const grant = interaction.options.getString("handling", true) === "grant";
      const alreadyHasRole = target.roles.cache.has(role.id);
      if (grant && !alreadyHasRole) await target.roles.add(role, "Crew manually granted CS competition access");
      if (!grant && alreadyHasRole) await target.roles.remove(role, "Crew manually revoked CS competition access");
      await sendCrewLogMessage(interaction.client, getBotText("cs.manualAccess", { action: grant ? "gitt" : "fjernet" }, "logs"));
      await interaction.editReply(getBotText("csGiveAccess.complete", {
        action: grant ? "gitt til" : "fjernet fra",
        userId: target.id
      }));
    } catch {
      await interaction.editReply(getBotText("csGiveAccess.failed"));
    }
  }
};