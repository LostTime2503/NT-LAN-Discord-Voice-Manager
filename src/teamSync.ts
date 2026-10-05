import { ChannelType, PermissionFlagsBits, type Client, type Guild, type Role, type VoiceChannel } from "discord.js";
import { config } from "./config.js";
import { getTeams, type MatTeam } from "./matClient.js";

const ROLE_PREFIX = "Lag: ";

let isSyncing = false;

export function startTeamSync(client: Client): void {
  if (!config.matUrl || !config.matApiToken) {
    console.log("Team sync is not configured. Set MAT_URL and MAT_API_TOKEN to enable it.");
    return;
  }

  void runTeamSync(client);
  setInterval(() => void runTeamSync(client), config.teamSyncIntervalMs);
}

async function runTeamSync(client: Client): Promise<void> {
  // Overlappende kjoringer kan skje hvis MAT svarer tregt naer neste intervall-tikk.
  if (isSyncing) {
    return;
  }

  isSyncing = true;

  try {
    const guild = await client.guilds.fetch(config.guildId);
    const teams = await getTeams();
    await guild.members.fetch();

    for (const team of teams) {
      await syncTeam(guild, team);
    }
  } catch (error) {
    console.error("Team sync failed", error);
  } finally {
    isSyncing = false;
  }
}

async function syncTeam(guild: Guild, team: MatTeam): Promise<void> {
  const role = await ensureTeamRole(guild, team);
  await ensureTeamVoiceChannel(guild, team, role);

  const targetMemberIds = new Set(team.players.map((player) => player.discordId).filter((id): id is string => Boolean(id)));

  for (const memberId of role.members.keys()) {
    if (!targetMemberIds.has(memberId)) {
      const member = guild.members.cache.get(memberId);
      await member?.roles.remove(role, "Not on this MAT team anymore");
    }
  }

  for (const discordId of targetMemberIds) {
    const member = guild.members.cache.get(discordId);

    if (member && !member.roles.cache.has(role.id)) {
      await member.roles.add(role, `Member of MAT team ${team.name}`);
    }
  }
}

async function ensureTeamRole(guild: Guild, team: MatTeam): Promise<Role> {
  const roleName = `${ROLE_PREFIX}${team.name}`;
  const existingRole = guild.roles.cache.find((role) => role.name === roleName);

  if (existingRole) {
    return existingRole;
  }

  return guild.roles.create({
    name: roleName,
    mentionable: false,
    reason: `Create Discord role for MAT team ${team.name}`
  });
}

async function ensureTeamVoiceChannel(guild: Guild, team: MatTeam, role: Role): Promise<VoiceChannel> {
  const category = config.csTeamCategoryId ? await guild.channels.fetch(config.csTeamCategoryId) : null;
  const existingChannel = guild.channels.cache.find(
    (channel): channel is VoiceChannel => channel.type === ChannelType.GuildVoice && channel.name === team.name
  );

  if (existingChannel) {
    return existingChannel;
  }

  return guild.channels.create({
    name: team.name,
    type: ChannelType.GuildVoice,
    parent: category?.type === ChannelType.GuildCategory ? category.id : undefined,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.Connect]
      },
      {
        id: role.id,
        allow: [PermissionFlagsBits.Connect]
      }
    ],
    reason: `Create voice channel for MAT team ${team.name}`
  });
}
