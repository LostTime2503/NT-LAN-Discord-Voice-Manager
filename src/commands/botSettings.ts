import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getBotSettingsController } from "../botSettingsController.js";
import type { BotFeature, CrewLogMode } from "../botSettings.js";
import { getBotText } from "../messages.js";

const featureMessageKeys: Record<BotFeature, string> = {
  access: "botSettings.feature.access",
  normalVoice: "botSettings.feature.normalVoice",
  csRoles: "botSettings.feature.csRoles",
  csVoice: "botSettings.feature.csVoice"
};

function featureLabel(feature: BotFeature): string {
  return getBotText(featureMessageKeys[feature]);
}

export const botSettingsCommand = {
  data: new SlashCommandBuilder()
    .setName("bot-settings")
    .setDescription("Vis eller endre botens automatiske funksjoner.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName("funksjon").setDescription("Funksjonen som skal endres.")
      .addChoices(
        { name: "Nettside-tilgang", value: "access" },
        { name: "Vanlig voice", value: "normalVoice" },
        { name: "CS-rolletildeling", value: "csRoles" },
        { name: "CS-voice", value: "csVoice" }
      ))
    .addStringOption(option => option.setName("loggniva").setDescription("Velg hvor mye som postes i Crew-loggen.")
      .addChoices(
        { name: "Full", value: "full" },
        { name: "Minimal (kun nettsidekoblinger)", value: "minimal" },
        { name: "CS-test (kun CS-diagnostikk)", value: "cs-test" },
        { name: "Detaljert CS + full logg", value: "detailed-cs" }
      ))
    .addBooleanOption(option => option.setName("aktiv").setDescription("Skru funksjonen av eller på."))
    .addBooleanOption(option => option.setName("bekreft_live").setDescription("Bekreft live-endringer etter å ha kontrollert tørrkjøringen.")),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("botSettings.notConfigured"));
      return;
    }
    let selectedFeature: string | null = null;
    try {
      const actor = await interaction.guild.members.fetch(interaction.user.id);
      if (!isCrewMember(actor, config.crewRoleId)) {
        await interaction.editReply(getBotText("botSettings.crewOnly"));
        return;
      }
      const controller = getBotSettingsController();
      if (!controller) {
        await interaction.editReply(getBotText("botSettings.notLoaded"));
        return;
      }
      selectedFeature = interaction.options.getString("funksjon");
      const enabled = interaction.options.getBoolean("aktiv");
      const logMode = interaction.options.getString("loggniva");
      if (selectedFeature === null && enabled === null && logMode === null) {
        const settings = controller.getSettings();
        const live = controller.getLiveSettings();
        const lines = (Object.keys(featureMessageKeys) as BotFeature[]).map(feature => {
          const mode = feature === "normalVoice" ? getBotText("botSettings.mode.direct")
            : live[feature as Exclude<BotFeature, "normalVoice">] ? getBotText("botSettings.mode.live") : getBotText("botSettings.mode.preview");
          return getBotText("botSettings.statusLine", {
            feature: featureLabel(feature),
            status: settings[feature] ? `${getBotText("botSettings.state.on")} (${mode})` : getBotText("botSettings.state.off")
          });
        });
        lines.push(getBotText("botSettings.logModeLine", {
          mode: getBotText(logModeKey(controller.getCrewLogMode()))
        }));
        await interaction.editReply([getBotText("botSettings.title"), ...lines].join("\n"));
        return;
      }
      if (logMode !== null) {
        if (selectedFeature !== null || enabled !== null || interaction.options.getBoolean("bekreft_live") !== null) {
          await interaction.editReply(getBotText("botSettings.incomplete"));
          return;
        }
        const mode = logMode as CrewLogMode;
        await controller.setCrewLogMode(mode);
        await interaction.editReply(getBotText("botSettings.logModeChanged", {
          mode: getBotText(logModeKey(mode))
        }));
        return;
      }
      if (selectedFeature === null || enabled === null) {
        await interaction.editReply(getBotText("botSettings.incomplete"));
        return;
      }
      const feature = selectedFeature as BotFeature;
      const result = await controller.setFeature(
        feature,
        enabled,
        interaction.options.getBoolean("bekreft_live") ?? false
      );
      const isEnabled = result.settings[feature];
      const mode = feature === "normalVoice" ? getBotText("botSettings.mode.direct") : result.live[feature as Exclude<BotFeature, "normalVoice">] ? getBotText("botSettings.mode.live") : getBotText("botSettings.mode.preview");
      const followUp = result.previewRequired
        ? getBotText("botSettings.previewFollowUp")
        : "";
      await interaction.editReply(getBotText("botSettings.changed", {
        feature: featureLabel(feature),
        status: isEnabled ? `${getBotText("botSettings.state.on")} (${mode})` : getBotText("botSettings.state.off"),
        followUp
      }));
    } catch (error) {
      const missingCsVoicePrefix = getBotText("botSettings.csVoiceMissingConfig", { missing: "" });
      const message = selectedFeature === "csVoice" && error instanceof Error
        && error.message.startsWith(missingCsVoicePrefix)
        ? error.message
        : getBotText("botSettings.failed");
      await interaction.editReply(message);
    }
  }
};

function logModeKey(mode: CrewLogMode): string {
  switch (mode) {
    case "minimal": return "botSettings.logMode.minimal";
    case "cs-test": return "botSettings.logMode.csTest";
    case "detailed-cs": return "botSettings.logMode.detailedCs";
    default: return "botSettings.logMode.full";
  }
}