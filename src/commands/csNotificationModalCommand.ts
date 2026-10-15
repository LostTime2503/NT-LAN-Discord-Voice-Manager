import {
  CheckboxGroupBuilder, LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type ModalSubmitInteraction
} from "discord.js";
import { randomUUID } from "node:crypto";
import { isCrewMember } from "../accessManager.js";
import { config } from "../config.js";
import { CsNotificationPreferencesStore, CsNotificationScheduleStore, parseOsloLocalDateTime } from "../csNotificationSchedules.js";
import { getBotText, renderCsNotification } from "../messages.js";

type Competition = "main" | "wingman";
interface ModalSession { userId: string; guildId: string; expiresAt: number }

export const csNotificationScheduleStore = new CsNotificationScheduleStore();
export const csNotificationPreferencesStore = new CsNotificationPreferencesStore();
const sessions = new Map<string, ModalSession>();
const reminderOptions = [
  { label: "60 min før", value: "60" }, { label: "30 min før", value: "30" },
  { label: "15 min før", value: "15" }, { label: "10 min før", value: "10" }, { label: "Ved start", value: "0" }
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

function formatOsloTime(timestamp: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(timestamp).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${parts.hour}:${parts.minute} ${parts.day}.${parts.month}.${parts.year}`;
}

function startInput(id: string, timestamp?: number): TextInputBuilder {
  const input = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short)
    .setRequired(false).setMaxLength(32).setPlaceholder("17:00 12.10.2026");
  if (timestamp) input.setValue(formatOsloTime(timestamp));
  return input;
}

function checks(id: string, offsets: number[], ping: boolean): CheckboxGroupBuilder {
  return new CheckboxGroupBuilder().setCustomId(id).setOptions([
    ...reminderOptions.map(option => ({ ...option, default: offsets.includes(Number(option.value)) })),
    { label: "Ping CS-rollene", value: "ping", default: ping }
  ]).setMinValues(0).setMaxValues(6).setRequired(false);
}

export function createCsNotificationSettingsModal(token: string, preferences: ReturnType<CsNotificationPreferencesStore["get"]>): ModalBuilder {
  return new ModalBuilder().setCustomId(`csnotifications:settings:${token}`).setTitle("CS-påminnelser")
    .addLabelComponents(
      new LabelBuilder().setLabel("Hovedturnering · starttid").setDescription("Europe/Oslo · tomt fjerner tidspunktet")
        .setTextInputComponent(startInput("mainStartAt", preferences.competitions.main.startAt)),
      new LabelBuilder().setLabel("Hovedturnering · påminnelser")
        .setCheckboxGroupComponent(checks("mainReminders", preferences.competitions.main.reminderOffsets, preferences.competitions.main.ping)),
      new LabelBuilder().setLabel("Wingman · starttid").setDescription("Europe/Oslo · tomt fjerner tidspunktet")
        .setTextInputComponent(startInput("wingmanStartAt", preferences.competitions.wingman.startAt)),
      new LabelBuilder().setLabel("Wingman · påminnelser")
        .setCheckboxGroupComponent(checks("wingmanReminders", preferences.competitions.wingman.reminderOffsets, preferences.competitions.wingman.ping))
    );
}

async function replaceReminders(competition: Competition, startAt: number | undefined, offsets: number[], ping: boolean, actorId: string): Promise<{ created: number; skipped: number }> {
  const previous = await csNotificationScheduleStore.list();
  for (const item of previous.filter(item => item.competition === competition && ["scheduled", "paused"].includes(item.status))) {
    await csNotificationScheduleStore.updateStatus(item.id, "cancelled");
  }
  let created = 0;
  let skipped = 0;
  if (!startAt || !config.csTextChannelId) return { created, skipped };
  for (const offset of offsets) {
    const sendAt = startAt - offset * 60_000;
    if (sendAt < Date.now() + 60_000) { skipped += 1; continue; }
    const templateId = offset === 0 ? "turnering-na" : offset <= 10 ? "turnering-venterom" : "turnering-snart";
    const content = renderCsNotification(templateId, {
      competition: competition === "main" ? "Hovedturnering" : "Wingman", minutes: String(offset),
      lobby: config.csLobbyChannelId ? `<#${config.csLobbyChannelId}>` : "venterom"
    });
    await csNotificationScheduleStore.create({ competition, channelId: config.csTextChannelId, content, ping, sendAt, createdBy: actorId });
    created += 1;
  }
  return { created, skipped };
}

