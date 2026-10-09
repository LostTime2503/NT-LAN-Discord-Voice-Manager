import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getBotText } from "../messages.js";

export const pingCommand = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Sjekk at NT-LAN Voice Manager svarer."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply(getBotText("ping.response", { ping: interaction.client.ws.ping }));
  }
};