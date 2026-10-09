import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { manualOverrideStore } from "../manualOverrides.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { getBotText } from "../messages.js";

export const csLinkCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-link")
    .setDescription("Koble et Discord-medlem til Steam-ID for CS-turneringen.")
    .addUserOption(option => option.setName("person").setDescription("Discord-medlemmet.").setRequired(true))
    .addStringOption(option => option.setName("steamid64").setDescription("Spillerens 17-sifrede SteamID64.").setRequired(true).setMinLength(17).setMaxLength(17)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.manualCsParticipantRoleId || !config.crewRoleId) {
      await interaction.editReply(getBotText("csLink.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("csLink.crewOnly"));
        return;
      }
      const user = interaction.options.getUser("person", true);
      const target = await interaction.guild.members.fetch(user.id);
      const steamId = interaction.options.getString("steamid64", true).trim();
      if (target.user.bot || !/^7656119\d{10}$/.test(steamId)) {
        await interaction.editReply(getBotText("csLink.invalidInput"));
        return;
      }

      const role = await interaction.guild.roles.fetch(config.manualCsParticipantRoleId);
      const bot = await interaction.guild.members.fetchMe();
      if (!role || role.managed || !bot.permissions.has(PermissionFlagsBits.ManageRoles)
        || bot.roles.highest.comparePositionTo(role) <= 0
        || target.roles.highest.comparePositionTo(bot.roles.highest) >= 0) {
        await interaction.editReply(getBotText("csLink.cannotManage"));
        return;
      }

      const alreadyHadRole = target.roles.cache.has(role.id);
      if (!alreadyHadRole) await target.roles.add(role, "Crew granted manual CS participation access");
      try {
        await manualOverrideStore.linkCsPlayer(target.id, steamId, actor.id);
      } catch (error) {
        if (!alreadyHadRole) await target.roles.remove(role, "Manual CS access could not be stored").catch(() => undefined);
        throw error;
      }
      await interaction.editReply(getBotText("csLink.complete", { userId: target.id }));
      void sendCrewLogMessage(interaction.client, getBotText("cs.linkCreated", {}, "logs"));
    } catch (error) {
      await interaction.editReply(getBotText("csLink.failed"));
    }
  }
};