import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getBotText } from "../messages.js";

const guideFooter = "ntlan-crew-help-guide";

export const setupCrewHelpCommand = {
  data: new SlashCommandBuilder()
    .setName("set-up-crew-help")
    .setDescription("Publiser eller oppdater Crew-guiden for NT-LAN Voice Manager.")
    .addChannelOption(option => option.setName("kanal").setDescription("Crew-kanal. Standard er CREW_LOG_CHANNEL_ID.")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    if (!guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("crewHelp.setup.notConfigured"));
      return;
    }

    try {
      const actor = await guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("crewHelp.setup.crewOnly"));
        return;
      }

      const selectedChannel = interaction.options.getChannel("kanal");
      const channelId = selectedChannel?.id ?? config.crewLogChannelId;
      if (!channelId) {
        await interaction.editReply(getBotText("crewHelp.setup.notConfigured"));
        return;
      }
      const channel = await guild.channels.fetch(channelId);
      if (!channel || channel.guildId !== guild.id
        || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        await interaction.editReply(getBotText("crewHelp.setup.channelInvalid"));
        return;
      }

      const botMember = await guild.members.fetchMe();
      const permissions = channel.permissionsFor(botMember);
      if (!permissions?.has([
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory
      ])) {
        await interaction.editReply(getBotText("crewHelp.setup.permissions"));
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(getBotText("crewHelp.announcementTitle"))
        .setDescription(getBotText("crewHelp.announcement"))
        .setColor(0x2f855a)
        .setFooter({ text: guideFooter });
      const messages = await channel.messages.fetch({ limit: 100 });
      const existing = messages.find(message => message.author.id === interaction.client.user?.id
        && message.embeds.some(item => item.footer?.text === guideFooter));
      if (existing) {
        await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } });
        await interaction.editReply(getBotText("crewHelp.setup.updated", { channelId: channel.id }));
      } else {
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        await interaction.editReply(getBotText("crewHelp.setup.posted", { channelId: channel.id }));
      }
    } catch {
      await interaction.editReply(getBotText("crewHelp.setup.failed"));
    }
  }
};
