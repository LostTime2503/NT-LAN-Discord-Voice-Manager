import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { createHash } from "node:crypto";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { createCsVoiceRoomOverwrites, formatCsRoomName } from "../discordCsVoiceAdapter.js";
import { getBotMessages, getBotText } from "../messages.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { consumeCommandPreview, issueCommandPreview } from "../commandPreviews.js";

type Competition = "main" | "wingman";

function roomMarker(competition: Competition, teamName: string): string {
  const key = `${competition}:${teamName.normalize("NFC").trim().toLocaleLowerCase("nb-NO")}`;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 10);
  return `[manual-cs-${digest}]`;
}

function hasRoomMarker(name: string, marker: string): boolean {
  return name.startsWith(`${marker} `) || name.endsWith(` ${marker}`);
}

export const makeCsTeamRoomsCommand = {
  data: new SlashCommandBuilder()
    .setName("make-cs-team-rooms")
    .setDescription("Forhåndsvis eller opprett de faste CS-lagrommene uten MAT.")
    .addStringOption(option => option.setName("konkurranse").setDescription("Velg turnering.").setRequired(true)
      .addChoices({ name: "Hovedturnering", value: "main" }, { name: "Wingman", value: "wingman" }))
    .addBooleanOption(option => option.setName("bekreft").setDescription("Opprett de manglende rommene fra forhåndsvisningen."))
    .addStringOption(option => option.setName("previewkode").setDescription("Engangskode fra forhåndsvisningen.").setMaxLength(8)),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("makeFixedCsRooms.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("makeFixedCsRooms.crewOnly"));
        return;
      }
      if (!config.csCategoryId || !config.csParticipantRoleId || !config.manualCsParticipantRoleId) {
        await interaction.editReply(getBotText("makeFixedCsRooms.notConfigured"));
        return;
      }
      const competition = interaction.options.getString("konkurranse", true) as Competition;
      const competitionName = getBotText(`makeFixedCsRooms.competition.${competition}`);
      const category = await interaction.guild.channels.fetch(config.csCategoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        await interaction.editReply(getBotText("makeTeamChats.categoryMissing"));
        return;
      }
      const teamNames = getBotMessages().cs.teamNames;
      const missing = teamNames.filter(teamName => {
        const marker = roomMarker(competition, teamName);
        return !category.children.cache.some(channel => channel.type === ChannelType.GuildVoice
          && hasRoomMarker(channel.name, marker));
      });
      const previewResources = missing.map(teamName => roomMarker(competition, teamName));
      if (!interaction.options.getBoolean("bekreft")) {
        const previewCode = issueCommandPreview("make-cs-team-rooms", interaction.guildId, interaction.user.id, previewResources);
        await interaction.editReply(getBotText("makeFixedCsRooms.preview", {
          competition: competitionName,
          createdCount: missing.length,
          teamCount: teamNames.length,
          teamNames: missing.length ? missing.map(name => `• ${name}`).join("\n") : "Ingen mangler",
          previewCode
        }));
        return;
      }

      const previewCode = interaction.options.getString("previewkode") ?? "";
      if (!consumeCommandPreview(previewCode, "make-cs-team-rooms", interaction.guildId, interaction.user.id, previewResources)) {
        await interaction.editReply(getBotText("makeFixedCsRooms.previewExpired"));
        return;
      }
      const bot = await interaction.guild.members.fetchMe();
      if (!bot.permissionsIn(category).has(PermissionFlagsBits.ManageChannels)) {
        await interaction.editReply(getBotText("makeFixedCsRooms.noPermission"));
        return;
      }

      for (const teamName of missing) {
        const marker = roomMarker(competition, teamName);
        await interaction.guild.channels.create({
          name: formatCsRoomName(teamName, competition, marker),
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
          reason: "Crew created a fixed CS team room without MAT"
        });
      }
      await sendCrewLogMessage(interaction.client, getBotText("cs.roomsCreated", {
        competition: competitionName,
        createdCount: missing.length,
        existingCount: teamNames.length - missing.length
      }, "logs"));
      await interaction.editReply(getBotText("makeFixedCsRooms.complete", {
        competition: competitionName,
        createdCount: missing.length
      }));
    } catch {
      await interaction.editReply(getBotText("makeFixedCsRooms.failed"));
    }
  }
};