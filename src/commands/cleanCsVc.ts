import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { consumeCommandPreview, issueCommandPreview } from "../commandPreviews.js";
import { getBotText } from "../messages.js";

export const cleanCsVcCommand = {
  data: new SlashCommandBuilder()
    .setName("clean-cs-vc")
    .setDescription("Forhåndsvis eller slett voice-rom i CS-kategorien.")
    .addBooleanOption(option => option.setName("bekreft").setDescription("Bekreft sletting av de viste rommene."))
    .addStringOption(option => option.setName("previewkode").setDescription("Engangskode fra forhåndsvisningen.").setMaxLength(8)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId || !config.csCategoryId) {
      await interaction.editReply(getBotText("cleanCsVc.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("cleanCsVc.crewOnly"));
        return;
      }
      const category = await interaction.guild.channels.fetch(config.csCategoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        await interaction.editReply(getBotText("cleanCsVc.categoryMissing"));
        return;
      }
      const rooms = [...category.children.cache.values()].filter(channel =>
        channel.type === ChannelType.GuildVoice && channel.id !== config.csLobbyChannelId);
      const roomIds = rooms.map(room => room.id);
      const names = rooms.map(channel => `• ${channel.name}`).join("\n");
      if (!interaction.options.getBoolean("bekreft")) {
        const previewCode = issueCommandPreview("clean-cs-vc", interaction.guildId, interaction.user.id, roomIds);
        await interaction.editReply(rooms.length
          ? getBotText("cleanCsVc.preview", { count: rooms.length, rooms: names || "", previewCode })
          : getBotText("cleanCsVc.empty"));
        return;
      }
      const previewCode = interaction.options.getString("previewkode") ?? "";
      if (!consumeCommandPreview(previewCode, "clean-cs-vc", interaction.guildId, interaction.user.id, roomIds)) {
        await interaction.editReply(getBotText("cleanCsVc.previewExpired"));
        return;
      }
      const bot = await interaction.guild.members.fetchMe();
      if (!bot.permissionsIn(category).has(PermissionFlagsBits.ManageChannels)) {
        await interaction.editReply(getBotText("cleanCsVc.noPermission"));
        return;
      }
      for (const room of rooms) await room.delete("Crew confirmed CS voice cleanup");
      await sendCrewLogMessage(interaction.client, getBotText("cs.roomsCleaned", { count: rooms.length }, "logs"));
      await interaction.editReply(getBotText("cleanCsVc.complete", { count: rooms.length }));
    } catch {
      await interaction.editReply(getBotText("cleanCsVc.failed"));
    }
  }
};