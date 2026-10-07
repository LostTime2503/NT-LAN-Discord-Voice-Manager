import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits,
  type ButtonInteraction, type CategoryChannel, type Client, type Guild, type GuildMember
} from "discord.js";
import { createNickname, type RegisteredPerson } from "./registrationClient.js";

export const ACCESS_BUTTON_ID = "check-registration-access";

const administrativePermissions = [
  "Administrator", "ManageGuild", "ManageRoles", "ManageChannels", "ManageWebhooks",
  "KickMembers", "BanMembers", "ModerateMembers", "ManageMessages", "ManageThreads",
  "ManageNicknames", "ManageEvents", "MuteMembers", "DeafenMembers", "MoveMembers",
  "MentionEveryone"
] as const;

export interface AccessSettings {
  guildId: string;
  accessRoleId: string;
  crewRoleId: string;
  channelId: string;
  websiteUrl: string;
  dryRun: boolean;
  intervalMs: number;
}

export type AccessResult = "exempt" | "not-linked" | "revoked" | "manual-name" | "cannot-rename" | "dry-run" | "verified";

export class AccessConfigurationError extends Error {}

export function describeAccessStartupError(error: unknown): string {
  if (error instanceof AccessConfigurationError) return error.message;
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === 50001) return "Discord: Missing Access. Kontroller at boten er medlem av DISCORD_GUILD_ID og har tilgang.";
    if (error.code === 50013) return "Discord: Missing Permissions. Kontroller botens rettigheter og rolleplassering.";
    if (error.code === 10004) return "Discord: Unknown Guild. Kontroller DISCORD_GUILD_ID.";
  }
  return "Kunne ikke hente server/roller fra Discord. Kontroller tilkobling, server-ID og bottilgang.";
}

export async function startAccessSync(manager: AccessManager, client: Client): Promise<boolean> {
  try {
    await manager.start(client);
    return true;
  } catch (error) {
    manager.stop();
    console.error(`Access sync paused: ${describeAccessStartupError(error)} Voice continues with existing access checks.`);
    return false;
  }
}

