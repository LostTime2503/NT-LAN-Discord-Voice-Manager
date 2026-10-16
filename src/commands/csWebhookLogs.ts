import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getBotText } from "../messages.js";

function formatLogTime(timestamp: Date): string {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Oslo"
  }).format(timestamp);
}

export const csWebhookLogsCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-webhook-logs")
    .setDescription("Vis de siste CS-webhook-oppsummeringene fra Crew-loggen."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    if (!guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("csWebhookLogs.notConfigured"));
      return;
    }

    try {
      const member = await guild.members.fetch(interaction.user.id);
      if (!isCrewMember(member, config.crewRoleId)) {
        await interaction.editReply(getBotText("csWebhookLogs.crewOnly"));
        return;
      }
      if (!config.crewLogChannelId) {
        await interaction.editReply(getBotText("csWebhookLogs.channelMissing"));
        return;
      }

      const channel = await guild.channels.fetch(config.crewLogChannelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.editReply(getBotText("csWebhookLogs.channelInvalid"));
        return;
      }
      const botMember = await guild.members.fetchMe();
      const permissions = channel.permissionsFor(botMember);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        await interaction.editReply(getBotText("csWebhookLogs.permissions"));
        return;
      }

      const messages = await channel.messages.fetch({ limit: 100 });
      const entries = messages
        .filter(message => message.author.id === interaction.client.user?.id
          && message.content.startsWith("CS webhook "))
        .first(8)
        .reverse();
      if (!entries.length) {
        await interaction.editReply(getBotText("csWebhookLogs.empty"));
        return;
      }

      const lines = [getBotText("csWebhookLogs.title"), ...entries.map(message =>
        `${formatLogTime(message.createdAt)} · ${message.content}`
      )];
      await interaction.editReply({
        content: lines.join("\n").slice(0, 1_900),
        allowedMentions: { parse: [] }
      });
    } catch {
      await interaction.editReply(getBotText("csWebhookLogs.failed"));
    }
  }
};
