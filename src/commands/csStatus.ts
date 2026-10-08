import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { DiscordJsCsVoiceAdapter } from "../discordCsVoiceAdapter.js";
import { MatClient } from "../matClient.js";
import { manualOverrideStore } from "../manualOverrides.js";
import { RegistrationClient } from "../registrationClient.js";

interface StatusLine {
  label: string;
  result: "OK" | "MANGLER" | "FEIL" | "DRY-RUN";
  detail: string;
}

export function formatCsStatus(lines: StatusLine[]): string {
  return ["CS-status", ...lines.map(line => `${line.result} · ${line.label}: ${line.detail}`)].join("\n");
}

export const csStatusCommand = {
  data: new SlashCommandBuilder()
    .setName("cs-status")
    .setDescription("Kontroller MAT-webhook, turneringer, Discord-oppsett og Steam-koblinger."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply("CS-status er ikke konfigurert for denne serveren.");
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply("Bare Crew og høyere kan se CS-status.");
        return;
      }
    } catch {
      await interaction.editReply("Kunne ikke bekrefte Crew-tilgang for CS-status.");
      return;
    }

    const lines: StatusLine[] = [];
    const matConfigured = Boolean(config.matUrl);
    const webhookConfigured = Boolean(config.matWebhookSecret);
    const registrationConfigured = [config.registrationApiUrl, config.registrationTokenUrl,
      config.registrationClientId, config.registrationClientSecret].every(Boolean);
    const discordConfigured = [config.csCategoryId, config.csLobbyChannelId, config.csParticipantRoleId, config.crewRoleId].every(Boolean);
    const tournamentsConfigured = Boolean(config.csMainTournamentId && config.csWingmanTournamentId);

    lines.push({ label: "Discord-modus", result: config.csSyncDryRun ? "DRY-RUN" : "OK", detail: config.csSyncDryRun ? "ingen kanal- eller medlemsendringer" : "live-modus" });
    lines.push({ label: "Webhook-secret", result: webhookConfigured ? "OK" : "MANGLER", detail: webhookConfigured ? "konfigurert" : "MAT_WEBHOOK_SECRET mangler" });
    lines.push({ label: "Registration API", result: registrationConfigured ? "OK" : "MANGLER", detail: registrationConfigured ? "konfigurert" : "en eller flere REGISTRATION_* mangler" });
    lines.push({ label: "CS Discord-oppsett", result: discordConfigured ? "OK" : "MANGLER", detail: discordConfigured ? "kategori, lobby, CS-rolle og Crew-rolle konfigurert" : "CS_CATEGORY_ID, CS_LOBBY_CHANNEL_ID, CS_PARTICIPANT_ROLE_ID eller CREW_ROLE_ID mangler" });
    lines.push({ label: "Turnerings-ID-er", result: tournamentsConfigured ? "OK" : "MANGLER", detail: tournamentsConfigured ? "main og Wingman konfigurert" : "CS_MAIN_TOURNAMENT_ID og/eller CS_WINGMAN_TOURNAMENT_ID mangler" });

    if (webhookConfigured) {
      try {
        const response = await fetch(`http://127.0.0.1:${config.csWebhookPort}/healthz`, {
          signal: AbortSignal.timeout(3_000),
          redirect: "error"
        });
        lines.push({ label: "Webhook-mottaker", result: response.status === 204 ? "OK" : "FEIL", detail: response.status === 204 ? `lytter på port ${config.csWebhookPort}` : `healthcheck svarte ${response.status}` });
      } catch {
        lines.push({ label: "Webhook-mottaker", result: "FEIL", detail: "ikke nåbar lokalt; kontroller at runtime startet og porten er riktig" });
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
          config.crewRoleId!,
          config.emptyChannelDeleteDelayMs
        );
        await adapter.validate();
        lines.push({ label: "Discord-rettigheter", result: "OK", detail: "kategori, lobby, roller, Manage Channels og Move Members validert" });
      } catch (error) {
        lines.push({ label: "Discord-rettigheter", result: "FEIL", detail: error instanceof Error ? error.message : "preflight feilet" });
      }
    }

    if (matConfigured) {
      try {
        const mat = new MatClient({ baseUrl: config.matUrl!, apiToken: config.matApiToken });
        const tournaments = await mat.getTournaments();
        const main = tournaments.find(tournament => tournament.id === config.csMainTournamentId);
        const wingman = tournaments.find(tournament => tournament.id === config.csWingmanTournamentId);
        lines.push({
          label: "MAT-turneringer",
          result: main && wingman ? "OK" : "FEIL",
          detail: `main ${main ? `${main.type}/${main.status}/size ${main.teamSize}` : "ID ikke funnet"}; Wingman ${wingman ? `${wingman.type}/${wingman.status}/size ${wingman.teamSize}` : "ID ikke funnet"}`
        });
        if (main && (main.type === "shuffle" || main.teamSize !== 5)) {
          lines.push({ label: "Main-format", result: "FEIL", detail: `forventet lagturnering med 5 spillere; fikk ${main.type}, size ${main.teamSize}` });
        }
        if (wingman && (wingman.type !== "shuffle" || wingman.teamSize !== 2)) {
          lines.push({ label: "Wingman-format", result: "FEIL", detail: `forventet shuffle med 2 spillere; fikk ${wingman.type}, size ${wingman.teamSize}` });
        }
      } catch {
        lines.push({ label: "MAT API", result: "FEIL", detail: "turneringslisten kunne ikke leses med MAT_URL/MAT_API_TOKEN" });
      }
    } else {
      lines.push({ label: "MAT API", result: "MANGLER", detail: "MAT_URL mangler" });
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
        lines.push({ label: "Steam-koblinger", result: steamMapped > 0 ? "OK" : "MANGLER", detail: `${steamMapped} av ${csParticipants.size} CS-deltakere har SteamID64` });
      } catch {
        lines.push({ label: "Registration API", result: "FEIL", detail: "deltakerlisten kunne ikke leses" });
      }
    }

    await interaction.editReply(formatCsStatus(lines));
  }
};