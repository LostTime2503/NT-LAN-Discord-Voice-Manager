import {
  CheckboxGroupBuilder, LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type ModalSubmitInteraction
} from "discord.js";
import { randomUUID } from "node:crypto";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import {
  MealNotificationPreferencesStore, MealNotificationStore, parseMealEventDate, type MealRound
} from "../mealNotifications.js";
import { getBotText } from "../messages.js";

interface MealModalSession { userId: string; guildId: string; expiresAt: number }

export const mealNotificationStore = new MealNotificationStore();
export const mealNotificationPreferencesStore = new MealNotificationPreferencesStore();
const sessions = new Map<string, MealModalSession>();
const reminderOptions = [
  { label: "60 min før", value: "60" }, { label: "30 min før", value: "30" },
  { label: "15 min før", value: "15" }, { label: "10 min før", value: "10" }, { label: "Ved servering", value: "0" }
];

function isCrew(interaction: ChatInputCommandInteraction | ModalSubmitInteraction): boolean {
  if (!interaction.guild || interaction.guildId !== config.guildId || !config.crewRoleId) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const member = interaction.member;
  if (!member) return false;
  const roleIds = Array.isArray(member.roles) ? member.roles : [...member.roles.cache.keys()];
  if (roleIds.includes(config.crewRoleId)) return true;
  const crewPosition = interaction.guild.roles.cache.get(config.crewRoleId)?.position;
  return crewPosition !== undefined && roleIds.some(id => (interaction.guild!.roles.cache.get(id)?.position ?? -1) > crewPosition);
}

function timeInput(id: string, time: string): TextInputBuilder {
  return new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(5).setValue(time).setPlaceholder("18:00");
}

function mealReminders(id: string, selected: number[]): CheckboxGroupBuilder {
  return new CheckboxGroupBuilder().setCustomId(id)
    .setOptions(reminderOptions.map(option => ({ ...option, default: selected.includes(Number(option.value)) })))
    .setMinValues(0).setMaxValues(reminderOptions.length).setRequired(false);
}

export function createMealNotificationsModal(token: string, preferences: ReturnType<MealNotificationPreferencesStore["get"]>): ModalBuilder {
  return new ModalBuilder().setCustomId(`mealnotifications:settings:${token}`).setTitle("Måltidsvarsler")
    .addLabelComponents(
      new LabelBuilder().setLabel("Serveringsdato").setDescription("DD.MM.YYYY · eksempel 17.10.2026")
        .setTextInputComponent(new TextInputBuilder().setCustomId("eventDate").setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(10).setValue(preferences.lastEventDate
            ? `${preferences.lastEventDate.slice(8, 10)}.${preferences.lastEventDate.slice(5, 7)}.${preferences.lastEventDate.slice(0, 4)}` : "")),
      new LabelBuilder().setLabel("Pulje 1 · serveringstid").setTextInputComponent(timeInput("roundOneTime", preferences.times[1])),
      new LabelBuilder().setLabel("Pulje 1 · påminnelser").setCheckboxGroupComponent(mealReminders("roundOneReminders", preferences.reminders[1])),
      new LabelBuilder().setLabel("Pulje 2 · serveringstid").setTextInputComponent(timeInput("roundTwoTime", preferences.times[2])),
      new LabelBuilder().setLabel("Pulje 2 · påminnelser").setCheckboxGroupComponent(mealReminders("roundTwoReminders", preferences.reminders[2]))
    );
}

export const mealNotificationsCommand = {
  data: new SlashCommandBuilder().setName("meal-notifications").setDescription("Åpne modal for måltider og varsler."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || interaction.guildId !== config.guildId || !isCrew(interaction)) {
      await interaction.reply({ content: getBotText("mealNotifications.crewOnly"), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!config.mealTextChannelId || !config.foodRoundOneRoleId || !config.foodRoundTwoRoleId) {
      await interaction.reply({ content: getBotText("mealNotifications.notConfigured"), flags: MessageFlags.Ephemeral });
      return;
    }
    await mealNotificationPreferencesStore.load();
    await mealNotificationStore.load();
    const token = randomUUID().replace(/-/g, "").slice(0, 16);
    sessions.set(token, { userId: interaction.user.id, guildId: interaction.guildId!, expiresAt: Date.now() + 5 * 60_000 });
    try {
      await interaction.showModal(createMealNotificationsModal(token, mealNotificationPreferencesStore.get()));
    } catch {
      sessions.delete(token);
      await interaction.reply({ content: getBotText("mealNotifications.failed"), flags: MessageFlags.Ephemeral });
    }
  },

  async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [, action, token] = interaction.customId.split(":");
    const session = token ? sessions.get(token) : undefined;
    if (action !== "settings" || !session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId
      || session.expiresAt < Date.now() || !isCrew(interaction)) {
      if (token) sessions.delete(token);
      await interaction.reply({ content: getBotText("mealNotifications.expired"), flags: MessageFlags.Ephemeral });
      return;
    }
    sessions.delete(token!);
    try {
      const eventDate = parseMealEventDate(interaction.fields.getTextInputValue("eventDate"));
      const roundOneTime = interaction.fields.getTextInputValue("roundOneTime").trim();
      const roundTwoTime = interaction.fields.getTextInputValue("roundTwoTime").trim();
      const roundOneReminders = interaction.fields.getCheckboxGroup("roundOneReminders").map(Number);
      const roundTwoReminders = interaction.fields.getCheckboxGroup("roundTwoReminders").map(Number);
      const preferences = {
        lastEventDate: eventDate,
        times: { 1: roundOneTime, 2: roundTwoTime },
        reminders: { 1: roundOneReminders, 2: roundTwoReminders }
      } as const;
      await mealNotificationPreferencesStore.save(preferences);
      const result = await mealNotificationStore.replaceEvent({
        guildId: config.guildId,
        channelId: config.mealTextChannelId!,
        eventDate,
        times: { 1: roundOneTime, 2: roundTwoTime },
        reminders: { 1: roundOneReminders, 2: roundTwoReminders }
      });
      await interaction.reply({
        content: `Måltidsinnstillinger lagret for ${eventDate}. ${result.created} varsler planlagt, ${result.skipped} utløpte tidspunkt hoppet over. Pulje-rollene synkroniseres fortsatt fra API-et.`,
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : getBotText("mealNotifications.failed"), flags: MessageFlags.Ephemeral });
    }
  }
};
