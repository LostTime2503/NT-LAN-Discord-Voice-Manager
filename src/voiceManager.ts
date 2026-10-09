import {
  type CategoryChannel,
  ChannelType,
  type Client,
  type GuildBasedChannel,
  type GuildMember,
  PermissionFlagsBits,
  type VoiceBasedChannel,
  type VoiceState
} from "discord.js";
import { config } from "./config.js";
import { sendCrewLogMessage } from "./crewLog.js";
import { accessInitializationError, accessManager } from "./accessRuntime.js";
import { createTemporaryVoiceOverwrites } from "./voicePermissions.js";
import { getBotText } from "./messages.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const temporaryChannelIds = new Set<string>();
const temporaryChannelOwners = new Map<string, string>();
const deleteTimers = new Map<string, NodeJS.Timeout>();
const ownersPath = join(process.cwd(), "data", "voice-owners.json");
let ownerSave: Promise<void> = Promise.resolve();
let voiceManagerEnabled = Boolean(config.joinToCreateChannelId);
const warnedUnprotectedCategories = new Set<string>();

export function setVoiceManagerEnabled(enabled: boolean): void {
  voiceManagerEnabled = enabled;
  if (!enabled) {
    for (const timer of deleteTimers.values()) clearTimeout(timer);
    deleteTimers.clear();
  }
}

