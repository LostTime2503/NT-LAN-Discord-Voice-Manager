import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { DiscordJsCsVoiceAdapter } from "../discordCsVoiceAdapter.js";
import { MatClient } from "../matClient.js";
import { manualOverrideStore } from "../manualOverrides.js";
import { RegistrationClient } from "../registrationClient.js";
import { getBotSettingsController } from "../botSettingsController.js";
import { getBotText } from "../messages.js";
import { discoverActiveCsTournaments } from "../csTournamentDiscovery.js";

interface StatusLine {
  label: string;
  result: "OK" | "MANGLER" | "FEIL" | "DRY-RUN" | "TVETYDIG";
  detail: string;
}

export function formatCsStatus(lines: StatusLine[]): string {
  return [getBotText("csStatus.title"), ...lines.map(line => getBotText("csStatus.line", {
    result: line.result,
    label: line.label,
    detail: line.detail
  }))].join("\n");
}

export const csStatusCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-status")
    .setDescription("Kontroller MAT-webhook, turneringer, Discord-oppsett og Steam-koblinger."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("csStatus.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("csStatus.crewOnly"));
        return;
      }
    } catch {
      await interaction.editReply(getBotText("csStatus.actorFailed"));
      return;
    }

    const lines: StatusLine[] = [];
    const runtimeSettings = getBotSettingsController()?.getSettings();
    const liveSettings = getBotSettingsController()?.getLiveSettings();
    const csVoiceEnabled = runtimeSettings?.csVoice ?? config.csVoiceSyncEnabled;
    const csRolesEnabled = runtimeSettings?.csRoles ?? config.csRoleSyncEnabled;
    const csVoiceLive = liveSettings?.csVoice ?? !config.csVoiceSyncDryRun;
    const csRolesLive = liveSettings?.csRoles ?? !config.csRoleSyncDryRun;
    const matConfigured = Boolean(config.matUrl);
    const webhookConfigured = Boolean(config.matWebhookSecret);
    const registrationConfigured = [config.registrationApiUrl, config.registrationTokenUrl,
      config.registrationClientId, config.registrationClientSecret].every(Boolean);
    const discordConfigured = [config.csCategoryId, config.csLobbyChannelId, config.csParticipantRoleId,
      config.manualCsParticipantRoleId, config.crewRoleId].every(Boolean);

    lines.push({
      label: getBotText("csStatus.label.voice"),
      result: getBotText(!csVoiceEnabled ? "csStatus.result.missing" : !csVoiceLive ? "csStatus.result.dryRun" : "csStatus.result.ok") as StatusLine["result"],
      detail: getBotText(!csVoiceEnabled ? "csStatus.detail.voicePaused" : !csVoiceLive ? "csStatus.detail.voicePreview" : "csStatus.detail.voiceLive")
    });
    lines.push({
      label: getBotText("csStatus.label.roles"),
      result: getBotText(!csRolesEnabled ? "csStatus.result.missing" : !csRolesLive ? "csStatus.result.dryRun" : "csStatus.result.ok") as StatusLine["result"],
      detail: getBotText(!csRolesEnabled ? "csStatus.detail.rolesPaused" : !csRolesLive ? "csStatus.detail.rolesPreview" : "csStatus.detail.rolesLive")
    });
    lines.push({ label: getBotText("csStatus.label.webhookSecret"), result: getBotText(webhookConfigured ? "csStatus.result.ok" : "csStatus.result.missing") as StatusLine["result"], detail: getBotText(webhookConfigured ? "csStatus.detail.configured" : "csStatus.detail.webhookMissing") });
    lines.push({ label: getBotText("csStatus.label.registration"), result: getBotText(registrationConfigured ? "csStatus.result.ok" : "csStatus.result.missing") as StatusLine["result"], detail: getBotText(registrationConfigured ? "csStatus.detail.registrationConfigured" : "csStatus.detail.registrationMissing") });
    lines.push({ label: getBotText("csStatus.label.discord"), result: getBotText(discordConfigured ? "csStatus.result.ok" : "csStatus.result.missing") as StatusLine["result"], detail: getBotText(discordConfigured ? "csStatus.detail.discordConfigured" : "csStatus.detail.discordMissing") });
    if (webhookConfigured) {
      try {
        const response = await fetch(`http://127.0.0.1:${config.csWebhookPort}/healthz`, {
          signal: AbortSignal.timeout(3_000),
          redirect: "error"
        });
        lines.push({ label: getBotText("csStatus.label.receiver"), result: getBotText(response.status === 204 ? "csStatus.result.ok" : "csStatus.result.error") as StatusLine["result"], detail: response.status === 204 ? getBotText("csStatus.detail.receiverListening", { port: config.csWebhookPort }) : getBotText("csStatus.detail.receiverStatus", { status: response.status }) });
      } catch {
        lines.push({ label: getBotText("csStatus.label.receiver"), result: getBotText("csStatus.result.error") as StatusLine["result"], detail: getBotText("csStatus.detail.receiverFailed") });
      }
    }

    if (discordConfigured) {
      try {
        const adapter = new DiscordJsCsVoiceAdapter(
          interaction.client,
          config.guildId,
          config.csCategoryId!,
          config.csLobbyChannelId!,
          config.csParticipantRoleId!,
          config.manualCsParticipantRoleId!,
          config.crewRoleId!
        );
        await adapter.validate();
        lines.push({ label: getBotText("csStatus.label.discord"), result: getBotText("csStatus.result.ok") as StatusLine["result"], detail: getBotText("csStatus.detail.permissionsValid") });
      } catch (error) {
        console.error("CS Discord permission preflight failed.", error instanceof Error ? error.message : "unknown error");
        lines.push({ label: getBotText("csStatus.label.discord"), result: getBotText("csStatus.result.error") as StatusLine["result"], detail: getBotText("csStatus.detail.permissionsFailed") });
      }
    }

    if (matConfigured) {
      try {
        const mat = new MatClient({ baseUrl: config.matUrl!, apiToken: config.matApiToken });
        const tournaments = await mat.getTournaments();
        const discovery = discoverActiveCsTournaments(tournaments);
        const main = discovery.main
          ? getBotText("csStatus.detail.tournamentCandidate", { id: discovery.main.id, type: discovery.main.type, status: discovery.main.status, size: discovery.main.teamSize })
          : discovery.ambiguousMain
            ? getBotText("csStatus.detail.tournamentAmbiguous", { count: discovery.ambiguousMain + 1 })
            : getBotText("csStatus.detail.noActiveTournament");
        const wingman = discovery.wingman
          ? getBotText("csStatus.detail.tournamentCandidate", { id: discovery.wingman.id, type: discovery.wingman.type, status: discovery.wingman.status, size: discovery.wingman.teamSize })
          : discovery.ambiguousWingman
            ? getBotText("csStatus.detail.tournamentAmbiguous", { count: discovery.ambiguousWingman + 1 })
            : getBotText("csStatus.detail.noActiveTournament");
        const ambiguous = discovery.ambiguousMain > 0 || discovery.ambiguousWingman > 0;
        const found = Boolean(discovery.main || discovery.wingman);
        lines.push({
          label: getBotText("csStatus.label.tournaments"),
          result: getBotText(found ? "csStatus.result.ok" : ambiguous ? "csStatus.result.ambiguous" : "csStatus.result.missing") as StatusLine["result"],
          detail: getBotText("csStatus.detail.tournaments", { main, wingman })
        });
      } catch {
        lines.push({ label: getBotText("csStatus.label.matApi"), result: getBotText("csStatus.result.error") as StatusLine["result"], detail: getBotText("csStatus.detail.matApiFailed") });
      }
    } else {
      lines.push({ label: getBotText("csStatus.label.matApi"), result: getBotText("csStatus.result.missing") as StatusLine["result"], detail: getBotText("csStatus.detail.matUrlMissing") });
    }

    if (registrationConfigured) {
      try {
        const registration = new RegistrationClient({
          apiUrl: config.registrationApiUrl!,
          tokenUrl: config.registrationTokenUrl!,
          clientId: config.registrationClientId!,
          clientSecret: config.registrationClientSecret!
        });
        const baseParticipants = await registration.getCsParticipants();
        const csParticipants = await manualOverrideStore.getCsParticipants(baseParticipants);
        const steamMapped = [...csParticipants.values()].filter(person => person.steamId).length;
        lines.push({ label: getBotText("csStatus.label.steamLinks"), result: getBotText(steamMapped > 0 ? "csStatus.result.ok" : "csStatus.result.missing") as StatusLine["result"], detail: getBotText("csStatus.detail.steamCounts", { mapped: steamMapped, participants: csParticipants.size }) });
      } catch {
        lines.push({ label: getBotText("csStatus.label.registration"), result: getBotText("csStatus.result.error") as StatusLine["result"], detail: getBotText("csStatus.detail.participantsFailed") });
      }
    }

    await interaction.editReply(formatCsStatus(lines));
  }
};