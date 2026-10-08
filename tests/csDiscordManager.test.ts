import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceState } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import { test } from "node:test";
import { CsDiscordManager, type CsDiscordAdapter, type CsVoiceRoomRequest } from "../src/csDiscordManager.js";
import { createCsVoiceRoomOverwrites } from "../src/discordCsVoiceAdapter.js";
import type { MatBracketSummary } from "../src/matClient.js";
import type { MatWebhookEvent } from "../src/csWebhookServer.js";
import type { RegisteredPerson } from "../src/registrationClient.js";

const discordOne = "123456789012345678";
const discordTwo = "123456789012345679";
const discordThree = "123456789012345680";
const discordFour = "123456789012345681";
const steamOne = "76561198000000001";
const steamTwo = "76561198000000002";
const steamThree = "76561198000000003";
const steamFour = "76561198000000004";
const participants = new Map<string, RegisteredPerson>([
  [discordOne, { name: "private name one", firstName: "One", steamId: steamOne }],
  [discordTwo, { name: "private name two", firstName: "Two", steamId: steamTwo }],
  [discordThree, { name: "private name three", firstName: "Three", steamId: steamThree }],
  [discordFour, { name: "private name four", firstName: "Four", steamId: steamFour }]
]);

function matchEvent(
  type: string,
  tournamentId = "3",
  slug = "main-match",
  teamOneSteamIds: string[] = [steamOne],
  teamTwoSteamIds: string[] = [steamTwo]
): MatWebhookEvent {
  return {
    id: `${tournamentId}-${slug}-${type}`,
    type,
    test: false,
    sequence: 1,
    match: {
      id: slug,
      slug,
      status: type === "match.ready" ? "loaded" : "completed",
      tournamentId,
      team1: { id: "team-one", name: "Team One", tag: "ONE", steamIds: teamOneSteamIds },
      team2: { id: "team-two", name: "Team Two", tag: "TWO", steamIds: teamTwoSteamIds }
    }
  };
}

class FakeDiscordAdapter implements CsDiscordAdapter {
  readonly ensured: CsVoiceRoomRequest[] = [];
  readonly moved: Array<{ memberId: string; channelId: string }> = [];
  readonly roleChanges: Array<{ memberId: string; shouldHaveRole: boolean }> = [];
  readonly accessRevocations: Array<{ channelId: string; memberId: string }> = [];
  readonly deleteRequests: Array<{ channelId: string; delayMs: number; onDeleted: () => void }> = [];
  readonly memberChannels = new Map<string, string>();
  private readonly channelIds = new Map<string, string>();
  private wingmanChannelSequence = 0;

  async ensureRoom(request: CsVoiceRoomRequest, existingChannelId?: string): Promise<string> {
    this.ensured.push(request);
    const existing = existingChannelId ?? this.channelIds.get(request.key);
    if (existing) return existing;
    const channelId = request.scope === "main"
      ? request.teamId === "team-one" ? "222222222222222222" : "333333333333333333"
      : String(4_000_000_000_000_000_000n + BigInt(++this.wingmanChannelSequence));
    this.channelIds.set(request.key, channelId);
    return channelId;
  }

  async moveMemberFromSources(memberId: string, channelId: string, allowedSourceChannelIds: string[]): Promise<boolean> {
    const sourceChannelId = this.memberChannels.get(memberId);
    if (!sourceChannelId || !allowedSourceChannelIds.includes(sourceChannelId) || sourceChannelId === channelId) return false;
    this.moved.push({ memberId, channelId });
    this.memberChannels.set(memberId, channelId);
    return true;
  }

  async setParticipantRole(memberId: string, shouldHaveRole: boolean): Promise<boolean> {
    this.roleChanges.push({ memberId, shouldHaveRole });
    return true;
  }

  async revokeMemberFromRoom(channelId: string, memberId: string): Promise<void> {
    this.accessRevocations.push({ channelId, memberId });
  }

  deleteRoomWhenEmpty(channelId: string, delayMs: number, onDeleted: () => void): void {
    this.deleteRequests.push({ channelId, delayMs, onDeleted });
  }
}

function voiceState(channelId: string, id: string): VoiceState {
  return { channelId, id, member: { user: { bot: false } } } as unknown as VoiceState;
}