async function loadVoiceOwners(): Promise<void> {
  try {
    const owners: unknown = JSON.parse(await readFile(ownersPath, "utf8"));
    if (!Array.isArray(owners) || owners.some((entry) => !Array.isArray(entry) || entry.length !== 2
      || entry.some((id) => typeof id !== "string" || !/^\d{17,20}$/.test(id)))) {
      throw new Error("Invalid voice owner data.");
    }
    for (const [channelId, ownerId] of owners as [string, string][]) {
      temporaryChannelIds.add(channelId);
      temporaryChannelOwners.set(channelId, ownerId);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function restoreTemporaryChannelOwners(): Promise<void> {
  await loadVoiceOwners();
}

async function saveVoiceOwners(): Promise<void> {
  const snapshot = JSON.stringify([...temporaryChannelOwners]);
  const task = ownerSave.catch(() => undefined).then(async () => {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    await writeFile(`${ownersPath}.tmp`, snapshot, { mode: 0o600 });
    await rename(`${ownersPath}.tmp`, ownersPath);
  });
  ownerSave = task;
  await task;
}

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  if (!voiceManagerEnabled) return;
  await handleJoinToCreate(newState);
  scheduleDeleteIfTemporaryChannelIsEmpty(oldState.channel);
  clearDeleteTimerIfChannelHasMembers(newState.channel);
}

export function logVoiceManagerStatus(client: Client): void {
  if (!config.joinToCreateChannelId) {
    console.log("Voice manager is not configured yet. Run /setup-voice-manager, then add JOIN_TO_CREATE_CHANNEL_ID to .env.");
    return;
  }

  const channel = client.channels.cache.get(config.joinToCreateChannelId);

  if (!channel) {
    console.log("Voice manager is configured, but the join-to-create channel is not in cache yet.");
    return;
  }

  console.log(`Voice manager is watching channel ${channel.id}.`);
}

export async function cleanupEmptyVoiceChannelsOnStartup(client: Client): Promise<void> {
  if (!config.joinToCreateChannelId) {
    return;
  }

  await loadVoiceOwners();

  const joinToCreateChannel = await client.channels.fetch(config.joinToCreateChannelId);

  if (!joinToCreateChannel || joinToCreateChannel.type !== ChannelType.GuildVoice || !joinToCreateChannel.parent) {
    console.log("Could not find a configured join-to-create voice channel with a parent category. Skipping startup cleanup.");
    return;
  }

  const voiceChannels = joinToCreateChannel.parent.children.cache.filter(
    (channel): channel is GuildBasedChannel & VoiceBasedChannel =>
      channel.type === ChannelType.GuildVoice && channel.id !== joinToCreateChannel.id
  );

  let deletedCount = 0;
  let adoptedCount = 0;

  for (const channel of voiceChannels.values()) {
    temporaryChannelIds.add(channel.id);
    const previousOwner = channel.permissionOverwrites.cache.find((overwrite) => overwrite.type === 1
      && overwrite.allow.has(PermissionFlagsBits.ManageChannels));
    if (previousOwner && !temporaryChannelOwners.has(channel.id)) temporaryChannelOwners.set(channel.id, previousOwner.id);

    if (channel.members.size === 0) {
      await deleteTemporaryChannel(channel);
      deletedCount += 1;
      continue;
    }

    adoptedCount += 1;
  }

  await saveVoiceOwners();

  console.log(`Startup cleanup deleted ${deletedCount} empty voice channel(s) and adopted ${adoptedCount} active channel(s).`);

  // Bruker kan ha blitt sittende fast i join-to-create kanalen mens boten var nede.
  const strandedMembers = [...joinToCreateChannel.members.values()];
  let movedCount = 0;

  for (const member of strandedMembers) {
    try {
      if (accessManager && !accessManager.canUseVoice(member)) continue;
      await createTemporaryChannelForMember(member, joinToCreateChannel.parent);
      movedCount += 1;
    } catch (error) {
      // En feil her (f.eks. brukeren forlot kanalen selv) skal ikke stoppe resten.
      console.error(`Failed to move stranded member ${member.id} out of the join-to-create channel`, error);
    }
  }

  if (strandedMembers.length > 0) {
    console.log(`Moved ${movedCount} of ${strandedMembers.length} stranded member(s) out of the join-to-create channel after startup.`);
  }
}

async function handleJoinToCreate(newState: VoiceState): Promise<void> {
  if (!voiceManagerEnabled || !config.joinToCreateChannelId || newState.channelId !== config.joinToCreateChannelId || !newState.member) {
    return;
  }

  await createTemporaryChannelForMember(newState.member, newState.channel?.parent ?? null);
}

async function createTemporaryChannelForMember(member: GuildMember, parent: CategoryChannel | null): Promise<void> {
  if (accessInitializationError) throw new Error("Access sync is unavailable; fix configuration before creating new voice channels.");
  if (accessManager && !accessManager.canUseVoice(member)) return;
  if (accessManager && !accessManager.settings.dryRun
    && !accessManager.isVoiceCategoryProtected(parent)) {
    const categoryId = parent?.id ?? "no-category";
    if (!warnedUnprotectedCategories.has(categoryId)) {
      warnedUnprotectedCategories.add(categoryId);
      const warning = "Join-to-create category may have incorrect @everyone/access-role View Channel or Connect overwrites; continuing and granting the creator access to their new channel.";
      console.warn(warning);
      void sendCrewLogMessage(member.client, warning);
    }
  }
  const channel = await member.guild.channels.create({
    name: `${member.displayName} sin kanal`,
    type: ChannelType.GuildVoice,
    parent,
    // Bruker serverens gjeldende maks bitrate, som stiger automatisk med boost-niva.
    bitrate: member.guild.maximumBitrate,
    permissionOverwrites: createTemporaryVoiceOverwrites(
      parent ? [...parent.permissionOverwrites.cache.values()] : [],
      member.id,
      !accessManager || accessManager.settings.dryRun
    ),
    reason: "Join-to-create temporary voice channel"
  });

  temporaryChannelIds.add(channel.id);
  temporaryChannelOwners.set(channel.id, member.id);
  await saveVoiceOwners();
  await sortTemporaryChannels(channel);
  await member.voice.setChannel(channel);
  void sendCrewLogMessage(member.client, getBotText("voice.channelCreated", {}, "logs"));
}

export async function renameTemporaryChannel(channel: VoiceBasedChannel, userId: string, newName: string): Promise<string> {
  if (!temporaryChannelIds.has(channel.id)) {
    throw new Error(getBotText("voiceName.notTemporary"));
  }

  const ownerId = temporaryChannelOwners.get(channel.id);

  const persistedOwnerId = channel.permissionOverwrites.cache.find((overwrite) => overwrite.type === 1 && overwrite.allow.has(PermissionFlagsBits.ManageChannels))?.id;
  if ((ownerId ?? persistedOwnerId) && (ownerId ?? persistedOwnerId) !== userId) {
    throw new Error(getBotText("voiceName.notOwner"));
  }
  if (accessManager && !accessManager.settings.dryRun && !ownerId && !persistedOwnerId) {
    throw new Error(getBotText("voiceName.ownerUnknown"));
  }

  const sanitizedName = sanitizeChannelName(newName);
  await channel.setName(sanitizedName, "Temporary voice channel renamed by owner");
  await sortTemporaryChannels(channel);

  return sanitizedName;
}

function scheduleDeleteIfTemporaryChannelIsEmpty(channel: VoiceBasedChannel | null): void {
  if (!channel || !temporaryChannelIds.has(channel.id) || channel.members.size > 0 || deleteTimers.has(channel.id)) {
    return;
  }

  const timer = setTimeout(() => {
    void deleteTemporaryChannel(channel);
  }, config.emptyChannelDeleteDelayMs);

  deleteTimers.set(channel.id, timer);
}

function clearDeleteTimerIfChannelHasMembers(channel: VoiceBasedChannel | null): void {
  if (!channel || channel.members.size === 0) {
    return;
  }

  const timer = deleteTimers.get(channel.id);

  if (!timer) {
    return;
  }

  clearTimeout(timer);
  deleteTimers.delete(channel.id);
}

async function deleteTemporaryChannel(channel: VoiceBasedChannel): Promise<void> {
  deleteTimers.delete(channel.id);

  if (channel.members.size > 0) {
    return;
  }

  temporaryChannelIds.delete(channel.id);
  temporaryChannelOwners.delete(channel.id);
  await saveVoiceOwners();
  await channel.delete("Temporary voice channel is empty.");
  void sendCrewLogMessage(channel.client, getBotText("voice.channelDeleted", {}, "logs"));
}

function sanitizeChannelName(name: string): string {
  const sanitizedName = name.trim().replace(/\s+/g, " ").slice(0, 80);

  if (!sanitizedName) {
    throw new Error(getBotText("voiceName.empty"));
  }

  return sanitizedName;
}

async function sortTemporaryChannels(channel: VoiceBasedChannel): Promise<void> {
  const category = channel.parent;

  if (!category) {
    return;
  }

  const joinToCreateChannel = config.joinToCreateChannelId ? category.children.cache.get(config.joinToCreateChannelId) : undefined;
  const temporaryChannels = [...category.children.cache.values()]
    .filter((child) => child.type === ChannelType.GuildVoice && temporaryChannelIds.has(child.id))
    .sort((left, right) => left.name.localeCompare(right.name, "nb"));

  const startPosition = joinToCreateChannel?.position ?? channel.position;

  for (const [index, temporaryChannel] of temporaryChannels.entries()) {
    await temporaryChannel.setPosition(startPosition + index + 1, {
      reason: "Sort temporary voice channels alphabetically"
    });
  }
}