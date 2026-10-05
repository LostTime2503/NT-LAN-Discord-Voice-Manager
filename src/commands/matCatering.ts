import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CheckboxGroupBuilder,
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction
} from "discord.js";
import { config } from "../config.js";
import { ensurePuljeRole, createMatRegistrationButton } from "../matRegistration.js";
import {
  getLastMealPlanDate,
  getMealReminderSelections,
  getMealTime,
  getMealTimes,
  isValidMealTime,
  setMealReminderSelections,
  setMealTime,
  type MealReminderOffset,
  type MealReminderSelections
} from "../mealSettings.js";
import {
  getCurrentOsloDate,
  cancelMealSchedules,
  getMealSchedules,
  isValidEventDate,
  scheduleMealPlan,
  type PlannedMealGroup
} from "../mealScheduler.js";

const MEAL_PLAN_MODAL_ID = "meal-plan-modal";
const MEAL_PLAN_DATE_ID = "meal-plan-date";
const PULJE_ONE_TIME_ID = "meal-plan-pulje-one-time";
const PULJE_ONE_REMINDERS_ID = "meal-plan-pulje-one-reminders";
const PULJE_TWO_TIME_ID = "meal-plan-pulje-two-time";
const PULJE_TWO_REMINDERS_ID = "meal-plan-pulje-two-reminders";
const PLAN_REPLACE_PREFIX = "meal-plan-replace:";
const PLAN_CANCEL_PREFIX = "meal-plan-cancel:";

interface PendingMealPlan {
  userId: string;
  guildId: string;
  channelId: string;
  eventDate: string;
  groups: PlannedMealGroup[];
  reminderSelections: MealReminderSelections;
  times: Record<1 | 2, string>;
}

const pendingMealPlans = new Map<string, PendingMealPlan>();

