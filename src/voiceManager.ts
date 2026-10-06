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

const temporaryChannelIds = new Set<string>();
const temporaryChannelOwners = new Map<string, string>();
const deleteTimers = new Map<string, NodeJS.Timeout>();

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
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

    if (channel.members.size === 0) {
      await deleteTemporaryChannel(channel);
      deletedCount += 1;
      continue;
    }

    adoptedCount += 1;
  }

  console.log(`Startup cleanup deleted ${deletedCount} empty voice channel(s) and adopted ${adoptedCount} active channel(s).`);

  // Bruker kan ha blitt sittende fast i join-to-create kanalen mens boten var nede.
  const strandedMembers = [...joinToCreateChannel.members.values()];
  let movedCount = 0;

  for (const member of strandedMembers) {
    try {
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
  if (!config.joinToCreateChannelId || newState.channelId !== config.joinToCreateChannelId || !newState.member) {
    return;
  }

  await createTemporaryChannelForMember(newState.member, newState.channel?.parent ?? null);
}

async function createTemporaryChannelForMember(member: GuildMember, parent: CategoryChannel | null): Promise<void> {
  const channel = await member.guild.channels.create({
    name: `${member.displayName} sin kanal`,
    type: ChannelType.GuildVoice,
    parent,
    // Bruker serverens gjeldende maks bitrate, som stiger automatisk med boost-niva.
    bitrate: member.guild.maximumBitrate,
    // Gir eieren lov til a endre kanalnavn direkte i Discord. Overlever bot-restart siden Discord lagrer dette, ikke boten.
    permissionOverwrites: [
      {
        id: member.id,
        allow: [PermissionFlagsBits.ManageChannels]
      }
    ],
    reason: "Join-to-create temporary voice channel"
  });

  temporaryChannelIds.add(channel.id);
  temporaryChannelOwners.set(channel.id, member.id);
  await sortTemporaryChannels(channel);
  await member.voice.setChannel(channel);
}

export async function renameTemporaryChannel(channel: VoiceBasedChannel, userId: string, newName: string): Promise<string> {
  if (!temporaryChannelIds.has(channel.id)) {
    throw new Error("Du ma sta i en midlertidig voice-kanal som boten har laget.");
  }

  const ownerId = temporaryChannelOwners.get(channel.id);

  if (ownerId && ownerId !== userId) {
    throw new Error("Bare personen som laget kanalen kan endre navnet.");
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
  await channel.delete("Temporary voice channel is empty.");
}

function sanitizeChannelName(name: string): string {
  const sanitizedName = name.trim().replace(/\s+/g, " ").slice(0, 80);

  if (!sanitizedName) {
    throw new Error("Kanalnavnet kan ikke vaere tomt.");
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