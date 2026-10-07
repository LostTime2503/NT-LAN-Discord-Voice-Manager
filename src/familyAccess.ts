import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, type ButtonInteraction, type Client,
  type GuildMember, type ModalSubmitInteraction, type StringSelectMenuInteraction, type UserSelectMenuInteraction
} from "discord.js";
import { FAMILY_CHILD_BUTTON_ID, FAMILY_PARENT_BUTTON_ID, type AccessManager } from "./accessManager.js";
import { FamilyStore, normalizeChildName } from "./familyStore.js";
import type { RegisteredChild, RegisteredPerson } from "./registrationClient.js";

const LINK_PARENT_BUTTON = "family:link-parent";
const INVITE_PARENT_BUTTON = "family:invite-parent";
const REVIEW_PARENT_BUTTON = "family:review-parent";
const LINKS_PARENT_BUTTON = "family:links-parent";
const PARENT_CHILD_SELECT = "family:parent-child";
const EXISTING_MEMBER_SELECT = "family:existing-member";
const CHILD_PARENT_SELECT = "family:child-parent";
const INVITE_CHILD_SELECT = "family:invite-child";
const INVITE_MODAL_PREFIX = "family:invite-modal:";
const INVITE_USERNAME_INPUT = "family:invite-username";
const REVIEW_SELECT = "family:review-select";
const LINK_REMOVE_SELECT = "family:link-remove";
const REQUEST_CHILD_PREFIX = "family:request-child:";
const APPROVE_REQUEST_PREFIX = "family:approve-request:";
const REJECT_REQUEST_PREFIX = "family:reject-request:";
const APPROVE_CLAIM_PREFIX = "family:approve-claim:";
const REJECT_CLAIM_PREFIX = "family:reject-claim:";
const CONFIRM_LINK_PREFIX = "family:confirm-link:";
const CANCEL_LINK_PREFIX = "family:cancel-link:";
const REVIEW_APPROVE = "family:review-approve";
const REVIEW_REJECT = "family:review-reject";
const REVIEW_CANCEL = "family:review-cancel";
const FLOW_TTL_MS = 15 * 60 * 1000;

interface LinkConfirmation {
  parentId: string;
  childName: string;
  childDiscordId: string;
  expiresAt: number;
}
interface ReviewSelection {
  parentId: string;
  kind: "request" | "claim" | "invite";
  id: string;
}
interface PendingInviteSelection {
  parentId: string;
  childName: string;
  expiresAt: number;
}

function parentRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(LINK_PARENT_BUTTON).setLabel("Koble et barn som er pa serveren").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(INVITE_PARENT_BUTTON).setLabel("Forbered barnets innmelding").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(REVIEW_PARENT_BUTTON).setLabel("Se foresporsler og invitasjoner").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(LINKS_PARENT_BUTTON).setLabel("Mine barnekoblinger").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function uniqueChildren(children: RegisteredChild[]): RegisteredChild[] {
  const counts = new Map<string, number>();
  for (const child of children) counts.set(normalizeChildName(child.name), (counts.get(normalizeChildName(child.name)) ?? 0) + 1);
  return children.filter((child) => normalizeChildName(child.name).length > 0 && child.name.length <= 100
    && counts.get(normalizeChildName(child.name)) === 1);
}

function childMenu(customId: string, placeholder: string, children: RegisteredChild[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const available = uniqueChildren(children);
  if (!available.length) throw new Error("Ingen barn har et unikt navn som kan kobles trygt. Be nettsideansvarlig avklare duplikater eller lange navn.");
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1)
      .addOptions(available.slice(0, 25).map((child) => ({
        label: child.name.slice(0, 100),
        description: "Registrert under din nettsidekonto",
        value: child.name
      })))
  );
}

function userPicker(customId: string, placeholder: string): ActionRowBuilder<UserSelectMenuBuilder> {
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1)
  );
}

function confirmationRow(customId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CONFIRM_LINK_PREFIX}${customId}`).setLabel("Bekreft familiekobling").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CANCEL_LINK_PREFIX}${customId}`).setLabel("Avbryt").setStyle(ButtonStyle.Secondary)
  );
}

export class FamilyAccessFlow {
  private readonly selectedChildren = new Map<string, { childName: string; expiresAt: number }>();
  private readonly selectedInviteChildren = new Map<string, PendingInviteSelection>();
  private readonly confirmations = new Map<string, LinkConfirmation>();
  private readonly reviews = new Map<string, ReviewSelection>();

