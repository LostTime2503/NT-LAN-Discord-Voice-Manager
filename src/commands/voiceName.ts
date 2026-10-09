import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getBotText } from "../messages.js";

export const voiceNameCommand = {
  data: new SlashCommandBuilder()
    .setName("voice-name")
    .setDescription("Endre navn pa din midlertidige voice-kanal.")
    .addStringOption((option) =>
      option
        .setName("navn")
        .setDescription("Nytt kanalnavn")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(80)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({ content: getBotText("voiceName.guildOnly"), flags: MessageFlags.Ephemeral });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const channel = member.voice.channel;

    if (!channel) {
      await interaction.reply({ content: getBotText("voiceName.notInVoice"), flags: MessageFlags.Ephemeral });
      return;
    }

    const requestedName = interaction.options.getString("navn", true);

    try {
      const { renameTemporaryChannel } = await import("../voiceManager.js");
      const newName = await renameTemporaryChannel(channel, interaction.user.id, requestedName);
      await interaction.reply({ content: getBotText("voiceName.changed", { channelName: newName }), flags: MessageFlags.Ephemeral });
    } catch (error) {
      const knownErrors = new Set([
        getBotText("voiceName.notTemporary"),
        getBotText("voiceName.notOwner"),
        getBotText("voiceName.ownerUnknown"),
        getBotText("voiceName.empty")
      ]);
      const message = error instanceof Error && knownErrors.has(error.message)
        ? error.message : getBotText("voiceName.failed");
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
};