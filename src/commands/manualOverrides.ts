import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { manualOverrideStore } from "../manualOverrides.js";
import { getBotText } from "../messages.js";

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat("nb-NO", { dateStyle: "short", timeStyle: "short" }).format(timestamp) : "ukjent tid";
}

export const manualOverridesCommand = {
  data: new SlashCommandBuilder()
    .setName("manual-overrides")
    .setDescription("Vis hvem som ga manuell tilgang eller Steam-kobling."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.reply({ content: "Manuelle overstyringer er ikke konfigurert for denne serveren.", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.reply({ content: "Bare Crew og høyere kan se manuelle overstyringer.", flags: MessageFlags.Ephemeral });
        return;
      }
      const overrides = await manualOverrideStore.listManualOverrides();
      const lines = ["**Manuell servertilgang**"];
      lines.push(...(overrides.access.length
        ? overrides.access.map(item => `<@${item.discordId}> · gitt av <@${item.grantedBy}> · ${formatTime(item.grantedAt)}`)
        : ["Ingen manuelle tilgangsoverstyringer."]));
      lines.push("", "**Manuelle CS Steam-koblinger**");
      lines.push(...(overrides.csLinks.length
        ? overrides.csLinks.map(item => `<@${item.discordId}> · koblet av <@${item.linkedBy}> · ${formatTime(item.linkedAt)}`)
        : ["Ingen manuelle CS-koblinger."]));
      const chunks: string[] = [];
      let current = "";
      for (const line of lines) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length > 1_800) { chunks.push(current); current = line; }
        else current = next;
      }
      if (current) chunks.push(current);
      await interaction.reply({ content: chunks[0] ?? "Ingen overstyringer.", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch {
      await interaction.reply({ content: getBotText("giveAccess.failed"), flags: MessageFlags.Ephemeral });
    }
  }
};