test("dry-run plans rooms but never calls Discord adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-"));
  const adapter = new FakeDiscordAdapter();
  const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, join(directory, "rooms.json"));
  try {
    await manager.load();
    const summary = await manager.handleMatchEvent(matchEvent("match.ready"), "main", participants, false);
    assert.equal(summary.plannedRooms, 2);
    assert.equal(summary.updatedRooms, 0);
    assert.equal(adapter.ensured.length, 0);
    assert.deepEqual(await manager.getRooms(), []);
    adapter.memberChannels.set(discordOne, "111111111111111111");
    assert.equal(await manager.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne)), false);
    assert.equal(adapter.moved.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live ready ensures stable main team rooms and lobby routing survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-"));
  const path = join(directory, "rooms.json");
  const adapter = new FakeDiscordAdapter();
  try {
    const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, path, false);
    await manager.load();
    adapter.memberChannels.set(discordOne, "111111111111111111");
    const summary = await manager.handleMatchEvent(matchEvent("match.ready"), "main", participants, false);
    assert.equal(summary.updatedRooms, 2);
    assert.deepEqual(adapter.ensured.map(room => room.key), ["main:3:team-one", "main:3:team-two"]);
    assert.deepEqual(adapter.moved, [{ memberId: discordOne, channelId: "222222222222222222" }]);

    const restarted = new CsDiscordManager(adapter, "111111111111111111", 5_000, path, false);
    await restarted.load();
    adapter.memberChannels.set(discordTwo, "111111111111111111");
    assert.equal(await restarted.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne)), false);
    assert.equal(await restarted.handleVoiceStateUpdate(voiceState("111111111111111111", discordTwo)), true);
    assert.deepEqual(adapter.moved, [
      { memberId: discordOne, channelId: "222222222222222222" },
      { memberId: discordTwo, channelId: "333333333333333333" }
    ]);
    assert.equal(await restarted.handleVoiceStateUpdate(voiceState("111111111111111111", "123456789012345680")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate competition assignments fail closed and Wingman terminal event retires only pair rooms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-"));
  const path = join(directory, "rooms.json");
  const adapter = new FakeDiscordAdapter();
  try {
    const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, path, false);
    await manager.load();
    await manager.handleMatchEvent(matchEvent("match.ready"), "main", participants, false);
    await manager.handleMatchEvent(
      matchEvent("match.ready", "4", "wingman-match", [steamOne, steamTwo], [steamThree, steamFour]),
      "wingman",
      participants,
      false
    );
    assert.equal(await manager.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne)), false);
    await manager.handleMatchEvent(matchEvent("match.finished", "4", "wingman-match"), "wingman", participants, false);
    assert.equal(adapter.deleteRequests.length, 2);
    assert.equal(adapter.deleteRequests.every(request => request.delayMs === 5_000), true);
    assert.deepEqual((await manager.getRooms()).map(room => [room.scope, room.retiring]), [
      ["main", undefined], ["main", undefined], ["wingman", true], ["wingman", true]
    ]);
    const restarted = new CsDiscordManager(adapter, "111111111111111111", 5_000, path);
    await restarted.load();
    assert.equal(adapter.deleteRequests.length, 4);
    adapter.deleteRequests.slice(-2).forEach(request => request.onDeleted());
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await restarted.getRooms()).map(room => room.scope), ["main", "main"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new Wingman pairing moves members out of their previous bot rooms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-"));
  const adapter = new FakeDiscordAdapter();
  const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, join(directory, "rooms.json"), false);
  try {
    await manager.load();
    for (const memberId of [discordOne, discordTwo, discordThree, discordFour]) {
      adapter.memberChannels.set(memberId, "111111111111111111");
    }
    await manager.handleMatchEvent(
      matchEvent("match.ready", "4", "wingman-round-1", [steamOne, steamTwo], [steamThree, steamFour]),
      "wingman",
      participants,
      false
    );
    const firstPairRooms = (await manager.getRooms()).filter(room => room.scope === "wingman");
    assert.equal(firstPairRooms.length, 2);

    await manager.handleMatchEvent(
      matchEvent("match.ready", "4", "wingman-round-2", [steamOne, steamThree], [steamTwo, steamFour]),
      "wingman",
      participants,
      false
    );
    const rooms = (await manager.getRooms()).filter(room => room.scope === "wingman");
    const activeRooms = rooms.filter(room => !room.retiring);
    const nextTeamOne = activeRooms.find(room => room.teamId === "team-one");
    const nextTeamTwo = activeRooms.find(room => room.teamId === "team-two");
    assert.ok(nextTeamOne);
    assert.ok(nextTeamTwo);
    assert.equal(adapter.memberChannels.get(discordOne), nextTeamOne.channelId);
    assert.equal(adapter.memberChannels.get(discordThree), nextTeamOne.channelId);
    assert.equal(adapter.memberChannels.get(discordTwo), nextTeamTwo.channelId);
    assert.equal(adapter.memberChannels.get(discordFour), nextTeamTwo.channelId);
    assert.equal(rooms.filter(room => room.retiring).length, 2);
    assert.equal(adapter.deleteRequests.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private team-room overwrites deny broad roles and allow only mapped members, Crew, and bot", () => {
  const overwrites = createCsVoiceRoomOverwrites({
    everyoneRoleId: "111111111111111111",
    participantRoleId: "222222222222222222",
    crewRoleId: "333333333333333333",
    botUserId: "444444444444444444",
    memberIds: [discordOne, discordOne, discordTwo]
  });
  assert.equal(overwrites.length, 6);
  assert.deepEqual(overwrites[0]?.deny, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
  assert.deepEqual(overwrites[1]?.deny, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
  assert.deepEqual(overwrites[2]?.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
  assert.deepEqual(overwrites[3]?.allow, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.MoveMembers
  ]);
  assert.deepEqual(overwrites.slice(4).map(overwrite => overwrite.id), [discordOne, discordTwo]);
});

test("main bracket snapshot prepares every known team room before a match is ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-"));
  const adapter = new FakeDiscordAdapter();
  const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, join(directory, "rooms.json"), false);
  const bracket: MatBracketSummary = {
    tournament: { id: 3, type: "single_elimination", status: "ready", teamSize: 2 },
    totalRounds: 1,
    matches: [{ slug: "upcoming", round: 1, status: "pending", team1Id: "team-one", team2Id: "team-two" }]
  };
  try {
    await manager.load();
    const summary = await manager.reconcileMainTournamentRooms("3", bracket, [
      { id: "team-one", name: "Team One", tag: "ONE", players: [{ steamId: steamOne }] },
      { id: "team-two", name: "Team Two", tag: "TWO", players: [{ steamId: steamTwo }] }
    ], participants, false);
    assert.equal(summary.plannedRooms, 2);
    assert.equal(adapter.ensured.length, 2);
    assert.deepEqual(adapter.ensured.map(room => room.key), ["main:3:team-one", "main:3:team-two"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CS role reconciliation uses explicit enrollment and preserves missing/manual entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-"));
  const adapter = new FakeDiscordAdapter();
  const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, join(directory, "rooms.json"), false);
  const roleParticipants = new Map<string, RegisteredPerson>([
    [discordOne, { name: "Main player", firstName: "Main", tournaments: ["cs2"] }],
    [discordTwo, { name: "Wingman player", firstName: "Wingman", tournaments: ["cs2-wingman"] }],
    [discordThree, { name: "No longer enrolled", firstName: "No", tournaments: [] }],
    [discordFour, { name: "Missing field", firstName: "Missing" }],
    ["123456789012345682", { name: "Manual link", firstName: "Manual", steamId: steamOne, manualCsLink: true, tournaments: [] }]
  ]);
  try {
    await manager.load();
    const summary = await manager.reconcileParticipantRoles(roleParticipants, false);
    assert.deepEqual(summary, { granted: 2, removed: 1, unchanged: 0, preservedMissingData: 1, manualLinks: 1 });
    assert.deepEqual(adapter.roleChanges, [
      { memberId: discordOne, shouldHaveRole: true },
      { memberId: discordTwo, shouldHaveRole: true },
      { memberId: discordThree, shouldHaveRole: false }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit tournament opt-out removes CS role and managed room access only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-"));
  const adapter = new FakeDiscordAdapter();
  const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, join(directory, "rooms.json"), false);
  try {
    await manager.load();
    await manager.handleMatchEvent(matchEvent("match.ready"), "main", participants, false);
    const roleSummary = await manager.reconcileParticipantRoles(new Map([
      [discordOne, { ...participants.get(discordOne)!, tournaments: [] }],
      [discordTwo, { ...participants.get(discordTwo)!, tournaments: ["cs2"] }],
      [discordThree, { name: "Missing enrollment", firstName: "Missing", steamId: steamThree }]
    ]), false);

    assert.equal(roleSummary.removed, 1);
    assert.equal(roleSummary.granted, 1);
    assert.equal(roleSummary.preservedMissingData, 1);
    assert.deepEqual(adapter.accessRevocations, [{ channelId: "222222222222222222", memberId: discordOne }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});