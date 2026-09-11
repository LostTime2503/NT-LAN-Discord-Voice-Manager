import {
  type CategoryChannel,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type VoiceChannel
} from "discord.js";

const VOICE_CATEGORY_NAME = "–KANALER";
const CS_TEAM_CATEGORY_NAME = "–CS LAG";
const JOIN_TO_CREATE_CHANNEL_NAME = "Lag ny kanal her";
const OLD_JOIN_TO_CREATE_CHANNEL_NAME = "Opprett talekanal";

export const setupVoiceManagerCommand = {
  data: new SlashCommandBuilder()
    .setName("setup-voice-manager")
    .setDescription("Opprett den permanente Opprett talekanal-kanalen.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({ content: "Denne kommandoen kan bare brukes pa en server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const voiceCategory = await ensureCategory(interaction.guild, VOICE_CATEGORY_NAME);
    const csTeamCategory = await ensureCategory(interaction.guild, CS_TEAM_CATEGORY_NAME);
    const existingChannel = findJoinToCreateChannel(interaction.guild);

    if (existingChannel) {
      await existingChannel.edit({
        name: JOIN_TO_CREATE_CHANNEL_NAME,
        parent: voiceCategory.id,
        reason: "Configure NT-LAN Voice Manager join-to-create channel"
      });

      await interaction.reply({
        content: createSetupMessage(existingChannel.id, csTeamCategory.id),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const channel = await interaction.guild.channels.create({
      name: JOIN_TO_CREATE_CHANNEL_NAME,
      type: ChannelType.GuildVoice,
      parent: voiceCategory.id,
      reason: "Create NT-LAN Voice Manager join-to-create channel"
    });

    await interaction.reply({
      content: createSetupMessage(channel.id, csTeamCategory.id),
      flags: MessageFlags.Ephemeral
    });
  }
};

async function ensureCategory(guild: Guild, name: string): Promise<CategoryChannel> {
  const existingCategory = guild.channels.cache.find(
    (channel): channel is CategoryChannel => channel.name === name && channel.type === ChannelType.GuildCategory
  );

  if (existingCategory) {
    return existingCategory;
  }

  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: "Create NT-LAN Voice Manager category"
  });

  if (category.type !== ChannelType.GuildCategory) {
    throw new Error(`Created channel ${name}, but it was not a category.`);
  }

  return category;
}

function findJoinToCreateChannel(guild: Guild): VoiceChannel | undefined {
  return guild.channels.cache.find(
    (channel): channel is VoiceChannel =>
      channel.type === ChannelType.GuildVoice &&
      (channel.name === JOIN_TO_CREATE_CHANNEL_NAME || channel.name === OLD_JOIN_TO_CREATE_CHANNEL_NAME)
  );
}

function createSetupMessage(joinToCreateChannelId: string, csTeamCategoryId: string): string {
  return [
    "Voice manager er satt opp.",
    "Legg disse verdiene i .env:",
    `JOIN_TO_CREATE_CHANNEL_ID=${joinToCreateChannelId}`,
    `CS_TEAM_CATEGORY_ID=${csTeamCategoryId}`
  ].join("\n");
}