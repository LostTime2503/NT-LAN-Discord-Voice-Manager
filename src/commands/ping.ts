import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

export const pingCommand = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Sjekk at NT-LAN Voice Manager svarer."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply(`Pong! WebSocket: ${interaction.client.ws.ping} ms`);
  }
};