export const setupNameAndPuljeCommand = {
  data: new SlashCommandBuilder()
    .setName("setup-kallenavn-og-puljer")
    .setDescription("Publiser knappen for registrering av kallenavn og puljer.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = config.modalChannelId
      ? await interaction.client.channels.fetch(config.modalChannelId)
      : null;

    if (!interaction.guild || !channel || channel.type !== ChannelType.GuildText || channel.guildId !== interaction.guild.id) {
      await interaction.reply({
        content: "Sett MODAL_CHANNEL_ID til en tekstkanal på denne serveren før kommandoen brukes.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await channel.send({
      content: "**Registrering av navn og matpulje**\nBruk et kallenavn som gjør det lett for andre å kjenne deg igjen på Discord. Gjeldende serveringstider vises i skjemaet. Velg «Jeg skal ikke ha mat» hvis du ikke skal spise. Svarene er private. Trykk på knappen under for å registrere deg.",
      components: [createMatRegistrationButton()]
    });
    await interaction.reply({ content: `Registreringsknappen er publisert i <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
  }
};

export const matAnnouncementCommand = {
  data: new SlashCommandBuilder()
    .setName("matvarsel")
    .setDescription("Send beskjed om mat i varselkanalen.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((option) =>
      option.setName("melding").setDescription("Beskjeden som skal sendes").setRequired(true).setMaxLength(1800)
    )
    .addIntegerOption((option) =>
      option.setName("pulje").setDescription("Matpuljen som skal varsles").setRequired(true)
        .addChoices({ name: "Pulje 1", value: 1 }, { name: "Pulje 2", value: 2 })
    )
    .addBooleanOption((option) =>
      option.setName("varsle_pulje").setDescription("Nevn puljerollen i meldingen").setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = config.announcementChannelId
      ? await interaction.client.channels.fetch(config.announcementChannelId)
      : null;

    if (!interaction.guild || !channel || channel.type !== ChannelType.GuildText || channel.guildId !== interaction.guild.id) {
      await interaction.reply({
        content: "Sett ANNOUNCEMENT_CHANNEL_ID til en tekstkanal på denne serveren før kommandoen brukes.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const message = interaction.options.getString("melding", true);
    const pulje = interaction.options.getInteger("pulje", true) as 1 | 2;
    const notifyGroup = interaction.options.getBoolean("varsle_pulje") ?? false;
    let content = message;
    let roleId: string | undefined;

    if (notifyGroup) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const role = await ensurePuljeRole(member, pulje);
      content = `<@&${role.id}> ${message}`;
      roleId = role.id;
    }

    await channel.send({
      content,
      allowedMentions: roleId ? { roles: [roleId] } : { parse: [] }
    });
    await interaction.reply({ content: `Matvarselet er sendt til <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
  }
};

export const notifyPuljeOneCommand = createMealNotificationCommand(1);
export const notifyPuljeTwoCommand = createMealNotificationCommand(2);

export const mealStatusCommand = {
  data: new SlashCommandBuilder()
    .setName("matstatus")
    .setDescription("Vis antall registrerte i hver matpulje."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireCrewOrHigher(interaction))) {
      return;
    }

    const guild = interaction.guild!;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [members] = await Promise.all([guild.members.fetch(), guild.roles.fetch()]);
    const mealTimes = await getMealTimes();
    const countForRole = (roleName: string): number => {
      const role = guild.roles.cache.find((candidate) => candidate.name === roleName);
      return role ? members.filter((member) => !member.user.bot && member.roles.cache.has(role.id)).size : 0;
    };

    await interaction.editReply(
      `Registreringer:\nMatpulje 1 (${mealTimes[1]}): ${countForRole("Matpulje 1")}\nMatpulje 2 (${mealTimes[2]}): ${countForRole("Matpulje 2")}\nSkal ikke ha mat: ${countForRole("Ingen mat")}`
    );
  }
};

export const listMealPlansCommand = {
  data: new SlashCommandBuilder()
    .setName("vis-matplan")
    .setDescription("Vis kommende planlagte matvarsler."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireCrewOrHigher(interaction))) {
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const schedules = (await getMealSchedules(interaction.guild!.id))
      .filter((schedule) => new Date(schedule.serviceAt).getTime() > Date.now())
      .sort((left, right) => left.serviceAt.localeCompare(right.serviceAt));

    if (schedules.length === 0) {
      await interaction.editReply("Det er ingen kommende matplaner.");
      return;
    }

    const summary = schedules.map((schedule) => {
      const reminders = schedule.reminders
        .filter((reminder) => !reminder.sent)
        .map((reminder) => reminder.minutesBefore === 0 ? "ved start" : `${reminder.minutesBefore} min før`)
        .join(", ");
      return `• ${schedule.eventDate} - Matpulje ${schedule.pulje} kl. ${schedule.serviceTime}; ${reminders || "ingen varsler gjenstår"}`;
    });
    await interaction.editReply(`Kommende matplaner:\n${summary.join("\n")}`);
  }
};

export const cancelMealPlanCommand = {
  data: new SlashCommandBuilder()
    .setName("avlys-matplan")
    .setDescription("Avlys planlagte matvarsler for en dato eller pulje.")
    .addStringOption((option) =>
      option.setName("dato").setDescription("Dato i YYYY-MM-DD-format; standard er i dag.")
        .setRequired(false).setMinLength(10).setMaxLength(10)
    )
    .addIntegerOption((option) =>
      option.setName("pulje").setDescription("La stå tom for å avlyse begge puljene")
        .setRequired(false).addChoices({ name: "Matpulje 1", value: 1 }, { name: "Matpulje 2", value: 2 })
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireCrewOrHigher(interaction))) {
      return;
    }

    const eventDate = interaction.options.getString("dato") ?? getCurrentOsloDate();
    if (!isValidEventDate(eventDate)) {
      await interaction.reply({ content: "Skriv datoen som YYYY-MM-DD.", flags: MessageFlags.Ephemeral });
      return;
    }

    const selectedPulje = interaction.options.getInteger("pulje");
    const pulje = selectedPulje === null ? undefined : selectedPulje as 1 | 2;
    const cancelledCount = await cancelMealSchedules(interaction.guild!.id, eventDate, pulje);
    const label = pulje === undefined ? "begge puljene" : `Matpulje ${pulje}`;
    await interaction.reply({
      content: cancelledCount > 0
        ? `Avlyste ${cancelledCount} plan(er) for ${label} den ${eventDate}.`
        : `Fant ingen aktive planer for ${label} den ${eventDate}.`,
      flags: MessageFlags.Ephemeral
    });
  }
};

