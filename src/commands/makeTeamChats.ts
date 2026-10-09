import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { createHash } from "node:crypto";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { createCsVoiceRoomOverwrites } from "../discordCsVoiceAdapter.js";
import { MatClient } from "../matClient.js";
import { manualOverrideStore } from "../manualOverrides.js";
import { RegistrationClient } from "../registrationClient.js";
import { planCsTournamentRooms } from "../csTournamentSync.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { consumeCommandPreview, issueCommandPreview } from "../commandPreviews.js";
import { getBotText } from "../messages.js";
import { discoverActiveCsTournaments } from "../csTournamentDiscovery.js";

type Competition = "main" | "wingman";

function roomMarker(competition: Competition, tournamentId: number, teamId: string): string {
  const digest = createHash("sha256").update(`${competition}:${tournamentId}:${teamId}`).digest("hex").slice(0, 10);
  return `[manual-cs-${digest}]`;
}

function safeChannelPart(value: string): string {
  return value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 75) || "lag";
}

export const makeTeamChatsCommand = {
  data: new SlashCommandBuilder()
    .setName("make-team-chats")
    .setDescription("Forhåndsvis eller opprett CS-lagrom manuelt.")
    .addStringOption(option => option.setName("konkurranse").setDescription("Velg turnering.").setRequired(true)
      .addChoices({ name: "Hovedturnering", value: "main" }, { name: "Wingman", value: "wingman" }))
    .addBooleanOption(option => option.setName("bekreft").setDescription("Opprett de manglende rommene fra forhåndsvisningen."))
    .addStringOption(option => option.setName("previewkode").setDescription("Engangskode fra forhåndsvisningen.").setMaxLength(8)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("makeTeamChats.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("makeTeamChats.crewOnly"));
        return;
      }
      const competition = interaction.options.getString("konkurranse", true) as Competition;
      if (!config.matUrl || !config.matApiToken || !config.registrationApiUrl
        || !config.registrationTokenUrl || !config.registrationClientId || !config.registrationClientSecret) {
        await interaction.editReply(getBotText("makeTeamChats.apiNotConfigured"));
        return;
      }

      const mat = new MatClient({ baseUrl: config.matUrl, apiToken: config.matApiToken });
      const registration = new RegistrationClient({
        apiUrl: config.registrationApiUrl,
        tokenUrl: config.registrationTokenUrl,
        clientId: config.registrationClientId,
        clientSecret: config.registrationClientSecret
      });
      const [teams, tournaments, participants] = await Promise.all([
        mat.getTeams(),
        mat.getTournaments(),
        registration.getCsParticipants().then(value => manualOverrideStore.getCsParticipants(value))
      ]);
      const discovery = discoverActiveCsTournaments(tournaments);
      const candidate = competition === "main" ? discovery.main : discovery.wingman;
      const ambiguityCount = competition === "main" ? discovery.ambiguousMain : discovery.ambiguousWingman;
      if (!candidate) {
        await interaction.editReply(getBotText(ambiguityCount > 0
          ? "makeTeamChats.tournamentAmbiguous" : "makeTeamChats.noActiveTournament"));
        return;
      }
      const tournamentId = candidate.id;
      const bracket = await mat.getBracketSummary(tournamentId);
      if (bracket.tournament.id !== tournamentId
        || (competition === "main" && bracket.tournament.type === "shuffle")
        || (competition === "wingman" && bracket.tournament.type !== "shuffle")) {
        await interaction.editReply(getBotText("makeTeamChats.formatMismatch"));
        return;
      }
      const plans = planCsTournamentRooms(
        competition === "main" ? bracket : { ...bracket, matches: [] },
        competition === "wingman" ? bracket : { ...bracket, matches: [] },
        teams,
        participants
      );
      const plan = competition === "main" ? plans.main : plans.wingman;
      if (!config.csCategoryId || !config.csParticipantRoleId || !config.manualCsParticipantRoleId) {
        await interaction.editReply(getBotText("makeTeamChats.rolesMissing"));
        return;
      }
      const category = await interaction.guild.channels.fetch(config.csCategoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        await interaction.editReply(getBotText("makeTeamChats.categoryMissing"));
        return;
      }
      const missing = plan.rooms.filter(room => !category.children.cache.some(channel =>
        channel.type === ChannelType.GuildVoice && channel.name.startsWith(roomMarker(competition, tournamentId, room.teamId))));
      const competitionLabel = getBotText(competition === "main" ? "makeTeamChats.competition.main" : "makeTeamChats.competition.wingman");
      const description = getBotText("makeTeamChats.summary", {
        competition: competitionLabel,
        plannedCount: plan.rooms.length,
        missingCount: missing.length,
        skippedCount: plan.skippedTeamCount
      });
      if (!interaction.options.getBoolean("bekreft")) {
        const previewCode = issueCommandPreview("make-team-chats", interaction.guildId, interaction.user.id,
          missing.map(room => roomMarker(competition, tournamentId, room.teamId)));
        await interaction.editReply(getBotText("makeTeamChats.preview", { description, previewCode }));
        return;
      }
      const previewCode = interaction.options.getString("previewkode") ?? "";
      if (!consumeCommandPreview(previewCode, "make-team-chats", interaction.guildId, interaction.user.id,
        missing.map(room => roomMarker(competition, tournamentId, room.teamId)))) {
        await interaction.editReply(getBotText("makeTeamChats.previewExpired"));
        return;
      }

      const me = await interaction.guild.members.fetchMe();
      if (!me.permissionsIn(category).has(PermissionFlagsBits.ManageChannels)) {
        await interaction.editReply(getBotText("makeTeamChats.noPermission"));
        return;
      }
      const created: string[] = [];
      for (const room of missing) {
        const marker = roomMarker(competition, tournamentId, room.teamId);
        const channel = await interaction.guild.channels.create({
          name: `${marker} ${safeChannelPart(room.channelName)}`.slice(0, 100),
          type: ChannelType.GuildVoice,
          parent: category.id,
          bitrate: interaction.guild.maximumBitrate,
          permissionOverwrites: createCsVoiceRoomOverwrites({
            everyoneRoleId: interaction.guild.roles.everyone.id,
            participantRoleId: config.csParticipantRoleId,
            manualParticipantRoleId: config.manualCsParticipantRoleId,
            crewRoleId: config.crewRoleId,
            botUserId: interaction.client.user!.id,
            memberIds: []
          }),
          reason: "Crew manually created CS competition team room"
        });
        created.push(channel.id);
      }
      await sendCrewLogMessage(interaction.client, getBotText("cs.roomsCreated", {
        competition: competitionLabel,
        createdCount: created.length,
        existingCount: missing.length - created.length
      }, "logs"));
      await interaction.editReply(getBotText("makeTeamChats.complete", { description, createdCount: created.length }));
    } catch {
      await interaction.editReply(getBotText("makeTeamChats.failed"));
    }
  }
};