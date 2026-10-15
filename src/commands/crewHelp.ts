import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getBotText } from "../messages.js";

export const crewHelpCommand = {
  data: new SlashCommandBuilder()
    .setName("crew-help")
    .setDescription("Vis Crew en privat oversikt over botkommandoer."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.reply({ content: "Crew-oversikten er ikke konfigurert for denne serveren.", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(member, config.crewRoleId)) {
        await interaction.reply({ content: "Bare Crew og høyere kan se denne oversikten.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ content: getBotText("crewHelp.message"), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch {
      if (!interaction.replied) await interaction.reply({ content: "Kunne ikke vise Crew-oversikten.", flags: MessageFlags.Ephemeral });
    }
  }
};