function createMealNotificationCommand(pulje: 1 | 2) {
  return {
    data: new SlashCommandBuilder()
      .setName(`varsle-pulje${pulje}`)
      .setDescription(`Varsle Matpulje ${pulje} om at maten er klar.`),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
      if (!(await requireCrewOrHigher(interaction))) {
        return;
      }

      const guild = interaction.guild!;
      const channel = config.announcementChannelId
        ? await interaction.client.channels.fetch(config.announcementChannelId)
        : null;

      if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== guild.id) {
        await interaction.reply({
          content: "Sett ANNOUNCEMENT_CHANNEL_ID til en tekstkanal på denne serveren før kommandoen brukes.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const member = await guild.members.fetch(interaction.user.id);
      const role = await ensurePuljeRole(member, pulje);
      const time = await getMealTime(pulje);
      await channel.send({
        content: `<@&${role.id}> Matpulje ${pulje}: Maten er klar. Servering kl. ${time}.`,
        allowedMentions: { roles: [role.id] }
      });
      await interaction.reply({
        content: `Varsel sendt til Matpulje ${pulje} i <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral
      });
    }
  };
}

export const setMealTimeCommand = {
  data: new SlashCommandBuilder()
    .setName("sett-puljetid")
    .setDescription("Endre serveringstid for en matpulje.")
    .addIntegerOption((option) =>
      option.setName("pulje").setDescription("Puljen som skal endres").setRequired(true)
        .addChoices({ name: "Matpulje 1", value: 1 }, { name: "Matpulje 2", value: 2 })
    )
    .addStringOption((option) =>
      option.setName("tid").setDescription("Ny serveringstid i 24-timersformat, f.eks. 17:30")
        .setRequired(true).setMinLength(5).setMaxLength(5)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireCrewOrHigher(interaction))) {
      return;
    }

    const pulje = interaction.options.getInteger("pulje", true) as 1 | 2;
    const time = interaction.options.getString("tid", true);
    if (!isValidMealTime(time)) {
      await interaction.reply({
        content: "Skriv klokkeslettet i 24-timersformat, for eksempel 17:30.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    try {
      await setMealTime(pulje, time);
      await interaction.reply({
        content: `Serveringstiden for Matpulje ${pulje} er endret til kl. ${time}.`,
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error("Failed to save meal service time", error);
      await interaction.reply({
        content: "Klarte ikke lagre tiden. Kontroller at boten kan skrive til datamappen.",
        flags: MessageFlags.Ephemeral
      });
    }
  }
};

export const planMealCommand = {
  data: new SlashCommandBuilder()
    .setName("planlegg-mat")
    .setDescription("Planlegg tider og varsler for begge puljene; erstatter planen for datoen."),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireCrewOrHigher(interaction))) {
      return;
    }

    const channel = config.announcementChannelId
      ? await interaction.client.channels.fetch(config.announcementChannelId)
      : null;
    if (!interaction.guild || !channel || channel.type !== ChannelType.GuildText || channel.guildId !== interaction.guild.id) {
      await interaction.reply({
        content: "Sett ANNOUNCEMENT_CHANNEL_ID til en tekstkanal på denne serveren før kommandoen brukes.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const [times, reminderSelections, lastPlanDate] = await Promise.all([
      getMealTimes(),
      getMealReminderSelections(),
      getLastMealPlanDate()
    ]);
    const currentDate = getCurrentOsloDate();
    const eventDate = lastPlanDate && lastPlanDate >= currentDate ? lastPlanDate : currentDate;
    await interaction.showModal(createMealPlanModal(eventDate, times, reminderSelections));
  }
};

export function createMealPlanModal(
  eventDate: string,
  times: Record<1 | 2, string>,
  reminderSelections: MealReminderSelections
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(MEAL_PLAN_MODAL_ID)
    .setTitle("Planlegg matservering")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Dato for servering (ÅÅÅÅ-MM-DD)")
        .setTextInputComponent(new TextInputBuilder()
          .setCustomId(MEAL_PLAN_DATE_ID)
          .setStyle(TextInputStyle.Short)
          .setValue(eventDate)
          .setMinLength(10)
          .setMaxLength(10)
          .setRequired(true)),
      new LabelBuilder()
        .setLabel("Serveringstid for Matpulje 1")
        .setTextInputComponent(createTimeInput(PULJE_ONE_TIME_ID, times[1])),
      new LabelBuilder()
        .setLabel("Varsler for Matpulje 1")
        .setCheckboxGroupComponent(createReminderCheckboxes(PULJE_ONE_REMINDERS_ID, reminderSelections[1])),
      new LabelBuilder()
        .setLabel("Serveringstid for Matpulje 2")
        .setTextInputComponent(createTimeInput(PULJE_TWO_TIME_ID, times[2])),
      new LabelBuilder()
        .setLabel("Varsler for Matpulje 2")
        .setCheckboxGroupComponent(createReminderCheckboxes(PULJE_TWO_REMINDERS_ID, reminderSelections[2]))
    );
}

export async function handleMealPlanModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (interaction.customId !== MEAL_PLAN_MODAL_ID) {
    return false;
  }

  if (!interaction.guild || !(await requireCrewOrHigher(interaction))) {
    return true;
  }

  const channel = config.announcementChannelId
    ? await interaction.client.channels.fetch(config.announcementChannelId)
    : null;
  if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== interaction.guild.id) {
    await interaction.reply({
      content: "Sett ANNOUNCEMENT_CHANNEL_ID til en tekstkanal på denne serveren før kommandoen brukes.",
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  const eventDate = interaction.fields.getTextInputValue(MEAL_PLAN_DATE_ID).trim();
  const puljeOneTime = interaction.fields.getTextInputValue(PULJE_ONE_TIME_ID).trim();
  const puljeTwoTime = interaction.fields.getTextInputValue(PULJE_TWO_TIME_ID).trim();
  if (!isValidEventDate(eventDate)) {
    await interaction.reply({ content: "Skriv datoen som YYYY-MM-DD.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!isValidMealTime(puljeOneTime) || !isValidMealTime(puljeTwoTime)) {
    await interaction.reply({
      content: "Skriv begge klokkeslett i 24-timersformat, for eksempel 17:30.",
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  const groups: PlannedMealGroup[] = [
    {
      pulje: 1,
      serviceTime: puljeOneTime,
      reminderOffsets: parseReminderOffsets(interaction.fields.getCheckboxGroup(PULJE_ONE_REMINDERS_ID))
    },
    {
      pulje: 2,
      serviceTime: puljeTwoTime,
      reminderOffsets: parseReminderOffsets(interaction.fields.getCheckboxGroup(PULJE_TWO_REMINDERS_ID))
    }
  ];

  if (groups.every((group) => group.reminderOffsets.length === 0)) {
    await interaction.reply({
      content: "Velg minst ett varsel for pulje 1 eller pulje 2.",
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  try {
    const times = { 1: puljeOneTime, 2: puljeTwoTime };
    const reminderSelections: MealReminderSelections = {
      1: groups[0].reminderOffsets,
      2: groups[1].reminderOffsets
    };
    const existingPlans = await getMealSchedules(interaction.guild.id, eventDate);

    if (existingPlans.length > 0) {
      const token = randomUUID();
      pendingMealPlans.set(token, {
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        channelId: channel.id,
        eventDate,
        groups,
        reminderSelections,
        times
      });
      const timeout = setTimeout(() => pendingMealPlans.delete(token), 15 * 60 * 1000);
      timeout.unref();

      await interaction.reply({
        content: `Det finnes allerede en plan for ${eventDate}. Hvis du fortsetter, erstattes planene for begge puljene. Vil du fortsette?\n${formatMealPlanSummary(eventDate, groups)}`,
        components: [createPlanReplacementButtons(token)],
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    await storeMealPlan(interaction.guild.id, channel.id, eventDate, groups, times, reminderSelections);
    await interaction.reply({
      content: `${formatMealPlanSummary(eventDate, groups)}\nIngen mat: ingen plan eller varsler.`,
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    if (error instanceof Error && error.message === "SERVICE_TIME_NOT_IN_FUTURE") {
      await interaction.reply({
        content: "En pulje med valgte varsler må ha serveringstid i framtiden.",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    if (error instanceof Error && error.message === "INVALID_OSLO_DATETIME") {
      await interaction.reply({
        content: "En av tidene finnes ikke på denne datoen i tidssonen Europe/Oslo.",
        flags: MessageFlags.Ephemeral
      });
      return true;
    }

    console.error("Failed to save meal plan", error);
    await interaction.reply({
      content: "Klarte ikke lagre planen. Kontroller at boten kan skrive til datamappen.",
      flags: MessageFlags.Ephemeral
    });
  }

  return true;
}

export async function handleMealPlanReplacementButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(PLAN_REPLACE_PREFIX) && !interaction.customId.startsWith(PLAN_CANCEL_PREFIX)) {
    return false;
  }

  const isReplacement = interaction.customId.startsWith(PLAN_REPLACE_PREFIX);
  const token = interaction.customId.slice((isReplacement ? PLAN_REPLACE_PREFIX : PLAN_CANCEL_PREFIX).length);
  const pendingPlan = pendingMealPlans.get(token);
  if (!pendingPlan) {
    await interaction.reply({ content: "Denne bekreftelsen har utløpt. Åpne `/planlegg-mat` på nytt.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (pendingPlan.userId !== interaction.user.id) {
    await interaction.reply({ content: "Bare personen som startet planleggingen kan bekrefte den.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!(await requireCrewOrHigher(interaction))) {
    return true;
  }

  pendingMealPlans.delete(token);
  if (!isReplacement) {
    await interaction.update({ content: "Planlegging avbrutt. Eksisterende planer er beholdt.", components: [] });
    return true;
  }

  try {
    await storeMealPlan(
      pendingPlan.guildId,
      pendingPlan.channelId,
      pendingPlan.eventDate,
      pendingPlan.groups,
      pendingPlan.times,
      pendingPlan.reminderSelections
    );
    await interaction.update({
      content: `${formatMealPlanSummary(pendingPlan.eventDate, pendingPlan.groups)}\nEksisterende planer for begge puljene er erstattet.`,
      components: []
    });
  } catch (error) {
    await replyToPlanSaveError(interaction, error, true);
  }

  return true;
}

async function storeMealPlan(
  guildId: string,
  channelId: string,
  eventDate: string,
  groups: PlannedMealGroup[],
  times: Record<1 | 2, string>,
  reminderSelections: MealReminderSelections
): Promise<void> {
  await scheduleMealPlan(guildId, channelId, eventDate, groups);
  await Promise.all([
    setMealTime(1, times[1]),
    setMealTime(2, times[2]),
    setMealReminderSelections(reminderSelections, eventDate)
  ]);
}

function createPlanReplacementButtons(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PLAN_REPLACE_PREFIX}${token}`)
      .setLabel("Erstatt plan")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${PLAN_CANCEL_PREFIX}${token}`)
      .setLabel("Behold eksisterende")
      .setStyle(ButtonStyle.Secondary)
  );
}

function formatMealPlanSummary(eventDate: string, groups: PlannedMealGroup[]): string {
  const summary = groups.map((group) =>
    `Matpulje ${group.pulje}: kl. ${group.serviceTime}; ${formatReminderSelection(group.reminderOffsets)}`
  ).join("\n");
  return `Matplan for ${eventDate} (Europe/Oslo):\n${summary}`;
}

async function replyToPlanSaveError(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction,
  error: unknown,
  updateExistingReply = false
): Promise<void> {
  if (error instanceof Error && error.message === "SERVICE_TIME_NOT_IN_FUTURE") {
    const content = "En pulje med valgte varsler må ha serveringstid i framtiden.";
    if (updateExistingReply && interaction.isButton()) {
      await interaction.update({ content, components: [] });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (error instanceof Error && error.message === "INVALID_OSLO_DATETIME") {
    const content = "En av tidene finnes ikke på denne datoen i tidssonen Europe/Oslo.";
    if (updateExistingReply && interaction.isButton()) {
      await interaction.update({ content, components: [] });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  console.error("Failed to save meal plan", error);
  const content = "Klarte ikke lagre planen. Kontroller at boten kan skrive til datamappen.";
  if (updateExistingReply && interaction.isButton()) {
    await interaction.update({ content, components: [] });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

function createTimeInput(customId: string, value: string): TextInputBuilder {
  return new TextInputBuilder()
    .setCustomId(customId)
    .setStyle(TextInputStyle.Short)
    .setValue(value)
    .setMinLength(5)
    .setMaxLength(5)
    .setRequired(true);
}

function createReminderCheckboxes(
  customId: string,
  selectedOffsets: readonly MealReminderOffset[]
): CheckboxGroupBuilder {
  return new CheckboxGroupBuilder()
    .setCustomId(customId)
    .addOptions(
      { label: "Når serveringen starter", value: "0", default: selectedOffsets.includes(0) },
      { label: "30 minutter før", value: "30", default: selectedOffsets.includes(30) },
      { label: "10 minutter før", value: "10", default: selectedOffsets.includes(10) }
    )
    .setMinValues(0)
    .setMaxValues(3)
    .setRequired(false);
}

function parseReminderOffsets(selectedValues: readonly string[]): MealReminderOffset[] {
  return selectedValues
    .filter((value): value is "0" | "10" | "30" => value === "0" || value === "10" || value === "30")
    .map((value) => Number(value) as 0 | 10 | 30);
}

function formatReminderSelection(offsets: Array<0 | 10 | 30>): string {
  if (offsets.length === 0) {
    return "ingen varsler valgt";
  }

  return offsets.map((offset) => offset === 0 ? "ved start" : `${offset} min før`).join(", ");
}

async function requireCrewOrHigher(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Denne kommandoen kan bare brukes på serveren.", flags: MessageFlags.Ephemeral });
    return false;
  }

  const member = await guild.members.fetch(interaction.user.id);
  if (member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  if (!config.crewRoleId) {
    await interaction.reply({
      content: "Crew-kommandoene er ikke konfigurert ennå. Sett CREW_ROLE_ID i .env.",
      flags: MessageFlags.Ephemeral
    });
    return false;
  }

  const crewRole = await guild.roles.fetch(config.crewRoleId).catch(() => null);
  if (!crewRole || crewRole.id === guild.id) {
    await interaction.reply({
      content: "CREW_ROLE_ID peker ikke på en gyldig Crew-rolle.",
      flags: MessageFlags.Ephemeral
    });
    return false;
  }

  if (member.roles.highest.comparePositionTo(crewRole) >= 0) {
    return true;
  }

  await interaction.reply({
    content: "Denne kommandoen er bare tilgjengelig for matcrew og roller over Crew.",
    flags: MessageFlags.Ephemeral
  });
  return false;
}