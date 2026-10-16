import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getCsWebhookDiagnostics } from "../csWebhookDiagnostics.js";
import { getBotText } from "../messages.js";

function formatReceivedAt(timestamp: number): string {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Oslo"
  }).format(timestamp);
}

export const csWebhookCheckCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-webhook-check")
    .setDescription("Sjekk om MAT-webhooken når boten og har gyldig signatur."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("csWebhookCheck.notConfigured"));
      return;
    }
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(member, config.crewRoleId)) {
        await interaction.editReply(getBotText("csWebhookCheck.crewOnly"));
        return;
      }

      const diagnostics = await getCsWebhookDiagnostics();
      if (!diagnostics?.listening) {
        await interaction.editReply(getBotText("csWebhookCheck.notRunning"));
        return;
      }

      const lines = [getBotText("csWebhookCheck.title")];
      lines.push(diagnostics.healthCheckOk
        ? getBotText("csWebhookCheck.localHealthy")
        : getBotText("csWebhookCheck.localFailed"));
      if (diagnostics.lastTestEventAt !== null) {
        lines.push(getBotText("csWebhookCheck.testReceived", {
          time: formatReceivedAt(diagnostics.lastTestEventAt)
        }));
      } else {
        lines.push(getBotText("csWebhookCheck.testMissing"));
      }
      if (diagnostics.lastSignedRequestAt !== null) {
        lines.push(getBotText("csWebhookCheck.lastSignedRequest", {
          eventType: diagnostics.lastSignedRequestType ?? "ukjent",
          time: formatReceivedAt(diagnostics.lastSignedRequestAt)
        }));
      }
      await interaction.editReply(lines.join("\n"));
    } catch {
      await interaction.editReply(getBotText("csWebhookCheck.failed"));
    }
  }
};
