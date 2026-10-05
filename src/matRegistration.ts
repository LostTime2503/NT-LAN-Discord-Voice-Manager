import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RadioGroupBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type Role
} from "discord.js";
import { getMealTime } from "./mealSettings.js";

const REGISTER_BUTTON_ID = "mat-registration-button";
const REGISTER_MODAL_ID = "mat-registration-modal";
const NICKNAME_INPUT_ID = "mat-registration-nickname";
const MAT_PULJE_INPUT_ID = "mat-registration-mat-pulje";
const PULJE_ROLE_PATTERN = /^Matpulje [12]$/;
const LEGACY_PULJE_ROLE_PATTERN = /^Pulje \d+ – runde [12]$/;
const NO_MEAL_ROLE_NAME = "Ingen mat";

export function createMatRegistrationButton(): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(REGISTER_BUTTON_ID)
    .setLabel("Registrer navn og matpulje")
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

export async function handleMatRegistrationButton(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.customId !== REGISTER_BUTTON_ID) {
    return false;
  }

  const [puljeOneTime, puljeTwoTime] = await Promise.all([getMealTime(1), getMealTime(2)]);
  const nickname = new TextInputBuilder()
    .setCustomId(NICKNAME_INPUT_ID)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Skriv navnet du vil bruke i Discord")
    .setMinLength(1)
    .setMaxLength(32)
    .setRequired(true);
  const matPulje = new RadioGroupBuilder()
    .setCustomId(MAT_PULJE_INPUT_ID)
    .addOptions(
      { label: `Matpulje 1 - servering kl. ${puljeOneTime}`, value: "1" },
      { label: `Matpulje 2 - servering kl. ${puljeTwoTime}`, value: "2" },
      { label: "Jeg skal ikke ha mat", value: "none" }
    )
    .setRequired(true);

  const modal = new ModalBuilder()
    .setCustomId(REGISTER_MODAL_ID)
    .setTitle("Navn og matpulje")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Ønsket kallenavn")
        .setDescription("Bruk et navn folk kjenner deg igjen på i Discord.")
        .setTextInputComponent(nickname),
      new LabelBuilder()
        .setLabel("Hvilken matpulje har du fått?")
        .setRadioGroupComponent(matPulje)
    );

  await interaction.showModal(modal);
  return true;
}

export async function handleMatRegistrationModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (interaction.customId !== REGISTER_MODAL_ID || !interaction.guild) {
    return false;
  }

  const nickname = interaction.fields.getTextInputValue(NICKNAME_INPUT_ID).trim();
  const selection = parseMealSelection(interaction.fields.getRadioGroup(MAT_PULJE_INPUT_ID, true));

  if (selection === null) {
    await interaction.reply({
      content: "Velg matpulje 1, matpulje 2 eller at du ikke skal ha mat.",
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  try {
    const mealTime = selection === "none" ? null : await getMealTime(selection);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    await member.setNickname(nickname, "Member registered their name and groups");

    if (selection === "none") {
      await setNoMealRole(member);
      await interaction.reply({
        content: "Kallenavnet er lagret. Du er registrert som at du ikke skal ha mat.",
        flags: MessageFlags.Ephemeral
      });
    } else {
      await setPuljeRole(member, selection);
      await interaction.reply({
        content: `Registreringen er lagret. Du er satt opp for matpulje ${selection}, med servering kl. ${mealTime}.`,
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error(`Failed to save mat registration for ${interaction.user.id}`, error);
    await interaction.reply({
      content: "Klarte ikke lagre registreringen. Boten trenger rettighet til å endre kallenavn og administrere roller.",
      flags: MessageFlags.Ephemeral
    });
  }

  return true;
}

export async function ensurePuljeRole(member: GuildMember, pulje: 1 | 2) {
  const roleName = getPuljeRoleName(pulje);
  const role = member.guild.roles.cache.find((candidate) => candidate.name === roleName)
    ?? await member.guild.roles.create({ name: roleName, reason: "Create meal group notification role" });

  return role;
}

async function setPuljeRole(member: GuildMember, pulje: 1 | 2): Promise<void> {
  const role = await ensurePuljeRole(member, pulje);
  await replaceMealRegistrationRole(member, role, `Registered for meal group ${pulje}`);
}

async function setNoMealRole(member: GuildMember): Promise<void> {
  const role = member.guild.roles.cache.find((candidate) => candidate.name === NO_MEAL_ROLE_NAME)
    ?? await member.guild.roles.create({ name: NO_MEAL_ROLE_NAME, reason: "Create no-meal registration role" });
  await replaceMealRegistrationRole(member, role, "Registered for no meal");
}

async function replaceMealRegistrationRole(member: GuildMember, role: Role, reason: string): Promise<void> {
  const rolesToRemove = member.roles.cache.filter((candidate) =>
    candidate.id !== role.id && isMealRegistrationRole(candidate.name)
  );

  await member.roles.add(role, reason);

  if (rolesToRemove.size > 0) {
    await member.roles.remove(rolesToRemove, "Updated meal registration");
  }
}

function isMealRegistrationRole(roleName: string): boolean {
  return roleName === NO_MEAL_ROLE_NAME
    || PULJE_ROLE_PATTERN.test(roleName)
    || LEGACY_PULJE_ROLE_PATTERN.test(roleName);
}

function parseMealSelection(value: string): 1 | 2 | "none" | null {
  const normalizedValue = value.trim();

  if (normalizedValue === "1") {
    return 1;
  }

  if (normalizedValue === "2") {
    return 2;
  }

  return normalizedValue === "none" ? "none" : null;
}

function getPuljeRoleName(pulje: 1 | 2): string {
  return `Matpulje ${pulje}`;
}