import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { getBotSettingsController } from "../botSettingsController.js";
import type { BotFeature } from "../botSettings.js";
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
    .addBooleanOption(option => option.setName("aktiv").setDescription("Skru funksjonen av eller på."))
    .addBooleanOption(option => option.setName("bekreft_live").setDescription("Bekreft live-endringer etter å ha kontrollert tørrkjøringen.")),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) {
      await interaction.editReply(getBotText("botSettings.notConfigured"));
      return;
    }
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
      const selectedFeature = interaction.options.getString("funksjon");
      const enabled = interaction.options.getBoolean("aktiv");
      if (selectedFeature === null && enabled === null) {
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
        await interaction.editReply([getBotText("botSettings.title"), ...lines].join("\n"));
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
      await interaction.editReply(getBotText("botSettings.failed"));
    }
  }
};