export function isCrewMember(member: GuildMember, crewRoleId: string): boolean {
  if (member.id === member.guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const crewRole = member.guild.roles.cache.get(crewRoleId);
  if (!crewRole) throw new Error("Configured Crew role does not exist.");
  return member.roles.cache.has(crewRoleId) || member.roles.highest.comparePositionTo(crewRole) > 0;
}

export async function reconcileMember(
  member: GuildMember, person: RegisteredPerson | undefined, settings: AccessSettings
): Promise<AccessResult> {
  const exempt = isCrewMember(member, settings.crewRoleId);
  const me = member.guild.members.me;
  if (!exempt && (person || member.roles.cache.has(settings.accessRoleId))) {
    const role = member.guild.roles.cache.get(settings.accessRoleId);
    if (!role || role.managed || role.id === member.guild.id
      || !me?.permissions.has(PermissionFlagsBits.ManageRoles) || me.roles.highest.comparePositionTo(role) <= 0) {
      throw new Error("Access role must be a regular role manageable by the bot.");
    }
  }
  if (!person) {
    if (exempt) return "exempt";
    if (!member.roles.cache.has(settings.accessRoleId)) return "not-linked";
    if (settings.dryRun) return "dry-run";
    await member.roles.remove(settings.accessRoleId, "Discord identity absent from successful registration API response");
    return "revoked";
  }
  const nickname = createNickname(person);
  if (!nickname) return exempt ? "exempt" : "manual-name";
  if (member.nickname !== nickname && (!member.manageable || !me?.permissions.has(PermissionFlagsBits.ManageNicknames))) {
    return exempt ? "exempt" : "cannot-rename";
  }
  if (settings.dryRun) return "dry-run";
  if (member.nickname !== nickname) {
    try {
      await member.setNickname(nickname, "Verified website name");
    } catch (error) {
      if (!exempt) throw error;
      return "exempt";
    }
  }
  if (exempt) return "exempt";
  if (!member.roles.cache.has(settings.accessRoleId)) {
    await member.roles.add(settings.accessRoleId, "Website identity verified and nickname applied");
  }
  return "verified";
}

export class AccessManager {
  private syncing = false;
  private membersLoaded = false;
  private readonly pending = new Map<string, Promise<AccessResult>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private warnedPermissions = "";

  constructor(
    readonly settings: AccessSettings,
    private readonly getParticipants: () => Promise<Map<string, RegisteredPerson>>
  ) {
    const url = new URL(settings.websiteUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("REGISTRATION_URL must use HTTPS.");
    for (const id of [settings.guildId, settings.accessRoleId, settings.crewRoleId, settings.channelId]) {
      if (!/^\d{17,20}$/.test(id)) throw new Error("Access configuration requires valid Discord IDs.");
    }
    if (settings.accessRoleId === settings.crewRoleId) throw new Error("Access and Crew roles must be different.");
  }

  async validateGuild(guild: Guild): Promise<void> {
    await guild.roles.fetch();
    const me = await guild.members.fetchMe();
    const accessRole = guild.roles.cache.get(this.settings.accessRoleId);
    const crewRole = guild.roles.cache.get(this.settings.crewRoleId);
    if (!crewRole) throw new AccessConfigurationError("CREW_ROLE_ID finnes ikke pa denne serveren. Kopier ID-en fra serverens Crew-rolle.");
    if (!accessRole) throw new AccessConfigurationError("ACCESS_ROLE_ID finnes ikke pa denne serveren. Kopier ID-en fra serverens discord-koblet-rolle.");
    if (accessRole.managed || accessRole.id === guild.id) {
      throw new AccessConfigurationError("ACCESS_ROLE_ID ma vaere en egen vanlig rolle, ikke botrolle eller @everyone.");
    }
    const elevated = administrativePermissions.filter((name) => (accessRole.permissions.bitfield & PermissionFlagsBits[name]) !== 0n);
    const warning = elevated.join(", ");
    if (warning && warning !== this.warnedPermissions) {
      console.warn(`WARNING: discord-koblet has administrative permissions: ${warning}. Discord remains authoritative; the bot will not change them. Administrator bypasses hidden channels.`);
    }
    this.warnedPermissions = warning;
    if (accessRole.comparePositionTo(crewRole) >= 0) {
      throw new AccessConfigurationError("Flytt discord-koblet-rollen under Crew i rollelisten.");
    }
    if (me.roles.highest.comparePositionTo(accessRole) <= 0) {
      throw new AccessConfigurationError("Flytt botrollen over discord-koblet i rollelisten.");
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      throw new AccessConfigurationError("Botrollen mangler Manage Nicknames (administrer kallenavn).");
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new AccessConfigurationError("Botrollen mangler Manage Roles (administrer roller).");
    }
  }

  async start(client: Client): Promise<void> {
    if (this.timer) return;
    const guild = await client.guilds.fetch(this.settings.guildId);
    await this.validateGuild(guild);
    await this.sync(guild).catch(() => console.error("Initial access sync failed; retrying on the next interval without changing existing access."));
    this.timer = setInterval(() => {
      void this.sync(guild).catch((error) => {
        if (error instanceof AccessConfigurationError) {
          this.stop();
          console.error(`Access sync paused: ${describeAccessStartupError(error)} Fix configuration and restart the bot. Existing access was preserved.`);
        } else {
          console.error("Access sync failed; existing access was preserved. Retrying next interval.");
        }
      });
    }, this.settings.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sync(guild: Guild): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      await this.validateGuild(guild);
      const people = await this.getParticipants();
      const members = this.membersLoaded ? guild.members.cache : await guild.members.fetch();
      this.membersLoaded = true;
      const counts: Partial<Record<AccessResult | "failed", number>> = {};
      for (const member of members.values()) {
        if (member.user.bot) continue;
        let result: AccessResult | "failed";
        try { result = await this.check(member, people, false); } catch { result = "failed"; }
        counts[result] = (counts[result] ?? 0) + 1;
      }
      console.log("Access sync summary", { dryRun: this.settings.dryRun, ...counts });
    } finally { this.syncing = false; }
  }

  async check(member: GuildMember, people?: Map<string, RegisteredPerson>, forceRefresh = true): Promise<AccessResult> {
    if (member.guild.id !== this.settings.guildId || member.user.bot) throw new Error("Member outside configured access scope.");
    const existing = this.pending.get(member.id);
    if (existing) return existing;
    const task = (async () => {
      if (!people) await this.validateGuild(member.guild);
      const records = people ?? await this.getParticipants();
      const current = forceRefresh ? await member.guild.members.fetch({ user: member.id, force: true }) : member;
      return reconcileMember(current, records.get(member.id), this.settings);
    })();
    this.pending.set(member.id, task);
    try { return await task; } finally { this.pending.delete(member.id); }
  }

  async handleNicknameUpdate(oldMember: Pick<GuildMember, "guild" | "nickname">, newMember: GuildMember): Promise<void> {
    if (this.settings.dryRun || oldMember.guild.id !== this.settings.guildId || newMember.user.bot
      || oldMember.nickname === newMember.nickname) return;
    const linked = newMember.roles.cache.has(this.settings.accessRoleId);
    let exempt = false;
    try { exempt = isCrewMember(newMember, this.settings.crewRoleId); } catch { /* Access sync reports missing role configuration. */ }
    if (!linked && !exempt) return;
    await this.check(newMember);
  }

  canUseVoice(member: GuildMember): boolean {
    if (this.settings.dryRun) return true;
    if (member.guild.id !== this.settings.guildId) return false;
    if (member.roles.cache.has(this.settings.accessRoleId)) return true;
    try { return isCrewMember(member, this.settings.crewRoleId); } catch { return false; }
  }

  isVoiceCategoryProtected(category: CategoryChannel | null): boolean {
    return category?.guild.id === this.settings.guildId
      && category.permissionOverwrites.cache.get(this.settings.guildId)?.deny.has(PermissionFlagsBits.ViewChannel) === true
      && category.permissionOverwrites.cache.get(this.settings.accessRoleId)?.allow.has(PermissionFlagsBits.ViewChannel) === true;
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.guildId !== this.settings.guildId || !interaction.guild) {
      await interaction.editReply("Denne knappen gjelder ikke denne serveren.");
      return;
    }
    try {
      await this.validateGuild(interaction.guild);
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const result = await this.check(member);
      const messages: Record<AccessResult, string> = {
        exempt: "Du har tilgang gjennom Crew eller en høyere rolle. Oppdater kallenavnet selv hvis boten ikke kan endre det.",
        "not-linked": "Vi fant ikke Discord-koblingen din. Logg inn på nettsiden og prøv igjen. Du trenger ikke være påmeldt årets LAN. Kontakt Crew hvis du allerede har koblet kontoen.",
        revoked: "Vi finner ikke lenger Discord-koblingen din. Tilgangsrollen er fjernet. Koble Discord til på nettsiden for å få tilgang igjen.",
        "manual-name": "Navnet kan ikke brukes automatisk som kallenavn. Kontakt Crew for hjelp.",
        "cannot-rename": "Boten kan ikke endre kallenavnet ditt. Kontakt Crew for hjelp.",
        "dry-run": "Kontrollen er fullført i testmodus. Ingen navn eller roller er endret.",
        verified: "Kallenavnet er oppdatert, og du har tilgang til serveren."
      };
      await interaction.editReply(messages[result]);
    } catch {
      await interaction.editReply("Kunne ikke fullfore kontrollen akkurat na. Prov igjen senere eller kontakt Crew.");
    }
  }

  async publishEntry(guild: Guild): Promise<void> {
    const channel = await guild.channels.fetch(this.settings.channelId);
    if (channel?.type !== ChannelType.GuildText) throw new Error("ACCESS_CHANNEL_ID must be a text channel.");
    const me = await guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) {
      throw new Error("Bot cannot publish the entry message in access channel.");
    }
    if (this.settings.dryRun) return;
    const content = "Velkommen til NT-LAN! Logg inn med Discord på nettsiden for å få tilgang. Kallenavnet vises som fornavn og initial for siste etternavn, for eksempel Ola N. Du trenger ikke være påmeldt årets LAN.";
    const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Åpne nettsiden").setURL(this.settings.websiteUrl),
      new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel("Sjekk tilgang").setCustomId(ACCESS_BUTTON_ID)
    )];
    const messages = await channel.messages.fetch({ limit: 100 });
    const existing = messages.find((message) => message.author.id === me.id
      && message.components.some((row) => "components" in row && row.components.some((component) => "customId" in component && component.customId === ACCESS_BUTTON_ID)));
    if (existing) await existing.edit({ content, components });
    else await channel.send({ content, components });
  }
}