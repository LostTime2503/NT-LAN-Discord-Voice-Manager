import { MessageFlags, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { accessManager } from "../accessRuntime.js";

export const giveAccessCommand = {
  data: new SlashCommandBuilder()
    .setName("giveaccess")
    .setDescription("Gi et medlem manuell servertillatelse og valgt kallenavn.")
    .addStringOption(option => option.setName("person").setDescription("Søk etter et medlem uten access-rolle.").setRequired(true).setAutocomplete(true))
    .addStringOption(option => option.setName("kallenavn").setDescription("Kallenavnet boten skal beholde.").setRequired(true).setMinLength(1).setMaxLength(32)),

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
      await interaction.editReply("Manuell tilgang er ikke konfigurert for denne serveren.");
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, accessManager.settings.crewRoleId)) {
        await interaction.editReply("Bare Crew og høyere kan gi manuell tilgang.");
        return;
      }
      const targetId = interaction.options.getString("person", true);
      if (!/^\d{17,20}$/.test(targetId)) throw new Error("Velg et medlem fra forslagene.");
      const target = await interaction.guild.members.fetch(targetId);
      if (target.user.bot || target.roles.cache.has(accessManager.settings.accessRoleId)
        || isCrewMember(target, accessManager.settings.crewRoleId)) {
        throw new Error("Medlemmet har allerede tilgang eller er unntatt fra access-sync.");
      }
      const nickname = interaction.options.getString("kallenavn", true);
      await accessManager.grantManualAccess(target, nickname, actor.id);
      await interaction.editReply(`Manuell tilgang og kallenavnet «${nickname}» er lagret for <@${target.id}>. Bruk /clearaccessoverride for å gi automatisk sync kontrollen tilbake.`);
    } catch (error) {
      await interaction.editReply(error instanceof Error ? error.message : "Kunne ikke gi manuell tilgang.");
    }
  }
};