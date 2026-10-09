import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits,
  type ButtonInteraction, type CategoryChannel, type Client, type Guild, type GuildMember
} from "discord.js";
import { createNickname, type RegisteredPerson } from "./registrationClient.js";
import type { ManualAccessOverride, ManualOverrideStore } from "./manualOverrides.js";
import { getBotMessages } from "./messages.js";

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
  manualAccessRoleId: string;
  crewRoleId: string;
  channelId: string;
  websiteUrl: string;
  dryRun: boolean;
  intervalMs: number;
}

export type AccessResult = "exempt" | "not-linked" | "revoked" | "manual-name" | "cannot-rename" | "dry-run" | "dry-run-linked" | "verified" | "manual-override";
export interface AccessAuditAction {
  username: string;
  action: "nickname-set" | "website-role-granted" | "manual-role-granted" | "manual-role-promoted" | "website-role-revoked" | "manual-role-revoked";
  nickname?: string;
}

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
  private summaryReporter: (summary: { dryRun: boolean; counts: Partial<Record<AccessResult | "failed", number>> }) => void
    = summary => console.log("Access sync summary", summary);
  private actionReporter: (action: AccessAuditAction) => void = action => console.info("Access sync action", action);

  constructor(
    readonly settings: AccessSettings,
    private readonly getParticipants: () => Promise<Map<string, RegisteredPerson>>,
    private readonly manualOverrides?: ManualOverrideStore
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
    const manualAccessRole = guild.roles.cache.get(this.settings.manualAccessRoleId);
    const crewRole = guild.roles.cache.get(this.settings.crewRoleId);
    if (!crewRole) throw new AccessConfigurationError("CREW_ROLE_ID finnes ikke pa denne serveren. Kopier ID-en fra serverens Crew-rolle.");
    if (!accessRole) throw new AccessConfigurationError("ACCESS_ROLE_ID finnes ikke pa denne serveren. Kopier ID-en fra serverens discord-koblet-rolle.");
    if (accessRole.managed || accessRole.id === guild.id) {
      throw new AccessConfigurationError("ACCESS_ROLE_ID ma vaere en egen vanlig rolle, ikke botrolle eller @everyone.");
    }
    if (!manualAccessRole) throw new AccessConfigurationError("MANUAL_ACCESS_ROLE_ID finnes ikke pa denne serveren.");
    if (manualAccessRole.managed || manualAccessRole.id === guild.id || manualAccessRole.id === accessRole.id) {
      throw new AccessConfigurationError("MANUAL_ACCESS_ROLE_ID ma vaere en egen vanlig rolle, forskjellig fra ACCESS_ROLE_ID.");
    }
    const elevated = administrativePermissions.filter((name) => (accessRole.permissions.bitfield & PermissionFlagsBits[name]) !== 0n);
    const warning = elevated.join(", ");
    if (warning && warning !== this.warnedPermissions) {
      console.warn(`WARNING: discord-koblet has administrative permissions: ${warning}. Discord remains authoritative; the bot will not change them. Administrator bypasses hidden channels.`);
    }
    this.warnedPermissions = warning;
    if (accessRole.comparePositionTo(crewRole) >= 0 || manualAccessRole.comparePositionTo(crewRole) >= 0) {
      throw new AccessConfigurationError("Flytt tilgangsrollene under Crew i rollelisten.");
    }
    if (me.roles.highest.comparePositionTo(accessRole) <= 0 || me.roles.highest.comparePositionTo(manualAccessRole) <= 0) {
      throw new AccessConfigurationError("Flytt botrollen over tilgangsrollene i rollelisten.");
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
    await this.manualOverrides?.load();
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

  setSummaryReporter(
    reporter: (summary: { dryRun: boolean; counts: Partial<Record<AccessResult | "failed", number>> }) => void
  ): void {
    this.summaryReporter = reporter;
  }

  setActionReporter(reporter: (action: AccessAuditAction) => void): void {
    this.actionReporter = reporter;
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
      this.summaryReporter({ dryRun: this.settings.dryRun, counts });
    } finally { this.syncing = false; }
  }

  async check(member: GuildMember, people?: Map<string, RegisteredPerson>, forceRefresh = true): Promise<AccessResult> {
    if (member.guild.id !== this.settings.guildId || member.user.bot) throw new Error("Member outside configured access scope.");
    const existing = this.pending.get(member.id);
    if (existing) return existing;
    const task = (async () => {
      if (!people) await this.validateGuild(member.guild);
      const current = forceRefresh ? await member.guild.members.fetch({ user: member.id, force: true }) : member;
      let manualOverride = await this.manualOverrides?.getAccessOverride(current.id);
      if (manualOverride && !current.roles.cache.has(this.settings.manualAccessRoleId)) {
        await this.clearManualAccess(current, true, false);
        manualOverride = undefined;
      }
      const previousNickname = current.nickname;
      const hadWebsiteRole = current.roles.cache.has(this.settings.accessRoleId);
      const hadManualRole = current.roles.cache.has(this.settings.manualAccessRoleId);
      let records: Map<string, RegisteredPerson>;
      try {
        records = people ?? await this.getParticipants();
      } catch (error) {
        if (manualOverride) return this.applyManualAccessOverride(current, manualOverride);
        throw error;
      }
      if (manualOverride) {
        const person = records.get(current.id);
        if (!person) {
          const result = await this.applyManualAccessOverride(current, manualOverride);
          this.reportAccessActions(current, previousNickname, manualOverride.nickname, hadWebsiteRole, hadManualRole, result);
          return result;
        }
        if (this.settings.dryRun) return "dry-run-linked";
        const result = await reconcileMember(current, person, this.settings);
        if (result === "verified") {
          if (current.roles.cache.has(this.settings.manualAccessRoleId)) {
            await current.roles.remove(this.settings.manualAccessRoleId, "Website identity verified; removing temporary manual access role");
          }
          await this.manualOverrides?.removeAccessOverride(current.id);
        }
        this.reportAccessActions(current, previousNickname, createNickname(person) ?? undefined,
          hadWebsiteRole, hadManualRole, result);
        return result;
      }
      const person = records.get(current.id);
      const result = await reconcileMember(current, person, this.settings);
      this.reportAccessActions(current, previousNickname, person ? createNickname(person) ?? undefined : undefined,
        hadWebsiteRole, hadManualRole, result);
      return result;
    })();
    this.pending.set(member.id, task);
    try { return await task; } finally { this.pending.delete(member.id); }
  }

  async grantManualAccess(member: GuildMember, nickname: string, actorId: string, confirmLive = false): Promise<void> {
    if (!this.manualOverrides) throw new AccessConfigurationError("Manual access overrides are not configured.");
    if (member.guild.id !== this.settings.guildId || member.user.bot) throw new Error("Target is outside the configured member scope.");
    if (this.settings.dryRun && !confirmLive) throw new AccessConfigurationError("ACCESS_DRY_RUN=true; add bekreft:true to approve this manual access change.");
    await this.validateGuild(member.guild);
    const previousNickname = member.nickname;
    const hadManualRole = member.roles.cache.has(this.settings.manualAccessRoleId);
    const override = await this.manualOverrides.grantAccess(member.id, nickname, actorId);
    try {
      await this.applyManualAccessOverride(member, override, true);
      this.reportAccessActions(member, previousNickname, override.nickname,
        member.roles.cache.has(this.settings.accessRoleId), hadManualRole, "manual-override");
    } catch (error) {
      await this.manualOverrides.removeAccessOverride(member.id);
      throw error;
    }
  }

  async clearManualAccess(member: GuildMember, confirmLive = false, resumeAutomatic = true): Promise<boolean> {
    if (!this.manualOverrides) throw new AccessConfigurationError("Manual access overrides are not configured.");
    if (member.guild.id !== this.settings.guildId || member.user.bot) throw new Error("Target is outside the configured member scope.");
    if (this.settings.dryRun && !confirmLive) throw new AccessConfigurationError("ACCESS_DRY_RUN=true; add bekreft:true to approve clearing this manual access.");
    const override = await this.manualOverrides.getAccessOverride(member.id);
    if (!override) return false;
    if (member.roles.cache.has(this.settings.manualAccessRoleId)) {
      await member.roles.remove(this.settings.manualAccessRoleId, "Manual access override cleared");
    }
    const removed = await this.manualOverrides.removeAccessOverride(member.id);
    if (removed) {
      this.actionReporter({ username: member.user.username || member.id, action: "manual-role-revoked" });
      if (resumeAutomatic) {
        await this.check(member).catch(() => console.error("Manual access override cleared; automatic sync will retry when the registration API is available."));
      }
    }
    return removed;
  }

  private async applyManualAccessOverride(member: GuildMember, override: ManualAccessOverride, forceLive = false): Promise<AccessResult> {
    const role = member.guild.roles.cache.get(this.settings.manualAccessRoleId);
    const me = member.guild.members.me;
    if (!role || role.managed || role.id === member.guild.id
      || !me?.permissions.has(PermissionFlagsBits.ManageRoles) || me.roles.highest.comparePositionTo(role) <= 0) {
      throw new AccessConfigurationError("Manual access role must be manageable by the bot.");
    }
    if (member.nickname !== override.nickname
      && (!member.manageable || !me.permissions.has(PermissionFlagsBits.ManageNicknames))) {
      throw new AccessConfigurationError("Bot cannot set the requested nickname for this member.");
    }
    if (this.settings.dryRun && !forceLive) return "dry-run";
    if (member.nickname !== override.nickname) {
      await member.setNickname(override.nickname, `Manual access override by ${override.grantedBy}`);
    }
    if (!member.roles.cache.has(this.settings.manualAccessRoleId)) {
      await member.roles.add(this.settings.manualAccessRoleId, `Manual access override by ${override.grantedBy}`);
    }
    return "manual-override";
  }

  private reportAccessActions(
    member: GuildMember,
    previousNickname: string | null,
    desiredNickname: string | undefined,
    hadWebsiteRole: boolean,
    hadManualRole: boolean,
    result: AccessResult
  ): void {
    const username = (member.user.username || member.id).replace(/[\r\n`]/g, " ").trim().slice(0, 80);
    const nickname = desiredNickname?.replace(/[\r\n`]/g, " ").trim().slice(0, 32);
    if (nickname && previousNickname !== nickname && ["verified", "manual-override"].includes(result)) {
      this.actionReporter({ username, action: "nickname-set", nickname });
    }
    if (result === "verified" && !hadWebsiteRole) {
      this.actionReporter({ username, action: hadManualRole ? "manual-role-promoted" : "website-role-granted" });
    } else if (result === "manual-override" && !hadManualRole) {
      this.actionReporter({ username, action: "manual-role-granted" });
    } else if (result === "revoked" && hadWebsiteRole) {
      this.actionReporter({ username, action: "website-role-revoked" });
    }
  }

  async handleNicknameUpdate(oldMember: Pick<GuildMember, "guild" | "nickname">, newMember: GuildMember): Promise<void> {
    if (this.settings.dryRun || oldMember.guild.id !== this.settings.guildId || newMember.user.bot
      || oldMember.nickname === newMember.nickname) return;
    const linked = newMember.roles.cache.has(this.settings.accessRoleId)
      || newMember.roles.cache.has(this.settings.manualAccessRoleId);
    let exempt = false;
    try { exempt = isCrewMember(newMember, this.settings.crewRoleId); } catch { /* Access sync reports missing role configuration. */ }
    if (!linked && !exempt) return;
    await this.check(newMember);
  }

  async handleManualAccessRoleRemoval(
    oldMember: Pick<GuildMember, "roles">,
    newMember: GuildMember,
    resumeAutomatic: boolean
  ): Promise<void> {
    if (newMember.guild.id !== this.settings.guildId || newMember.user.bot
      || !oldMember.roles.cache.has(this.settings.manualAccessRoleId)
      || newMember.roles.cache.has(this.settings.manualAccessRoleId)) return;
    await this.clearManualAccess(newMember, true, resumeAutomatic);
  }

  canUseVoice(member: GuildMember): boolean {
    if (member.guild.id !== this.settings.guildId) return false;
    if (member.roles.cache.has(this.settings.accessRoleId)
      || member.roles.cache.has(this.settings.manualAccessRoleId)) return true;
    try { return isCrewMember(member, this.settings.crewRoleId); } catch { return false; }
  }

  isVoiceCategoryProtected(category: CategoryChannel | null): boolean {
    const requiredPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect];
    const everyoneOverwrite = category?.permissionOverwrites.cache.get(this.settings.guildId);
    const accessOverwrite = category?.permissionOverwrites.cache.get(this.settings.accessRoleId);
    const manualAccessOverwrite = category?.permissionOverwrites.cache.get(this.settings.manualAccessRoleId);
    return category?.guild.id === this.settings.guildId
      && requiredPermissions.every(permission => everyoneOverwrite?.deny.has(permission))
      && requiredPermissions.every(permission => accessOverwrite?.allow.has(permission))
      && requiredPermissions.every(permission => manualAccessOverwrite?.allow.has(permission));
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const messages = getBotMessages().access.button;
    if (interaction.guildId !== this.settings.guildId || !interaction.guild) {
      await interaction.editReply(messages.wrongServer);
      return;
    }
    try {
      await this.validateGuild(interaction.guild);
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const result = await this.check(member);
      await interaction.editReply(messages[result]);
    } catch {
      await interaction.editReply(messages.checkFailed);
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
    const accessMessages = getBotMessages().access;
    const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(accessMessages.openWebsiteLabel).setURL(this.settings.websiteUrl),
      new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(accessMessages.checkAccessLabel).setCustomId(ACCESS_BUTTON_ID)
    )];
    const messages = await channel.messages.fetch({ limit: 100 });
    const existing = messages.find((message) => message.author.id === me.id
      && message.components.some((row) => "components" in row && row.components.some((component) => "customId" in component && component.customId === ACCESS_BUTTON_ID)));
    if (existing) await existing.edit({ content: accessMessages.entry, components });
    else await channel.send({ content: accessMessages.entry, components });
  }
}