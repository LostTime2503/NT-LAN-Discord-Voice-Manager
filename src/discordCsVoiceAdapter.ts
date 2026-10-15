import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type OverwriteResolvable,
  type VoiceBasedChannel
} from "discord.js";
import { createHash } from "node:crypto";
import type { CsDiscordAdapter, CsVoiceRoomRequest, CsVoiceRoomScope } from "./csDiscordManager.js";
import { isCrewMember } from "./accessManager.js";

export interface CsVoicePermissionIds {
  everyoneRoleId: string;
  participantRoleId: string;
  manualParticipantRoleId: string;
  crewRoleId: string;
  botUserId: string;
  memberIds: string[];
}

export function formatCsRoomName(name: string, scope: CsVoiceRoomScope, marker: string): string {
  const scopeName = scope === "wingman" ? "Wingman" : "CS";
  const cleanName = name.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim()
    .replace(/\s+/g, " ").replace(new RegExp(`^${scopeName}\\s+`, "i"), "").slice(0, 40);
  if (!cleanName) throw new Error("MAT team name cannot be used for a voice room.");
  return `${scopeName} - ${cleanName} ${marker}`;
}

export function getCsVoiceRoomsNeedingBitrateUpdate<T extends Pick<VoiceBasedChannel, "id" | "bitrate">>(
  rooms: readonly T[],
  maximumBitrate: number
): T[] {
  return rooms.filter(room => room.bitrate !== maximumBitrate);
}

export class ManualCsRoomDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualCsRoomDriftError";
  }
}

export function createCsVoiceRoomOverwrites(ids: CsVoicePermissionIds): OverwriteResolvable[] {
  const viewAndConnect = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect];
  return [
    { id: ids.everyoneRoleId, deny: viewAndConnect },
    { id: ids.participantRoleId, allow: viewAndConnect },
    { id: ids.manualParticipantRoleId, allow: viewAndConnect },
    { id: ids.crewRoleId, allow: viewAndConnect },
    { id: ids.botUserId, allow: [...viewAndConnect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] },
    ...[...new Set(ids.memberIds)].map(id => ({ id, allow: viewAndConnect }))
  ];
}

