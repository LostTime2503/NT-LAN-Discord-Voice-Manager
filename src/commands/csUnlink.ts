import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { manualOverrideStore } from "../manualOverrides.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { getBotText } from "../messages.js";

export const csUnlinkCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-unlink")
    .setDescription("Fjern en manuell Discord-til-Steam-kobling for CS.")
    .addUserOption(option => option.setName("person").setDescription("Discord-medlemmet som skal kobles fra.").setRequired(true))
    .addBooleanOption(option => option.setName("behold_rolle").setDescription("Behold manuell CS-deltakerrolle. Standard er ja.")),

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
      const keepRole = interaction.options.getBoolean("behold_rolle") ?? true;
      const linkExists = (await manualOverrideStore.listManualOverrides()).csLinks.some(link => link.discordId === user.id);
      if (!linkExists) {
        await interaction.editReply(getBotText("csUnlink.notFound", { userId: user.id }));
        return;
      }
      const target = keepRole ? undefined : await interaction.guild.members.fetch(user.id);
      const manualRoleId = config.manualCsParticipantRoleId;
      let roleStatus = "beholdt";
      if (!keepRole) {
        roleStatus = "ikke konfigurert eller allerede fraværende";
        if (manualRoleId && target?.roles.cache.has(manualRoleId)) {
          const role = await interaction.guild.roles.fetch(manualRoleId);
          const bot = await interaction.guild.members.fetchMe();
          if (!role || role.managed || !bot.permissions.has(PermissionFlagsBits.ManageRoles)
            || bot.roles.highest.comparePositionTo(role) <= 0
            || target.roles.highest.comparePositionTo(bot.roles.highest) >= 0) {
            await interaction.editReply(getBotText("csUnlink.cannotRemoveRole"));
            return;
          }
          await target.roles.remove(role, "Crew removed manual CS role during /cs-unlink");
          roleStatus = "fjernet";
        }
      }
      const removed = await manualOverrideStore.unlinkCsPlayer(user.id);
      if (removed) void sendCrewLogMessage(interaction.client, getBotText("cs.linkRemoved", {}, "logs"));
      await interaction.editReply(removed
        ? getBotText("csUnlink.removed", { userId: user.id, roleStatus })
        : getBotText("csUnlink.notFound", { userId: user.id }));
    } catch (error) {
      await interaction.editReply(getBotText("csUnlink.failed"));
    }
  }
};