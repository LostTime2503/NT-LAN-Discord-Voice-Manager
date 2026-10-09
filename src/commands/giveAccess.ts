import { MessageFlags, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { accessManager } from "../accessRuntime.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { getBotText } from "../messages.js";

export const giveAccessCommand = {
  data: new SlashCommandBuilder()
    .setName("giveaccess")
    .setDescription("Gi et medlem manuell servertillatelse og valgt kallenavn.")
    .addStringOption(option => option.setName("person").setDescription("Søk etter et medlem uten access-rolle.").setRequired(true).setAutocomplete(true))
    .addStringOption(option => option.setName("kallenavn").setDescription("Kallenavnet boten skal beholde.").setRequired(true).setMinLength(1).setMaxLength(32))
    .addBooleanOption(option => option.setName("bekreft").setDescription("Bekreft endring av kallenavn og manuell tilgang.").setRequired(true)),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (!interaction.guild || !accessManager || interaction.guildId !== accessManager.settings.guildId) {
      await interaction.respond([]);
      return;
    }
    const settings = accessManager.settings;
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, settings.crewRoleId)) {
        await interaction.respond([]);
        return;
      }
      const query = interaction.options.getFocused().trim().toLocaleLowerCase("nb-NO");
      const members = query.length >= 2
        ? await interaction.guild.members.search({ query, limit: 100 })
        : interaction.guild.members.cache.size >= interaction.guild.memberCount
          ? interaction.guild.members.cache
          : await interaction.guild.members.fetch();
      const candidates = [...members.values()]
        .filter(member => !member.user.bot && !member.roles.cache.has(settings.accessRoleId)
          && !member.roles.cache.has(settings.manualAccessRoleId)
          && !isCrewMember(member, settings.crewRoleId))
        .filter(member => `${member.displayName} ${member.user.username}`.toLocaleLowerCase("nb-NO").includes(query))
        .slice(0, 25)
        .map(member => ({
          name: `${member.displayName} (@${member.user.username})`.slice(0, 100),
          value: member.id
        }));
      await interaction.respond(candidates);
    } catch {
      await interaction.respond([]).catch(() => undefined);
    }
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || !accessManager || interaction.guildId !== accessManager.settings.guildId) {
      await interaction.editReply(getBotText("giveAccess.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, accessManager.settings.crewRoleId)) {
        await interaction.editReply(getBotText("giveAccess.crewOnly"));
        return;
      }
      const targetId = interaction.options.getString("person", true);
      if (!/^\d{17,20}$/.test(targetId)) {
        await interaction.editReply(getBotText("giveAccess.invalidMember"));
        return;
      }
      const target = await interaction.guild.members.fetch({ user: targetId, force: true });
      if (target.user.bot) throw new Error(getBotText("giveAccess.botTarget"));
      if (target.roles.cache.has(accessManager.settings.accessRoleId)) {
        throw new Error(getBotText("giveAccess.websiteRoleExists"));
      }
      if (target.roles.cache.has(accessManager.settings.manualAccessRoleId)) {
        throw new Error(getBotText("giveAccess.manualRoleExists"));
      }
      if (isCrewMember(target, accessManager.settings.crewRoleId)) {
        throw new Error(getBotText("giveAccess.exempt"));
      }
      const nickname = interaction.options.getString("kallenavn", true);
      if (!interaction.options.getBoolean("bekreft", true)) {
        await interaction.editReply(getBotText("giveAccess.confirm"));
        return;
      }
      await accessManager.grantManualAccess(target, nickname, actor.id, true);
      await sendCrewLogMessage(interaction.client, getBotText("access.manualGranted", {}, "logs"));
      await interaction.editReply(getBotText("giveAccess.complete", { nickname, userId: target.id }));
    } catch (error) {
      const knownMessages = new Set([
        getBotText("giveAccess.botTarget"),
        getBotText("giveAccess.websiteRoleExists"),
        getBotText("giveAccess.manualRoleExists"),
        getBotText("giveAccess.exempt")
      ]);
      await interaction.editReply(error instanceof Error && knownMessages.has(error.message)
        ? error.message : getBotText("giveAccess.failed"));
    }
  }
};