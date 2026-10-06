import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { renameTemporaryChannel } from "../voiceManager.js";

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
      await interaction.reply({ content: "Denne kommandoen kan bare brukes pa en server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const channel = member.voice.channel;

    if (!channel) {
      await interaction.reply({ content: "Du ma sta i voice-kanalen du vil endre navn pa.", flags: MessageFlags.Ephemeral });
      return;
    }

    const requestedName = interaction.options.getString("navn", true);

    try {
      const newName = await renameTemporaryChannel(channel, interaction.user.id, requestedName);
      await interaction.reply({ content: `Kanalnavnet er endret til ${newName}.`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Kunne ikke endre kanalnavnet.";
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
};