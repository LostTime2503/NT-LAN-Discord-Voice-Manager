import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getBotSettingsController } from "../botSettingsController.js";
import { formatCsWebhookSourceStatus, getCsWebhookDiagnostics } from "../csWebhookDiagnostics.js";
import type { CsSourceMode, CsWebhookSource } from "../botSettings.js";

const labels: Record<CsSourceMode, string> = {
  off: "Ikke gjør endringer (kvitter og logg)",
  preview: "Forhåndsvisning (kun plan)",
  live: "Gjør endringer"
};

export const csSettingsCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-settings")
    .setDescription("Vis eller endre behandling av ekte og syntetiske CS-webhooks.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName("kilde").setDescription("Webhook-kilde.")
      .addChoices({ name: "Ekte MAT", value: "mat" }, { name: "Testscript", value: "test" }))
    .addStringOption(option => option.setName("modus").setDescription("Tillatte handlinger for kilden.")
      .addChoices(...Object.entries(labels).map(([value, name]) => ({ name, value }))))
    .addBooleanOption(option => option.setName("bekreft_live").setDescription("Bekreft at kilden kan endre Discord.")),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply("CS-innstillinger er ikke konfigurert for denne serveren.");
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply("Bare Crew og høyere kan endre CS-innstillinger.");
        return;
      }
      const controller = getBotSettingsController();
      if (!controller) throw new Error("Settings unavailable");
      const source = interaction.options.getString("kilde") as CsWebhookSource | null;
      const mode = interaction.options.getString("modus") as CsSourceMode | null;
      if ((source === null) !== (mode === null)) {
        await interaction.editReply("Velg både kilde og modus, eller kjør uten valg for status.");
        return;
      }
      if (source && mode) {
        if (source === "test" && !config.csTestWebhookSecret) {
          await interaction.editReply("Testmottakeren mangler CS_TEST_WEBHOOK_SECRET i serveroppsettet.");
          return;
        }
        if (mode === "live" && !controller.getSettings().csVoice) {
          await interaction.editReply("Slå på CS-voice i /bot-settings før en kilde kan settes til live.");
          return;
        }
        if (mode === "live" && !interaction.options.getBoolean("bekreft_live")) {
          await interaction.editReply("Kjør på nytt med bekreft_live:true for å tillate Discord-endringer.");
          return;
        }
        await controller.setCsSource(source, mode, interaction.options.getBoolean("bekreft_live") ?? false);
      }
      const settings = controller.getCsSources();
      const botSettings = controller.getSettings();
      const liveSettings = controller.getLiveSettings();
      const [matDiagnostics, testDiagnostics] = await Promise.all([
        getCsWebhookDiagnostics("mat"),
        getCsWebhookDiagnostics("test")
      ]);
      const matStatus = formatCsWebhookSourceStatus({
        configured: Boolean(config.matWebhookSecret),
        featureEnabled: botSettings.csVoice,
        featureLive: liveSettings.csVoice,
        mode: settings.mat,
        diagnostics: matDiagnostics
      });
      const testStatus = formatCsWebhookSourceStatus({
        configured: Boolean(config.csTestWebhookSecret),
        featureEnabled: botSettings.csVoice,
        featureLive: liveSettings.csVoice,
        mode: settings.test,
        diagnostics: testDiagnostics
      });
      await interaction.editReply([
        "CS-kilder",
        `MAT: ${matStatus}`,
        `TESTSCRIPT: ${testStatus}${config.csTestWebhookSecret ? ` (port ${config.csTestWebhookPort})` : ""}`,
        `CS-voice: ${botSettings.csVoice ? liveSettings.csVoice ? "live" : "forhåndsvisning" : "av"}`
      ].join("\n"));
    } catch {
      await interaction.editReply("Kunne ikke endre CS-innstillingene; kontroller mottakeroppsettet i Dockhand.");
    }
  }
};