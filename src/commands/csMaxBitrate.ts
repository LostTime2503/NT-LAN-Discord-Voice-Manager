import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getCsVoiceRoomsNeedingBitrateUpdate } from "../discordCsVoiceAdapter.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { consumeCommandPreview, issueCommandPreview } from "../commandPreviews.js";
import { getBotText } from "../messages.js";

function previewResources(maximumBitrate: number, channelIds: string[]): string[] {
  return [`maximum-bitrate:${maximumBitrate}`, ...channelIds];
}

export const csMaxBitrateCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-max-bitrate")
    .setDescription("Forhåndsvis eller sett maks bitrate på voice-rom i CS-kategorien.")
    .addBooleanOption(option => option.setName("bekreft").setDescription("Sett de viste kanalene til serverens maksbitrate."))
    .addStringOption(option => option.setName("previewkode").setDescription("Engangskode fra forhåndsvisningen.").setMaxLength(8)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    if (!guild || interaction.guildId !== config.guildId || !config.crewRoleId || !config.csCategoryId) {
      await interaction.editReply(getBotText("csMaxBitrate.notConfigured"));
      return;
    }

    try {
      const actor = await guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("csMaxBitrate.crewOnly"));
        return;
      }
      const category = await guild.channels.fetch(config.csCategoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        await interaction.editReply(getBotText("csMaxBitrate.categoryMissing"));
        return;
      }

      const maximumBitrate = guild.maximumBitrate;
      const voiceRooms = [...category.children.cache.values()]
        .filter(channel => channel.type === ChannelType.GuildVoice);
      const changes = getCsVoiceRoomsNeedingBitrateUpdate(voiceRooms, maximumBitrate);
      if (!changes.length) {
        await interaction.editReply(getBotText("csMaxBitrate.alreadyCurrent", {
          count: voiceRooms.length,
          bitrate: Math.round(maximumBitrate / 1_000)
        }));
        return;
      }

      const resources = previewResources(maximumBitrate, changes.map(channel => channel.id));
      if (!interaction.options.getBoolean("bekreft")) {
        const previewCode = issueCommandPreview("cs-max-bitrate", guild.id, interaction.user.id, resources);
        const channels = changes.map(channel =>
          `• <#${channel.id}>: ${Math.round(channel.bitrate / 1_000)} → ${Math.round(maximumBitrate / 1_000)} kbps`
        ).join("\n");
        await interaction.editReply({
          content: getBotText("csMaxBitrate.preview", {
            count: changes.length,
            bitrate: Math.round(maximumBitrate / 1_000),
            channels,
            previewCode
          }),
          allowedMentions: { parse: [] }
        });
        return;
      }

      const previewCode = interaction.options.getString("previewkode") ?? "";
      if (!consumeCommandPreview(previewCode, "cs-max-bitrate", guild.id, interaction.user.id, resources)) {
        await interaction.editReply(getBotText("csMaxBitrate.previewExpired"));
        return;
      }
      const bot = await guild.members.fetchMe();
      if (!bot.permissionsIn(category).has(PermissionFlagsBits.ManageChannels)) {
        await interaction.editReply(getBotText("csMaxBitrate.noPermission"));
        return;
      }

      let updated = 0;
      let failed = 0;
      for (const channel of changes) {
        try {
          await channel.setBitrate(maximumBitrate, "Crew confirmed maximum bitrate for CS voice channels");
          updated += 1;
        } catch {
          failed += 1;
        }
      }
      void sendCrewLogMessage(interaction.client, getBotText("cs.maxBitrate", {
        updated,
        failed,
        bitrate: Math.round(maximumBitrate / 1_000)
      }, "logs"));
      await interaction.editReply(getBotText("csMaxBitrate.complete", {
        updated,
        failed,
        bitrate: Math.round(maximumBitrate / 1_000)
      }));
    } catch {
      await interaction.editReply(getBotText("csMaxBitrate.failed"));
    }
  }
};
