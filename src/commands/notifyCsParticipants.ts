import {
  ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type AutocompleteInteraction, type ChatInputCommandInteraction
} from "discord.js";
import { createHash } from "node:crypto";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getBotMessages, getBotText, renderCsNotification } from "../messages.js";
import { sendCrewLogMessage } from "../crewLog.js";
import { consumeCommandPreview, issueCommandPreview } from "../commandPreviews.js";

export const notifyCsParticipantsCommand = {
  data: new SlashCommandBuilder()
    .setName("notify-cs-participants")
    .setDescription("Send en valgt CS-konkurransemelding.")
    .addStringOption(option => option.setName("melding").setDescription("Meldingsmal fra messages.json.").setRequired(true).setAutocomplete(true))
    .addStringOption(option => option.setName("konkurranse").setDescription("Velg konkurranse.").setRequired(true)
      .addChoices({ name: "Hovedturnering", value: "main" }, { name: "Wingman", value: "wingman" }))
    .addChannelOption(option => option.setName("kanal").setDescription("Tekstkanalen meldingen skal sendes i.").setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addBooleanOption(option => option.setName("ping").setDescription("Ping begge CS-deltakerrollene. Standard er av."))
    .addIntegerOption(option => option.setName("minutter").setDescription("Minutter til start.").setMinValue(1).setMaxValue(1440))
    .addChannelOption(option => option.setName("venterom").setDescription("Voice-lobby som skal nevnes.").addChannelTypes(ChannelType.GuildVoice))
    .addStringOption(option => option.setName("resultat").setDescription("Resultattekst, for eksempel 13–9.").setMaxLength(100))
    .addBooleanOption(option => option.setName("bekreft").setDescription("Send den forhåndsviste meldingen."))
    .addStringOption(option => option.setName("previewkode").setDescription("Engangskode fra forhåndsvisningen.").setMaxLength(8)),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const query = interaction.options.getFocused().toLocaleLowerCase("nb-NO");
    const choices = Object.entries(getBotMessages().cs.notifications)
      .filter(([, preset]) => preset.label.toLocaleLowerCase("nb-NO").includes(query))
      .slice(0, 25)
      .map(([id, preset]) => ({ name: preset.label.slice(0, 100), value: id }));
    await interaction.respond(choices);
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("notifyCsParticipants.notConfigured"));
      return;
    }
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("notifyCsParticipants.crewOnly"));
        return;
      }
      const channel = interaction.options.getChannel("kanal", true, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
      if (channel.guildId !== config.guildId) {
        await interaction.editReply(getBotText("notifyCsParticipants.wrongChannel"));
        return;
      }
      const competition = interaction.options.getString("konkurranse", true);
      const lobby = interaction.options.getChannel("venterom");
      const values = {
        competition: competition === "main" ? "Hovedturnering" : "Wingman",
        minutes: interaction.options.getInteger("minutter")?.toString(),
        lobby: lobby ? `<#${lobby.id}>` : config.csLobbyChannelId ? `<#${config.csLobbyChannelId}>` : undefined,
        score: interaction.options.getString("resultat")?.trim()
      };
      const content = renderCsNotification(interaction.options.getString("melding", true), values);
      const ping = interaction.options.getBoolean("ping") ?? false;
      const roles = ping ? [config.csParticipantRoleId, config.manualCsParticipantRoleId].filter((id): id is string => Boolean(id)) : [];
      if (ping && roles.length !== 2) {
        await interaction.editReply(getBotText("notifyCsParticipants.rolesMissing"));
        return;
      }
      const bot = await interaction.guild.members.fetchMe();
      if (!bot.permissionsIn(channel).has(PermissionFlagsBits.SendMessages)) {
        await interaction.editReply(getBotText("notifyCsParticipants.noPermission"));
        return;
      }
      const message = `${roles.map(roleId => `<@&${roleId}>`).join(" ")}${roles.length ? "\n" : ""}${content}`;
      const payloadId = createHash("sha256").update(`${channel.id}\0${message}\0${ping}`).digest("hex");
      if (!interaction.options.getBoolean("bekreft")) {
        const previewCode = issueCommandPreview("notify-cs-participants", interaction.guildId, interaction.user.id,
          [channel.id, payloadId]);
        await interaction.editReply({
          content: getBotText("notifyCsParticipants.preview", { channelId: channel.id, message, previewCode }),
          allowedMentions: { parse: [] }
        });
        return;
      }
      const previewCode = interaction.options.getString("previewkode") ?? "";
      if (!consumeCommandPreview(previewCode, "notify-cs-participants", interaction.guildId, interaction.user.id,
        [channel.id, payloadId])) {
        await interaction.editReply(getBotText("notifyCsParticipants.previewExpired"));
        return;
      }
      await channel.send({ content: message, allowedMentions: { parse: [], roles } });
      await sendCrewLogMessage(interaction.client, getBotText("cs.notificationSent", {
        competition,
        preset: interaction.options.getString("melding", true),
        ping: ping ? "på" : "av"
      }, "logs"));
      await interaction.editReply(getBotText("notifyCsParticipants.sent"));
    } catch (error) {
      await interaction.editReply(error instanceof Error && error.message.startsWith("Missing notification value:")
        ? getBotText("notifyCsParticipants.missingValues")
        : getBotText("notifyCsParticipants.failed"));
    }
  }
};