export class DiscordJsCsVoiceAdapter implements CsDiscordAdapter {
  private readonly roomDeleteTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly categoryId: string,
    private readonly lobbyChannelId: string,
    private readonly participantRoleId: string,
    private readonly manualParticipantRoleId: string | undefined,
    private readonly crewRoleId: string
  ) {}

  async validate(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const category = await guild.channels.fetch(this.categoryId);
    const lobby = await guild.channels.fetch(this.lobbyChannelId);
    const participantRole = await guild.roles.fetch(this.participantRoleId);
    const manualParticipantRole = this.manualParticipantRoleId
      ? await guild.roles.fetch(this.manualParticipantRoleId) : null;
    const crewRole = await guild.roles.fetch(this.crewRoleId);
    const botMember = await guild.members.fetchMe();
    if (!category || category.type !== ChannelType.GuildCategory || !lobby || lobby.type !== ChannelType.GuildVoice
      || lobby.parentId !== category.id || !participantRole || !manualParticipantRole || !crewRole
      || participantRole.id === crewRole.id || manualParticipantRole.id === crewRole.id
      || participantRole.id === manualParticipantRole.id) {
      throw new Error("CS category, lobby, and distinct automatic/manual participant and Crew roles must exist in the configured guild.");
    }
    const everyonePermissions = category.permissionsFor(guild.roles.everyone);
    const participantPermissions = category.permissionsFor(participantRole);
    const manualParticipantPermissions = category.permissionsFor(manualParticipantRole);
    const crewPermissions = category.permissionsFor(crewRole);
    if (everyonePermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
      || !participantPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
      || !manualParticipantPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
      || !crewPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
      throw new Error("Deny ViewChannel/Connect to @everyone and allow them for automatic/manual CS participants and Crew on the category.");
    }
    const botPermissions = botMember.permissionsIn(category);
    if (!botPermissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers])) {
      throw new Error("Bot needs ManageChannels and MoveMembers in the CS category.");
    }
  }

  async validateParticipantRoleManagement(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const role = await guild.roles.fetch(this.participantRoleId);
    const botMember = await guild.members.fetchMe();
    if (!role || role.managed || role.id === guild.id
      || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)
      || botMember.roles.highest.comparePositionTo(role) <= 0) {
      throw new Error("Bot cannot manage the configured CS participant role.");
    }
  }

  async ensureRoom(request: CsVoiceRoomRequest, existingChannelId?: string, previousRequest?: CsVoiceRoomRequest): Promise<string> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const category = await guild.channels.fetch(this.categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error("Configured CS category is unavailable.");
    }
    const botUserId = this.client.user?.id;
    if (!botUserId) throw new Error("Discord bot is not ready.");
    const permissionOverwrites = createCsVoiceRoomOverwrites({
      everyoneRoleId: guild.roles.everyone.id,
      participantRoleId: this.participantRoleId,
      manualParticipantRoleId: this.manualParticipantRoleId ?? "",
      crewRoleId: this.crewRoleId,
      botUserId,
      memberIds: request.memberIds
    });
    const channelName = this.channelName(request);

    let channel: VoiceBasedChannel | null = null;
    if (existingChannelId) {
      const existing = await this.fetchChannelIfPresent(guild, existingChannelId);
      if (existing && existing.type !== ChannelType.GuildVoice) {
        throw new ManualCsRoomDriftError("MAT-owned voice channel was replaced with a different channel type.");
      }
      if (existing?.type === ChannelType.GuildVoice) {
        if (existing.parentId !== category.id || !this.hasRoomMarker(existing.name, request)) {
          throw new ManualCsRoomDriftError("MAT-owned voice channel was moved or its ownership marker changed.");
        }
        if (previousRequest && (!this.matchesManagedRoomName(existing.name, previousRequest)
          || !this.hasExpectedOverwrites(existing, guild, createCsVoiceRoomOverwrites({
            everyoneRoleId: guild.roles.everyone.id,
            participantRoleId: this.participantRoleId,
            manualParticipantRoleId: this.manualParticipantRoleId ?? "",
            crewRoleId: this.crewRoleId,
            botUserId,
            memberIds: previousRequest.memberIds
          })))) {
          throw new ManualCsRoomDriftError("MAT-owned voice channel was manually changed; automatic edits are locked.");
        }
        channel = existing;
      }
    }
    if (!channel) {
      const recovered = category.children.cache.find(child => child.type === ChannelType.GuildVoice
        && this.hasRoomMarker(child.name, request));
      if (recovered?.type === ChannelType.GuildVoice) channel = recovered;
    }

    if (!channel) {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: category.id,
        bitrate: guild.maximumBitrate,
        permissionOverwrites,
        reason: "Create MAT-owned CS team voice room"
      });
      return channel.id;
    }

    if (channel.name !== channelName) {
      await channel.setName(channelName, "Update MAT-owned CS team room name");
    }
    if (channel.bitrate !== guild.maximumBitrate) {
      await channel.setBitrate(guild.maximumBitrate, "Update MAT-owned CS team room to guild maximum bitrate");
    }
    await channel.permissionOverwrites.set(permissionOverwrites, "Sync MAT-owned CS team room access");
    return channel.id;
  }

  private hasExpectedOverwrites(channel: VoiceBasedChannel, guild: Guild, expected: OverwriteResolvable[]): boolean {
    const signature = (id: string, type: number, allow: bigint, deny: bigint) => `${id}:${type}:${allow}:${deny}`;
    const expectedEntries = expected.map(overwrite => {
      const id = String(overwrite.id);
      const type = guild.roles.cache.has(id) || id === guild.id ? 0 : 1;
      const allow = new PermissionsBitField(overwrite.allow ?? []).bitfield;
      const deny = new PermissionsBitField(overwrite.deny ?? []).bitfield;
      return signature(id, type, allow, deny);
    }).sort();
    const actualEntries = [...channel.permissionOverwrites.cache.values()]
      .map(overwrite => signature(overwrite.id, overwrite.type, overwrite.allow.bitfield, overwrite.deny.bitfield))
      .sort();
    return expectedEntries.length === actualEntries.length
      && expectedEntries.every((entry, index) => entry === actualEntries[index]);
  }

  async moveMemberFromSources(memberId: string, channelId: string, allowedSourceChannelIds: string[]): Promise<boolean> {
    const guild = await this.client.guilds.fetch(this.guildId);
    let member;
    try {
      member = await guild.members.fetch(memberId);
    } catch {
      return false;
    }
    const hasCsAccess = !shouldSyncCsParticipantRole(member, this.crewRoleId)
      || member.roles.cache.has(this.participantRoleId)
      || Boolean(this.manualParticipantRoleId && member.roles.cache.has(this.manualParticipantRoleId))
      || member.roles.cache.has(this.crewRoleId);
    if (member.user.bot || !member.voice.channelId || !allowedSourceChannelIds.includes(member.voice.channelId)
      || !hasCsAccess) return false;
    const channel = await guild.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.parentId !== this.categoryId
      || !this.hasManagedRoomMarker(channel.name)) {
      throw new Error("Target CS voice channel is not a bot-owned room.");
    }
    await member.voice.setChannel(channel, "Route MAT-assigned player from CS lobby");
    return true;
  }

  async canRouteMemberFromLobby(memberId: string, lobbyChannelId: string): Promise<boolean> {
    const guild = await this.client.guilds.fetch(this.guildId);
    let member;
    try {
      member = await guild.members.fetch(memberId);
    } catch {
      return false;
    }
    return !member.user.bot && member.voice.channelId === lobbyChannelId
      && (!shouldSyncCsParticipantRole(member, this.crewRoleId)
        || member.roles.cache.has(this.participantRoleId)
        || Boolean(this.manualParticipantRoleId && member.roles.cache.has(this.manualParticipantRoleId))
        || member.roles.cache.has(this.crewRoleId)
        );
  }

  async canRouteMemberFromCsVoice(memberId: string, lobbyChannelId: string): Promise<boolean> {
    const guild = await this.client.guilds.fetch(this.guildId);
    let member;
    try {
      member = await guild.members.fetch(memberId);
    } catch {
      return false;
    }
    if (member.user.bot || !member.voice.channelId) return false;
    if (member.voice.channelId !== lobbyChannelId) {
      const source = await guild.channels.fetch(member.voice.channelId);
      if (!source || source.type !== ChannelType.GuildVoice || source.parentId !== this.categoryId) return false;
    }
    return !shouldSyncCsParticipantRole(member, this.crewRoleId)
      || member.roles.cache.has(this.participantRoleId)
      || Boolean(this.manualParticipantRoleId && member.roles.cache.has(this.manualParticipantRoleId))
      || member.roles.cache.has(this.crewRoleId);
  }

  async moveMemberFromCsVoice(memberId: string, channelId: string, lobbyChannelId: string): Promise<boolean> {
    const guild = await this.client.guilds.fetch(this.guildId);
    let member;
    try {
      member = await guild.members.fetch(memberId);
    } catch {
      return false;
    }
    const sourceChannelId = member.voice.channelId;
    const hasCsAccess = !shouldSyncCsParticipantRole(member, this.crewRoleId)
      || member.roles.cache.has(this.participantRoleId)
      || Boolean(this.manualParticipantRoleId && member.roles.cache.has(this.manualParticipantRoleId))
      || member.roles.cache.has(this.crewRoleId);
    if (member.user.bot || !sourceChannelId || sourceChannelId === channelId || !hasCsAccess) return false;
    if (sourceChannelId !== lobbyChannelId) {
      const source = await guild.channels.fetch(sourceChannelId);
      if (!source || source.type !== ChannelType.GuildVoice || source.parentId !== this.categoryId) return false;
    }
    const target = await guild.channels.fetch(channelId);
    if (!target || target.type !== ChannelType.GuildVoice || target.parentId !== this.categoryId
      || !/^\[MAT-[a-f0-9]{12}\] /.test(target.name)) {
      throw new Error("Target CS voice channel is not a bot-owned room.");
    }
    await member.voice.setChannel(target, "Route MAT-assigned player to updated CS team room");
    return true;
  }

  async setParticipantRole(memberId: string, shouldHaveRole: boolean): Promise<boolean> {
    const guild = await this.client.guilds.fetch(this.guildId);
    let member;
    try {
      member = await guild.members.fetch(memberId);
    } catch {
      return false;
    }
    if (member.user.bot || !shouldSyncCsParticipantRole(member, this.crewRoleId)) return false;
    const role = await guild.roles.fetch(this.participantRoleId);
    const botMember = await guild.members.fetchMe();
    if (!role || role.managed || role.id === guild.id
      || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)
      || botMember.roles.highest.comparePositionTo(role) <= 0
      || member.roles.highest.comparePositionTo(botMember.roles.highest) >= 0) {
      throw new Error("Bot cannot manage the CS participant role for this member.");
    }
    const currentlyHasRole = member.roles.cache.has(role.id);
    if (currentlyHasRole === shouldHaveRole) return false;
    if (shouldHaveRole) await member.roles.add(role, "NT-LAN participant is enrolled in a CS tournament");
    else await member.roles.remove(role, "NT-LAN participant is no longer enrolled in a CS tournament");
    return true;
  }

  async revokeMemberFromRoom(channelId: string, memberId: string): Promise<void> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.parentId !== this.categoryId
      || !this.hasManagedRoomMarker(channel.name)) return;
    if (channel.permissionOverwrites.cache.has(memberId)) {
      await channel.permissionOverwrites.delete(memberId, "CS tournament enrollment ended");
    }
    let member;
    try {
      member = await guild.members.fetch(memberId);
    } catch {
      return;
    }
    if (member.voice.channelId === channel.id) {
      const lobby = await guild.channels.fetch(this.lobbyChannelId);
      if (lobby?.type === ChannelType.GuildVoice && lobby.parentId === this.categoryId) {
        await member.voice.setChannel(lobby, "CS tournament enrollment ended");
      }
    }
  }

  async deleteRoomWhenEmpty(channelId: string, delayMs: number, onDeleted: () => Promise<void>): Promise<void> {
    if (this.roomDeleteTimers.has(channelId)) return;
    const guild = await this.client.guilds.fetch(this.guildId);
    const channel = await this.fetchChannelIfPresent(guild, channelId);
    if (!channel) {
      await onDeleted();
      return;
    }
    if (!this.isOwnedCsRoom(channel) || channel.members.size > 0) return;
    const timer = setTimeout(() => {
      this.roomDeleteTimers.delete(channelId);
      void this.deleteEmptyRoomIfStillOwned(channelId, onDeleted).catch(() => {
        console.error("Failed to delete an empty CS voice room; ownership state was preserved.");
      });
    }, delayMs);
    timer.unref();
    this.roomDeleteTimers.set(channelId, timer);
  }

  cancelRoomDeletion(channelId: string): void {
    const timer = this.roomDeleteTimers.get(channelId);
    if (!timer) return;
    clearTimeout(timer);
    this.roomDeleteTimers.delete(channelId);
  }

  cancelAllRoomDeletions(): void {
    for (const channelId of this.roomDeleteTimers.keys()) this.cancelRoomDeletion(channelId);
  }

  private async deleteEmptyRoomIfStillOwned(channelId: string, onDeleted: () => Promise<void>): Promise<void> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const channel = await this.fetchChannelIfPresent(guild, channelId);
    if (!channel) {
      await onDeleted();
      return;
    }
    if (!this.isOwnedCsRoom(channel) || channel.members.size > 0) return;
    await channel.delete("MAT-owned CS voice room remained empty");
    await onDeleted();
  }

  private async fetchChannelIfPresent(guild: Guild, channelId: string): Promise<GuildBasedChannel | null> {
    try {
      return await guild.channels.fetch(channelId);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 10003) return null;
      throw error;
    }
  }

  private isOwnedCsRoom(channel: unknown): channel is VoiceBasedChannel {
    return Boolean(channel && typeof channel === "object"
      && "type" in channel && channel.type === ChannelType.GuildVoice
      && "parentId" in channel && channel.parentId === this.categoryId
      && "name" in channel && typeof channel.name === "string"
      && this.hasManagedRoomMarker(channel.name));
  }

  private roomMarker(request: CsVoiceRoomRequest): string {
    return `[MAT-${createHash("sha256").update(request.key).digest("hex").slice(0, 12)}]`;
  }

  private hasRoomMarker(name: string, request: CsVoiceRoomRequest): boolean {
    const marker = this.roomMarker(request);
    return name.startsWith(`${marker} `) || name.endsWith(` ${marker}`);
  }

  private hasManagedRoomMarker(name: string): boolean {
    return /^\[MAT-[a-f0-9]{12}\] /.test(name) || / \[MAT-[a-f0-9]{12}\]$/.test(name);
  }

  private matchesManagedRoomName(name: string, request: CsVoiceRoomRequest): boolean {
    return name === this.channelName(request) || name === this.legacyChannelName(request);
  }

  private legacyChannelName(request: CsVoiceRoomRequest): string {
    const cleanName = request.name.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().replace(/\s+/g, " ");
    return `${this.roomMarker(request)} ${cleanName}`.slice(0, 100);
  }

  private channelName(request: CsVoiceRoomRequest): string {
    return formatCsRoomName(request.name, request.scope, this.roomMarker(request));
  }
}

export function shouldSyncCsParticipantRole(member: Parameters<typeof isCrewMember>[0], crewRoleId: string): boolean {
  if (member.id === member.guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) return false;
  const crewRole = member.guild.roles.cache.get(crewRoleId);
  if (!crewRole) return false;
  return member.roles.cache.has(crewRoleId) || member.roles.highest.comparePositionTo(crewRole) <= 0;
}