  constructor(
    private readonly access: AccessManager,
    private readonly store: FamilyStore,
    private readonly getParticipants: () => Promise<Map<string, RegisteredPerson>>,
    private readonly client: Client
  ) {}

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === FAMILY_PARENT_BUTTON_ID) return this.startParent(interaction);
    if (interaction.customId === FAMILY_CHILD_BUTTON_ID) return this.startChild(interaction);
    if (interaction.customId === LINK_PARENT_BUTTON) return this.startExistingLink(interaction);
    if (interaction.customId === INVITE_PARENT_BUTTON) return this.showInviteChildren(interaction);
    if (interaction.customId === REVIEW_PARENT_BUTTON) return this.showReview(interaction);
    if (interaction.customId === LINKS_PARENT_BUTTON) return this.showLinks(interaction);
    if (interaction.customId === REVIEW_APPROVE) return this.approveSelectedReview(interaction);
    if (interaction.customId === REVIEW_REJECT) return this.rejectSelectedReview(interaction);
    if (interaction.customId === REVIEW_CANCEL) {
      this.reviews.delete(interaction.user.id);
      await interaction.update({ content: "Handlingen ble avbrutt.", components: [] });
      return;
    }
    if (interaction.customId.startsWith(CONFIRM_LINK_PREFIX)) return this.confirmLink(interaction);
    if (interaction.customId.startsWith(CANCEL_LINK_PREFIX)) return this.cancelLink(interaction);
    if (interaction.customId.startsWith(APPROVE_REQUEST_PREFIX)) return this.approveRequest(interaction, interaction.customId.slice(APPROVE_REQUEST_PREFIX.length));
    if (interaction.customId.startsWith(REJECT_REQUEST_PREFIX)) return this.rejectRequest(interaction, interaction.customId.slice(REJECT_REQUEST_PREFIX.length));
    if (interaction.customId.startsWith(APPROVE_CLAIM_PREFIX)) return this.approveClaim(interaction, interaction.customId.slice(APPROVE_CLAIM_PREFIX.length));
    if (interaction.customId.startsWith(REJECT_CLAIM_PREFIX)) return this.rejectClaim(interaction, interaction.customId.slice(REJECT_CLAIM_PREFIX.length));
  }

  async handleStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === PARENT_CHILD_SELECT) return this.selectChildForLink(interaction);
    if (interaction.customId === INVITE_CHILD_SELECT) return this.showInviteModal(interaction);
    if (interaction.customId === REVIEW_SELECT) return this.selectReview(interaction);
    if (interaction.customId === LINK_REMOVE_SELECT) return this.removeLink(interaction);
    if (interaction.customId.startsWith(REQUEST_CHILD_PREFIX)) {
      return this.approveRequestWithChild(interaction, interaction.customId.slice(REQUEST_CHILD_PREFIX.length));
    }
  }

  async handleUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
    if (interaction.customId === EXISTING_MEMBER_SELECT) return this.selectExistingMember(interaction);
    if (interaction.customId === CHILD_PARENT_SELECT) return this.createChildRequest(interaction);
  }

  async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId.startsWith(INVITE_MODAL_PREFIX)) return this.createInvite(interaction);
  }

  async handleJoin(member: GuildMember): Promise<void> {
    if (this.access.settings.dryRun || member.guild.id !== this.access.settings.guildId || member.user.bot) return;
    const invite = await this.store.findInviteByUsername(member.user.username);
    if (!invite) return;
    const claim = await this.store.addClaim(invite, member.id);
    try {
      const parent = await this.client.users.fetch(claim.parentDiscordId);
      await parent.send({
        content: `En konto som matcher den ventende invitasjonen for barnet ${claim.childName} har blitt med pa serveren. Godkjenn bare hvis riktig konto ble med og barnet oppfyller Discords alderskrav.`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${APPROVE_CLAIM_PREFIX}${claim.id}`).setLabel("Godkjenn").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`${REJECT_CLAIM_PREFIX}${claim.id}`).setLabel("Avvis").setStyle(ButtonStyle.Danger)
        )]
      });
    } catch {
      console.warn("Could not DM a guardian about a child invite claim; it remains available in the family channel inbox.");
    }
  }

  private isFamilyChannel(interaction: ButtonInteraction): boolean {
    return interaction.guildId === this.access.settings.guildId
      && interaction.channelId === this.access.settings.familyChannelId;
  }

  private async requireParent(discordId: string): Promise<RegisteredPerson> {
    const person = (await this.getParticipants()).get(discordId);
    if (!person || !person.children.length) throw new Error("Fant ingen registrerte barn pa denne API-kontoen. Kontroller at riktig foresattkonto er koblet pa nettsiden.");
    return person;
  }

  private assertLiveWritesEnabled(): void {
    if (this.access.settings.dryRun) throw new Error("Familiekoblinger er deaktivert i ACCESS_DRY_RUN. Sett ACCESS_DRY_RUN=false og start boten pa nytt.");
  }

  private async startParent(interaction: ButtonInteraction): Promise<void> {
    if (!this.isFamilyChannel(interaction)) {
      await interaction.reply({ content: "Familieknappen virker bare i den konfigurerte familietilgangskanalen.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      content: "Velg en handling. Boten viser bare barna som ligger pa foresattkontoen din i API-et; familieopplysninger vises bare til deg.",
      components: parentRows(), flags: MessageFlags.Ephemeral
    });
  }

  private async startChild(interaction: ButtonInteraction): Promise<void> {
    if (!this.isFamilyChannel(interaction)) {
      await interaction.reply({ content: "Familieknappen virker bare i den konfigurerte familietilgangskanalen.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      content: "Bare bruk denne flyten hvis du oppfyller Discords alderskrav. Velg Discord-kontoen til foresatt; foresatt ma vaere registrert pa nettsiden. Du far ikke tilgang for foresatt har godkjent.",
      components: [userPicker(CHILD_PARENT_SELECT, "Velg foresatt pa denne serveren")], flags: MessageFlags.Ephemeral
    });
  }

  private async startExistingLink(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const parent = await this.requireParent(interaction.user.id);
    const row = childMenu(PARENT_CHILD_SELECT, "Velg barnet du vil koble", parent.children);
    await interaction.editReply({
      content: "Velg ditt registrerte barn. Deretter velger du barnets konto fra serveren og bekrefter koblingen.",
      components: [row]
    });
  }

  private async selectChildForLink(interaction: StringSelectMenuInteraction): Promise<void> {
    await interaction.deferUpdate();
    const parent = await this.requireParent(interaction.user.id);
    const child = parent.children.find((item) => normalizeChildName(item.name) === normalizeChildName(interaction.values[0]));
    if (!child) throw new Error("Barnelisten er endret. Start koblingen pa nytt.");
    if (parent.children.filter((item) => normalizeChildName(item.name) === normalizeChildName(child.name)).length !== 1) {
      throw new Error("Flere barn har samme fullt navn i API-et. Denne koblingen er blokkert sa vi ikke kobler feil barn.");
    }
    this.selectedChildren.set(interaction.user.id, { childName: child.name, expiresAt: Date.now() + FLOW_TTL_MS });
    await interaction.editReply({
      content: `Valgt barn: **${child.name}**. Velg barnets Discord-konto pa serveren.`,
      components: [userPicker(EXISTING_MEMBER_SELECT, "Velg barnets Discord-konto")]
    });
  }

  private async selectExistingMember(interaction: UserSelectMenuInteraction): Promise<void> {
    await interaction.deferUpdate();
    const selection = this.selectedChildren.get(interaction.user.id);
    this.selectedChildren.delete(interaction.user.id);
    if (!selection || selection.expiresAt <= Date.now()) throw new Error("Valget er utloept. Start koblingen pa nytt.");
    const parent = await this.requireParent(interaction.user.id);
    if (parent.children.filter((item) => normalizeChildName(item.name) === normalizeChildName(selection.childName)).length !== 1) {
      throw new Error("Barnet kunne ikke identifiseres entydig i API-et. Ingen kobling ble opprettet.");
    }
    const targetId = interaction.values[0];
    if (targetId === interaction.user.id) throw new Error("Du kan ikke koble din egen Discord-konto som barn.");
    const target = await interaction.guild!.members.fetch(targetId);
    if (target.user.bot) throw new Error("Botkontoer kan ikke kobles som barn.");
    const id = randomUUID();
    this.confirmations.set(id, { parentId: interaction.user.id, childName: selection.childName, childDiscordId: target.id, expiresAt: Date.now() + FLOW_TTL_MS });
    await interaction.editReply({
      content: `Bekreft at kontoen **${target.user.username}** tilhorer barnet **${selection.childName}**, og at barnet oppfyller Discords alderskrav.`,
      components: [confirmationRow(id)]
    });
  }

  private async showInviteChildren(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const parent = await this.requireParent(interaction.user.id);
    await interaction.editReply({
      content: "Velg barnet fra din API-registrering. Skriv ikke inn navn manuelt.",
      components: [childMenu(INVITE_CHILD_SELECT, "Velg barnet", parent.children)]
    });
  }

  private async showInviteModal(interaction: StringSelectMenuInteraction): Promise<void> {
    const parent = await this.requireParent(interaction.user.id);
    const child = parent.children.find((item) => normalizeChildName(item.name) === normalizeChildName(interaction.values[0]));
    if (!child || parent.children.filter((item) => normalizeChildName(item.name) === normalizeChildName(child.name)).length !== 1) {
      throw new Error("Barnet finnes ikke entydig pa API-kontoen. Start invitasjonen pa nytt.");
    }
    const token = randomUUID();
    this.selectedInviteChildren.set(token, { parentId: interaction.user.id, childName: child.name, expiresAt: Date.now() + FLOW_TTL_MS });
    const modal = new ModalBuilder().setCustomId(`${INVITE_MODAL_PREFIX}${token}`).setTitle("Forbered barnets innmelding").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(INVITE_USERNAME_INPUT)
        .setLabel("Barnets eksakte Discord-brukernavn").setPlaceholder("Ikke serverkallenavnet").setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(32).setRequired(true))
    );
    await interaction.showModal(modal);
  }

  private async createInvite(interaction: ModalSubmitInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    this.assertLiveWritesEnabled();
    const parent = await this.requireParent(interaction.user.id);
    const token = interaction.customId.slice(INVITE_MODAL_PREFIX.length);
    const selection = this.selectedInviteChildren.get(token);
    this.selectedInviteChildren.delete(token);
    if (!selection || selection.parentId !== interaction.user.id || selection.expiresAt <= Date.now()) {
      throw new Error("Barnevalget er utloept. Start invitasjonen pa nytt.");
    }
    const childName = selection.childName;
    const discordUsername = interaction.fields.getTextInputValue(INVITE_USERNAME_INPUT).trim().replace(/^@/, "");
    const matchingChildren = parent.children.filter((child) => normalizeChildName(child.name) === normalizeChildName(childName));
    if (matchingChildren.length !== 1) throw new Error("Navnet ma matche ett barn pa din API-konto. Barn med like navn kan ikke inviteres med denne metoden.");
    if (!/^[a-z0-9_.]{2,32}$/i.test(discordUsername)) throw new Error("Skriv inn Discord-brukernavnet, ikke visningsnavn eller serverkallenavn.");
    const invite = await this.store.createInvite(interaction.user.id, matchingChildren[0].name, discordUsername);
    await interaction.editReply({
      content: `Ventende invitasjon lagret for **${invite.childName}**. Nar en serverkonto blir med med det eksakte brukernavnet, far du en privat bekreftelsesforesporsel. Invitasjonen utloeper om 7 dager. Bekreft bare hvis barnet oppfyller Discords alderskrav. Ikke del brukernavnet offentlig.`,
    });
  }

  private async createChildRequest(interaction: UserSelectMenuInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    this.assertLiveWritesEnabled();
    const parentId = interaction.values[0];
    if (parentId === interaction.user.id) throw new Error("Du kan ikke velge din egen konto som foresatt.");
    await this.requireParent(parentId);
    const request = await this.store.createRequest(parentId, interaction.user.id);
    let notified = false;
    try {
      const parent = await this.client.users.fetch(parentId);
      await parent.send({
        content: `${interaction.user.username} ber om familietilgang via din foresattkonto. Godkjenn bare dersom foresporselen gjelder et barn som oppfyller Discords alderskrav; velg deretter barnet fra API-listen.`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${APPROVE_REQUEST_PREFIX}${request.id}`).setLabel("Se og godkjenn").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`${REJECT_REQUEST_PREFIX}${request.id}`).setLabel("Avvis").setStyle(ButtonStyle.Danger)
        )]
      });
      notified = true;
    } catch { /* Parent can retrieve pending requests from the family channel. */ }
    await interaction.editReply({
      content: notified ? "Foresporselen er sendt privat til foresatt. Du far ikke tilgang for foresatt har godkjent." : "Foresporselen er lagret, men DM kunne ikke sendes. Be foresatt apne familietilgangskanalen og velge Se foresporsler.",
    });
  }

  private async approveRequest(interaction: ButtonInteraction, requestId: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const request = (await this.store.getRequestsForParent(interaction.user.id)).find((item) => item.id === requestId);
    if (!request) throw new Error("Foresporselen er utloept, avvist eller behandlet allerede.");
    const parent = await this.requireParent(interaction.user.id);
    const childUser = await this.client.users.fetch(request.childDiscordId);
    await interaction.editReply({
      content: `Velg hvilket av dine registrerte barn som bruker **${childUser.username}**. Ved godkjenning bekrefter du at barnet oppfyller Discords alderskrav.`,
      components: [childMenu(`${REQUEST_CHILD_PREFIX}${request.id}`, "Velg barnet", parent.children)]
    });
  }

  private async approveRequestWithChild(interaction: StringSelectMenuInteraction, requestId: string): Promise<void> {
    await interaction.deferUpdate();
    const request = (await this.store.getRequestsForParent(interaction.user.id)).find((item) => item.id === requestId);
    if (!request) throw new Error("Foresporselen er utloept eller allerede behandlet.");
    const parent = await this.requireParent(interaction.user.id);
    const child = parent.children.find((item) => normalizeChildName(item.name) === normalizeChildName(interaction.values[0]));
    if (!child) throw new Error("Barnelisten er endret. Start godkjenningen pa nytt.");
    if (parent.children.filter((item) => normalizeChildName(item.name) === normalizeChildName(child.name)).length !== 1) {
      throw new Error("Flere barn har samme navn i API-et. Foresporselen kan ikke kobles entydig.");
    }
    await this.completeLink(interaction, interaction.user.id, child.name, request.childDiscordId);
  }

  private async rejectRequest(interaction: ButtonInteraction, requestId: string): Promise<void> {
    this.assertLiveWritesEnabled();
    const rejected = await this.store.rejectRequest(interaction.user.id, requestId);
    await interaction.reply({ content: rejected ? "Foresporselen ble avvist. Ingen tilgang ble gitt." : "Foresporselen er allerede behandlet eller utloept.", flags: MessageFlags.Ephemeral });
  }

  private async approveClaim(interaction: ButtonInteraction, claimId: string): Promise<void> {
    const claim = (await this.store.getClaimsForParent(interaction.user.id)).find((item) => item.id === claimId);
    if (!claim) throw new Error("Invitasjonsforesporselen er utloept eller allerede behandlet.");
    await this.completeLink(interaction, claim.parentDiscordId, claim.childName, claim.childDiscordId);
  }

  private async rejectClaim(interaction: ButtonInteraction, claimId: string): Promise<void> {
    this.assertLiveWritesEnabled();
    const rejected = await this.store.rejectClaimByParent(interaction.user.id, claimId);
    await interaction.reply({ content: rejected ? "Invitasjonsforesporselen ble avvist. Ingen tilgang ble gitt." : "Foresporselen er allerede behandlet eller utloept.", flags: MessageFlags.Ephemeral });
  }

  private async completeLink(
    interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | ModalSubmitInteraction,
    parentId: string, childName: string, childDiscordId: string
  ): Promise<void> {
    this.assertLiveWritesEnabled();
    if ("deferUpdate" in interaction && typeof interaction.deferUpdate === "function" && !interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
    const parent = await this.requireParent(parentId);
    const matches = parent.children.filter((child) => normalizeChildName(child.name) === normalizeChildName(childName));
    if (matches.length !== 1) throw new Error("Barnet finnes ikke lenger entydig pa foresattens API-konto. Ingen tilgang ble gitt.");
    const guild = await this.client.guilds.fetch(this.access.settings.guildId);
    let target: GuildMember;
    try { target = await guild.members.fetch(childDiscordId); }
    catch { throw new Error("Barnets Discord-konto er ikke lenger pa serveren. Ingen tilgang ble gitt."); }
    if (target.user.bot || target.id === parentId) throw new Error("Denne kontoen kan ikke kobles som barn.");
    const link = await this.store.createLink(parentId, matches[0].name, childDiscordId);
    let result = "Familiekoblingen er lagret.";
    try {
      const accessResult = await this.access.check(target);
      if (accessResult === "verified") result += " Navnet er synkronisert og tilgang er gitt.";
      else if (accessResult === "dry-run") result += " Torkjoring er aktiv, sa ingen navn eller rolle ble endret.";
      else result += " Tilgang er ikke gitt enna; boten vil prove igjen ved neste synk.";
    } catch {
      result += " Tilgang er ikke gitt fordi navne-/rettighetssynken feilet. Boten prover igjen ved neste synk.";
    }
    await interaction.editReply({ content: `${result} Koblet barn: **${link.childName}**.`, components: [] });
  }

  private async confirmLink(interaction: ButtonInteraction): Promise<void> {
    const token = interaction.customId.slice(CONFIRM_LINK_PREFIX.length);
    const confirmation = this.confirmations.get(token);
    this.confirmations.delete(token);
    if (!confirmation || confirmation.parentId !== interaction.user.id || confirmation.expiresAt <= Date.now()) {
      throw new Error("Bekreftelsen er utloept. Start koblingen pa nytt.");
    }
    await this.completeLink(interaction, confirmation.parentId, confirmation.childName, confirmation.childDiscordId);
  }

  private async cancelLink(interaction: ButtonInteraction): Promise<void> {
    this.assertLiveWritesEnabled();
    const token = interaction.customId.slice(CANCEL_LINK_PREFIX.length);
    const confirmation = this.confirmations.get(token);
    if (confirmation?.parentId === interaction.user.id) this.confirmations.delete(token);
    await interaction.update({ content: "Familiekoblingen ble avbrutt. Ingen tilgang ble endret.", components: [] });
  }

  private async showReview(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const parent = await this.requireParent(interaction.user.id);
    const [requests, claims, invites] = await Promise.all([
      this.store.getRequestsForParent(interaction.user.id), this.store.getClaimsForParent(interaction.user.id),
      this.store.getInvitesForParent(interaction.user.id)
    ]);
    const requesterNames = new Map<string, string>();
    await Promise.all([...requests, ...claims].map(async (item) => {
      try { requesterNames.set(item.childDiscordId, (await this.client.users.fetch(item.childDiscordId)).username); }
      catch { requesterNames.set(item.childDiscordId, item.childDiscordId); }
    }));
    const options = [
      ...requests.map((item) => ({ label: `Foresporsel fra ${requesterNames.get(item.childDiscordId)}`.slice(0, 100),
        description: "Barnet ber om tilgang via deg", value: `request:${item.id}` })),
      ...claims.map((item) => ({ label: `Godkjenn konto for ${item.childName}`.slice(0, 100),
        description: `Discord-konto ${requesterNames.get(item.childDiscordId)}`, value: `claim:${item.id}` })),
      ...invites.map((item) => ({ label: `Venter pa ${item.discordUsername}`.slice(0, 100), description: `Barn: ${item.childName} - velg for a avbryte`,
        value: `invite:${item.id}` }))
    ].slice(0, 25);
    const components = options.length ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(REVIEW_SELECT).setPlaceholder("Velg en foresporsel eller invitasjon").setMinValues(1).setMaxValues(1).addOptions(options)
    )] : [];
    await interaction.editReply({ content: `Registrert foresattkonto med ${parent.children.length} barn. Ventende foresporsler: ${options.length}.`, components });
  }

  private async selectReview(interaction: StringSelectMenuInteraction): Promise<void> {
    await interaction.deferUpdate();
    const [kind, id] = interaction.values[0].split(":", 2) as [ReviewSelection["kind" | "kind"], string];
    if (!(kind === "request" || kind === "claim" || kind === "invite") || !id) throw new Error("Ugyldig valg.");
    const selection: ReviewSelection = { parentId: interaction.user.id, kind, id };
    const exists = kind === "request" ? (await this.store.getRequestsForParent(selection.parentId)).some((item) => item.id === id)
      : kind === "claim" ? (await this.store.getClaimsForParent(selection.parentId)).some((item) => item.id === id)
        : (await this.store.getInvitesForParent(selection.parentId)).some((item) => item.id === id);
    if (!exists) throw new Error("Valget er utloept eller allerede behandlet.");
    this.reviews.set(interaction.user.id, selection);
    const approveLabel = kind === "request" ? "Velg barn og godkjenn" : kind === "claim" ? "Godkjenn og gi tilgang" : "Avbryt invitasjon";
    await interaction.editReply({
      content: kind === "invite" ? "Invitasjonen venter pa at kontoen blir med. Du kan avbryte den." : "Kontroller foresporselen. Godkjenning kobler Discord-kontoen til et API-registrert barn.",
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(REVIEW_APPROVE).setLabel(approveLabel).setStyle(kind === "invite" ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(REVIEW_REJECT).setLabel(kind === "invite" ? "Lukk" : "Avvis").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(REVIEW_CANCEL).setLabel("Tilbake").setStyle(ButtonStyle.Secondary)
      )]
    });
  }

  private async approveSelectedReview(interaction: ButtonInteraction): Promise<void> {
    const selection = this.reviews.get(interaction.user.id);
    if (!selection || selection.parentId !== interaction.user.id) throw new Error("Valget er utloept. Apne foresporsler pa nytt.");
    if (selection.kind === "request") return this.approveRequest(interaction, selection.id);
    if (selection.kind === "claim") return this.approveClaim(interaction, selection.id);
    throw new Error("Invitasjonen kan forst godkjennes nar Discord-kontoen har blitt med og gjort krav pa den.");
  }

  private async rejectSelectedReview(interaction: ButtonInteraction): Promise<void> {
    this.assertLiveWritesEnabled();
    const selection = this.reviews.get(interaction.user.id);
    this.reviews.delete(interaction.user.id);
    if (!selection || selection.parentId !== interaction.user.id) throw new Error("Valget er utloept. Apne foresporsler pa nytt.");
    if (selection.kind === "request") return this.rejectRequest(interaction, selection.id);
    if (selection.kind === "claim") return this.rejectClaim(interaction, selection.id);
    const removed = await this.store.rejectInvite(interaction.user.id, selection.id);
    await interaction.reply({ content: removed ? "Invitasjonen ble avbrutt." : "Invitasjonen er allerede behandlet.", flags: MessageFlags.Ephemeral });
  }

  private async showLinks(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.requireParent(interaction.user.id);
    const links = await this.store.getLinksForParent(interaction.user.id);
    if (!links.length) {
      await interaction.editReply({ content: "Du har ingen lagrede barnekoblinger." });
      return;
    }
    const options = await Promise.all(links.slice(0, 25).map(async (link) => {
      let account = link.childDiscordId;
      try { account = (await this.client.users.fetch(link.childDiscordId)).username; } catch { /* Show the stable Discord ID if the user left. */ }
      return { label: link.childName.slice(0, 100), description: `Konto: ${account}`.slice(0, 100), value: link.childDiscordId };
    }));
    await interaction.editReply({
      content: "Velg en kobling for a fjerne den. Fjerning tar bort familietilgang ved neste synk, men nullstiller ikke kallenavnet.",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(LINK_REMOVE_SELECT).setPlaceholder("Velg barnekobling").setMinValues(1).setMaxValues(1).addOptions(options)
      )]
    });
  }

  private async removeLink(interaction: StringSelectMenuInteraction): Promise<void> {
    await interaction.deferUpdate();
    this.assertLiveWritesEnabled();
    await this.requireParent(interaction.user.id);
    const links = await this.store.getLinksForParent(interaction.user.id);
    const link = links.find((item) => item.childDiscordId === interaction.values[0]);
    if (!link) throw new Error("Koblingslisten er endret. Apne den pa nytt.");
    const removed = await this.store.removeLink(interaction.user.id, link.childDiscordId);
    let message = removed ? `Familiekoblingen til **${link.childName}** er fjernet.` : "Koblingen finnes ikke lenger.";
    try {
      const guild = await this.client.guilds.fetch(this.access.settings.guildId);
      const child = await guild.members.fetch(link.childDiscordId);
      const result = await this.access.check(child);
      if (result === "revoked") message += " Tilgangsrollen er fjernet.";
      else if (result === "verified") message += " Kontoen er ogsa registrert selvstendig pa API-et, sa tilgangen beholdes.";
    } catch { message += " Synken kunne ikke fullfores akkurat na."; }
    await interaction.editReply({ content: message, components: [] });
  }

}
