import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction
} from "discord.js";
import { config } from "./config.js";

const SET_NICKNAME_BUTTON_ID = "set-nickname-button";
const SET_NICKNAME_MODAL_ID = "set-nickname-modal";
const NICKNAME_INPUT_ID = "nickname-input";

export async function sendWelcomeMessage(member: GuildMember): Promise<void> {
  if (!config.welcomeChannelId) {
    return;
  }

  const channel = await member.guild.channels.fetch(config.welcomeChannelId);

  if (!channel?.isTextBased()) {
    console.error(`Welcome channel ${config.welcomeChannelId} is not a text channel.`);
    return;
  }

  const button = new ButtonBuilder()
    .setCustomId(SET_NICKNAME_BUTTON_ID)
    .setLabel("Sett kallenavn")
    .setStyle(ButtonStyle.Primary);

  await channel.send({
    content: `Velkommen ${member}! Sett et kallenavn slik at folk skjonner hvem du er.`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)]
  });
}

export async function handleSetNicknameButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId !== SET_NICKNAME_BUTTON_ID) {
    return;
  }

  const nicknameInput = new TextInputBuilder()
    .setCustomId(NICKNAME_INPUT_ID)
    .setLabel("Kallenavn")
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(32)
    .setRequired(true);

  const modal = new ModalBuilder()
    .setCustomId(SET_NICKNAME_MODAL_ID)
    .setTitle("Sett kallenavn")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nicknameInput));

  await interaction.showModal(modal);
}

export async function handleSetNicknameModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId !== SET_NICKNAME_MODAL_ID || !interaction.member || !interaction.guild) {
    return;
  }

  const nickname = interaction.fields.getTextInputValue(NICKNAME_INPUT_ID).trim();

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    await member.setNickname(nickname, "Member set their own nickname via welcome button");
    await interaction.reply({ content: `Kallenavnet ditt er satt til "${nickname}".`, ephemeral: true });
  } catch (error) {
    console.error(`Failed to set nickname for ${interaction.user.id}`, error);
    await interaction.reply({
      content: "Klarte ikke sette kallenavnet. Boten mangler kanskje rettigheter, eller navnet er ugyldig.",
      ephemeral: true
    });
  }
}
