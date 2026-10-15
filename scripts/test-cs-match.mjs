import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { DiscordJsCsVoiceAdapter } from "../src/discordCsVoiceAdapter.js";
import { CsDiscordManager } from "../src/csDiscordManager.js";
import { manualOverrideStore } from "../src/manualOverrides.js";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Mangler miljøvariabel: ${name}`);
  return value;
}

function requiredSnowflake(name, value) {
  if (!value || !/^\d{17,20}$/.test(value)) {
    throw new Error(`${name} må være en numerisk Discord-ID. Bruk Kopier ID i Discord, ikke teksten CATEGORY_ID/LOBBY_ID.`);
  }
  return value;
}

function readConfig() {
  const deleteDelay = Number(process.env.CS_EMPTY_CHANNEL_DELETE_DELAY_MS ?? 30000);
  if (!Number.isInteger(deleteDelay) || deleteDelay <= 0) {
    throw new Error("CS_EMPTY_CHANNEL_DELETE_DELAY_MS må være et positivt heltall.");
  }
  return {
    token: requiredEnv("DISCORD_TOKEN"),
    guildId: requiredSnowflake("DISCORD_GUILD_ID / --guild-id", readOption("guild-id") ?? process.env.DISCORD_GUILD_ID),
    csCategoryId: requiredSnowflake("CS_CATEGORY_ID / --category-id", readOption("category-id") ?? process.env.CS_CATEGORY_ID ?? process.env.CS_TEAM_CATEGORY_ID),
    csLobbyChannelId: requiredSnowflake("CS_LOBBY_CHANNEL_ID / --lobby-id", readOption("lobby-id") ?? process.env.CS_LOBBY_CHANNEL_ID),
    csParticipantRoleId: requiredSnowflake("CS_PARTICIPANT_ROLE_ID", process.env.CS_PARTICIPANT_ROLE_ID),
    manualCsParticipantRoleId: requiredSnowflake("MANUAL_CS_PARTICIPANT_ROLE_ID", process.env.MANUAL_CS_PARTICIPANT_ROLE_ID),
    crewRoleId: requiredSnowflake("CREW_ROLE_ID", process.env.CREW_ROLE_ID),
    emptyChannelDeleteDelayMs: deleteDelay
  };
}

function readOption(name) {
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function readSteamIds(name) {
  const value = readOption(name) ?? "";
  const ids = value.split(",").map(id => id.trim()).filter(Boolean);
  if (ids.length < 1 || ids.some(id => !/^7656119\d{10}$/.test(id))) {
    throw new Error(`--${name} må inneholde én eller flere formatgyldige SteamID64-er.`);
  }
  return ids;
}

const scope = readOption("scope");
if (scope !== "main" && scope !== "wingman") throw new Error("Bruk --scope=main eller --scope=wingman.");
const teamOneSteamIds = readSteamIds("team-one");
const teamTwoSteamIds = readSteamIds("team-two");
const allSteamIds = [...teamOneSteamIds, ...teamTwoSteamIds];
if (new Set(allSteamIds).size !== allSteamIds.length) throw new Error("SteamID64-ene må være unike på tvers av begge lag.");
if (scope === "wingman" && (teamOneSteamIds.length !== 2 || teamTwoSteamIds.length !== 2)) {
  throw new Error("Wingman-testen krever nøyaktig to SteamID64-er på hvert lag.");
}
const confirmed = process.argv.includes("--confirm");
const tournamentId = readOption("tournament-id") ?? `local-${scope}`;
const matchId = readOption("match-id") ?? `local-${scope}-test`;
if (!/^[A-Za-z0-9_-]{1,64}$/.test(matchId)) throw new Error("--match-id kan bare inneholde bokstaver, tall, bindestrek og understrek.");
const teamOneName = readOption("team-one-name") ?? "Testpar A";
const teamOneTag = readOption("team-one-tag") ?? "TEST-A";
const teamTwoName = readOption("team-two-name") ?? "Testpar B";
const teamTwoTag = readOption("team-two-tag") ?? "TEST-B";
const config = readConfig();

await manualOverrideStore.load();
const participants = await manualOverrideStore.getCsParticipants(new Map());
const participantDiscordIdsBySteamId = new Map([...participants].flatMap(([discordId, participant]) =>
  participant.steamId ? [[participant.steamId, discordId]] : []));
const missingSteamIds = allSteamIds.filter(steamId => !participantDiscordIdsBySteamId.has(steamId));
if (missingSteamIds.length) {
  throw new Error(`Fant ingen lokal /cs-link-mapping for ${missingSteamIds.length} av de oppgitte SteamID64-ene.`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers]
});
const ready = once(client, Events.ClientReady);

try {
  await client.login(config.token);
  await ready;
  const adapter = new DiscordJsCsVoiceAdapter(
    client,
    config.guildId,
    config.csCategoryId,
    config.csLobbyChannelId,
    config.csParticipantRoleId,
    config.manualCsParticipantRoleId,
    config.crewRoleId
  );
  await adapter.validate();
  const assignedDiscordIds = allSteamIds.map(steamId => participantDiscordIdsBySteamId.get(steamId));
  const csVoicePresence = await Promise.all(assignedDiscordIds.map(discordId =>
    adapter.canRouteMemberFromCsVoice(discordId, config.csLobbyChannelId)));
  const lobbyPresence = await Promise.all(assignedDiscordIds.map(discordId =>
    adapter.canRouteMemberFromLobby(discordId, config.csLobbyChannelId)));
  const statePath = join(tmpdir(), `ntlan-cs-local-test-${config.guildId}.json`);
  const manager = new CsDiscordManager(
    adapter,
    config.csLobbyChannelId,
    config.emptyChannelDeleteDelayMs,
    statePath,
    !confirmed
  );
  await manager.load();
  const voiceStateTasks = new Set();
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    let task;
    task = manager.handleVoiceStateUpdate(newState, oldState.channelId ?? undefined)
      .catch(() => console.error("Local CS voice-state handling failed."))
      .finally(() => voiceStateTasks.delete(task));
    voiceStateTasks.add(task);
  });
  const event = {
    id: matchId,
    type: "match.ready",
    test: false,
    sequence: 1,
    match: {
      id: matchId,
      slug: matchId,
      status: "loaded",
      tournamentId,
      team1: {
        id: `${matchId}-a`, name: teamOneName, tag: teamOneTag,
        steamIds: teamOneSteamIds
      },
      team2: {
        id: `${matchId}-b`, name: teamTwoName, tag: teamTwoTag,
        steamIds: teamTwoSteamIds
      }
    }
  };
  const summary = await manager.handleMatchEvent(event, scope, participants, !confirmed);
  const assignments = await manager.getAssignments();
  if (!confirmed) {
    console.log(JSON.stringify({
      mode: "preview",
      scope,
      guildId: config.guildId,
      categoryId: config.csCategoryId,
      lobbyId: config.csLobbyChannelId,
      assignedMembersInCsVoice: csVoicePresence.filter(Boolean).length,
      assignedMembersInLobby: lobbyPresence.filter(Boolean).length,
      assignedMembers: assignedDiscordIds.length,
      plan: summary,
      assignments: assignments.map(request => ({ name: request.name, memberCount: request.memberIds.length })),
      assignmentCount: assignments.length
    }, null, 2));
  } else {
    const rooms = await manager.getRooms();
    console.log(JSON.stringify({
      mode: "confirmed",
      scope,
      guildId: config.guildId,
      categoryId: config.csCategoryId,
      lobbyId: config.csLobbyChannelId,
      assignedMembersInCsVoice: csVoicePresence.filter(Boolean).length,
      assignedMembersInLobby: lobbyPresence.filter(Boolean).length,
      assignedMembers: assignedDiscordIds.length,
      summary,
      assignments: assignments.map(request => ({ name: request.name, memberCount: request.memberIds.length })),
      createdOrRoutedMembers: summary.updatedRooms,
      managedRooms: rooms.length
    }, null, 2));
    if (process.argv.includes("--wait-for-cleanup")) {
      console.log(`Venter ${config.emptyChannelDeleteDelayMs} ms på opprydding av tomme CS-rom.`);
      await new Promise(resolve => setTimeout(resolve, config.emptyChannelDeleteDelayMs + 1_000));
      await Promise.all([...voiceStateTasks]);
      console.log(JSON.stringify({ cleanupComplete: true, managedRoomsAfterCleanup: (await manager.getRooms()).length }, null, 2));
    }
  }
} finally {
  client.destroy();
}