export const csNotificationModalCommand = {
  data: new SlashCommandBuilder().setName("cs-notifications").setDescription("Åpne CS-påminnelsesmodalen."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || interaction.guildId !== config.guildId || !isCrew(interaction)) {
      await interaction.reply({ content: getBotText("csNotificationConsole.crewOnly"), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!config.csTextChannelId) {
      await interaction.reply({ content: "CS_TEXT_CHANNEL_ID må konfigureres før påminnelser kan planlegges.", flags: MessageFlags.Ephemeral });
      return;
    }
    await csNotificationPreferencesStore.load();
    await csNotificationScheduleStore.load();
    const token = randomUUID().replace(/-/g, "").slice(0, 16);
    sessions.set(token, { userId: interaction.user.id, guildId: interaction.guildId!, expiresAt: Date.now() + 5 * 60_000 });
    try {
      await interaction.showModal(createCsNotificationSettingsModal(token, csNotificationPreferencesStore.get()));
    } catch {
      sessions.delete(token);
      await interaction.reply({ content: getBotText("csNotificationConsole.failed"), flags: MessageFlags.Ephemeral });
    }
  },

  async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [, action, token] = interaction.customId.split(":");
    const session = token ? sessions.get(token) : undefined;
    if (action !== "settings" || !session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId
      || session.expiresAt < Date.now() || !isCrew(interaction)) {
      if (token) sessions.delete(token);
      await interaction.reply({ content: getBotText("csNotificationConsole.formExpired"), flags: MessageFlags.Ephemeral });
      return;
    }
    sessions.delete(token!);
    try {
      const parseStart = (id: string): number | null => {
        const value = interaction.fields.getTextInputValue(id).trim();
        if (!value) return null;
        const start = parseOsloLocalDateTime(value);
        if (start < Date.now() + 60_000 || start > Date.now() + 90 * 24 * 60 * 60_000) throw new Error("Tidspunktet må være minst ett minutt fram og innen 90 dager.");
        return start;
      };
      const mainStart = parseStart("mainStartAt");
      const wingmanStart = parseStart("wingmanStartAt");
      const mainSelected = interaction.fields.getCheckboxGroup("mainReminders");
      const wingmanSelected = interaction.fields.getCheckboxGroup("wingmanReminders");
      const offsets = (values: readonly string[]) => values.filter(value => value !== "ping").map(Number);
      const mainPing = mainSelected.includes("ping");
      const wingmanPing = wingmanSelected.includes("ping");
      if ((mainPing || wingmanPing) && (!config.csParticipantRoleId || !config.manualCsParticipantRoleId)) throw new Error(getBotText("notifyCsParticipants.rolesMissing"));
      await csNotificationPreferencesStore.updateCompetition("main", { startAt: mainStart, reminderOffsets: offsets(mainSelected), ping: mainPing });
      await csNotificationPreferencesStore.updateCompetition("wingman", { startAt: wingmanStart, reminderOffsets: offsets(wingmanSelected), ping: wingmanPing });
      const main = await replaceReminders("main", mainStart ?? undefined, offsets(mainSelected), mainPing, session.userId);
      const wingman = await replaceReminders("wingman", wingmanStart ?? undefined, offsets(wingmanSelected), wingmanPing, session.userId);
      const skipped = main.skipped + wingman.skipped;
      await interaction.reply({ content: `Lagret. ${main.created} Main-varsler og ${wingman.created} Wingman-varsler planlagt.${skipped ? ` ${skipped} ble hoppet over fordi tiden var passert.` : ""}`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : getBotText("csNotificationConsole.failed"), flags: MessageFlags.Ephemeral });
    }
  }
};
