import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceState } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import { test } from "node:test";
import { CsDiscordManager, type CsDiscordAdapter, type CsVoiceRoomRequest } from "../src/csDiscordManager.js";
import { createCsVoiceRoomOverwrites, ManualCsRoomDriftError } from "../src/discordCsVoiceAdapter.js";
import type { MatBracketSummary, MatMatchSnapshot } from "../src/matClient.js";
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
  driftTeamId: string | undefined;
  private readonly channelIds = new Map<string, string>();
  private wingmanChannelSequence = 0;

  async canRouteMemberFromLobby(memberId: string, lobbyChannelId: string): Promise<boolean> {
    return this.memberChannels.get(memberId) === lobbyChannelId;
  }

  async ensureRoom(request: CsVoiceRoomRequest, existingChannelId?: string): Promise<string> {
    this.ensured.push(request);
    const existing = existingChannelId ?? this.channelIds.get(request.key);
    if (existing && this.driftTeamId === request.teamId) throw new ManualCsRoomDriftError("Synthetic manual room edit.");
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

test("match-ready stores team assignments and creates only the joining member's room", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-"));
  const path = join(directory, "rooms.json");
  const adapter = new FakeDiscordAdapter();
  try {
    const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, path, false);
    await manager.load();
    adapter.memberChannels.set(discordOne, "111111111111111111");
    const summary = await manager.handleMatchEvent(matchEvent("match.ready"), "main", participants, false);
    assert.equal(summary.plannedRooms, 2);
    assert.equal(summary.updatedRooms, 0);
    assert.equal(adapter.ensured.length, 0);
    assert.deepEqual((await manager.getAssignments()).map(request => request.key), ["main:3:team-one", "main:3:team-two"]);
    assert.equal(await manager.getRooms().then(rooms => rooms.length), 0);

    assert.equal(await manager.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne)), true);
    assert.deepEqual(adapter.ensured.map(room => room.key), ["main:3:team-one"]);
    assert.deepEqual(adapter.moved, [{ memberId: discordOne, channelId: "222222222222222222" }]);

    const restarted = new CsDiscordManager(adapter, "111111111111111111", 5_000, path, false);
    await restarted.load();
    adapter.memberChannels.set(discordTwo, "111111111111111111");
    assert.equal(await restarted.handleVoiceStateUpdate(voiceState("111111111111111111", discordTwo)), true);
    assert.deepEqual(adapter.moved, [
      { memberId: discordOne, channelId: "222222222222222222" },
      { memberId: discordTwo, channelId: "333333333333333333" }
    ]);
    assert.deepEqual(adapter.ensured.map(room => room.key), ["main:3:team-one", "main:3:team-two"]);
    assert.equal(await restarted.handleVoiceStateUpdate(voiceState("111111111111111111", "123456789012345680")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate active assignments fail closed; terminal Wingman events clear routing without Discord mutations", async () => {
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
    adapter.memberChannels.set(discordOne, "111111111111111111");
    assert.equal(await manager.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne)), false);
    assert.equal(adapter.ensured.length, 0);
    await manager.handleMatchEvent(matchEvent("match.finished", "4", "wingman-match"), "wingman", participants, false);
    assert.equal(adapter.deleteRequests.length, 0);
    assert.equal(await manager.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne)), true);
    assert.deepEqual(adapter.ensured.map(room => room.key), ["main:3:team-one"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new Wingman pairing replaces pending assignments and routes only members who enter the lobby", async () => {
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
    assert.equal(adapter.ensured.length, 0);
    assert.equal((await manager.getAssignments()).filter(request => request.scope === "wingman").length, 2);

    await manager.handleMatchEvent(
      matchEvent("match.ready", "4", "wingman-round-2", [steamOne, steamThree], [steamTwo, steamFour]),
      "wingman",
      participants,
      false
    );
    const assignments = await manager.getAssignments();
    assert.equal(assignments.filter(request => request.scope === "wingman").length, 2);
    assert.deepEqual(adapter.ensured, []);

    adapter.memberChannels.set(discordOne, "111111111111111111");
    const routed = await manager.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne));
    assert.equal(routed, true);
    assert.equal(adapter.ensured.length, 1);
    assert.equal(adapter.ensured[0]?.matchSlug, "wingman-round-2");
    assert.equal(adapter.moved.length, 1);
    assert.equal(adapter.moved[0]?.memberId, discordOne);
    assert.equal(adapter.deleteRequests.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Wingman GET recovery restores an active assignment without Discord writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-"));
  const adapter = new FakeDiscordAdapter();
  const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, join(directory, "rooms.json"), false);
  const snapshot: MatMatchSnapshot = {
    id: "match-42",
    slug: "active-wingman",
    status: "live",
    tournamentId: "4",
    round: 2,
    team1: { id: "team-one", name: "Pair One", tag: "ONE", steamIds: [steamOne, steamTwo] },
    team2: { id: "team-two", name: "Pair Two", tag: "TWO", steamIds: [steamThree, steamFour] }
  };
  try {
    await manager.load();
    const recovered = await manager.reconcileWingmanSnapshot("4", snapshot, participants, false);
    assert.equal(recovered.plannedRooms, 2);
    assert.deepEqual((await manager.getAssignments()).map(request => request.matchSlug), ["active-wingman", "active-wingman"]);
    assert.equal(adapter.ensured.length, 0);
    assert.equal((await manager.getRooms()).length, 0);
    await manager.reconcileWingmanSnapshot("4", null, participants, false);
    assert.equal(adapter.deleteRequests.length, 0);
    assert.equal((await manager.getAssignments()).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CS team rooms allow both CS participant roles, Crew, bot, and mapped members", () => {
  const overwrites = createCsVoiceRoomOverwrites({
    everyoneRoleId: "111111111111111111",
    participantRoleId: "222222222222222222",
    manualParticipantRoleId: "222222222222222223",
    crewRoleId: "333333333333333333",
    botUserId: "444444444444444444",
    memberIds: [discordOne, discordOne, discordTwo]
  });
  assert.equal(overwrites.length, 7);
  assert.deepEqual(overwrites[0]?.deny, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
  assert.deepEqual(overwrites[1]?.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
  assert.deepEqual(overwrites[2]?.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
  assert.deepEqual(overwrites[3]?.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
  assert.deepEqual(overwrites[4]?.allow, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.MoveMembers
  ]);
  assert.deepEqual(overwrites.slice(5).map(overwrite => overwrite.id), [discordOne, discordTwo]);
});

test("main bracket snapshot stores every known team assignment without creating rooms", async () => {
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
    assert.equal(adapter.ensured.length, 0);
    assert.deepEqual((await manager.getAssignments()).map(request => request.key), ["main:3:team-one", "main:3:team-two"]);
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
    adapter.memberChannels.set(discordOne, "111111111111111111");
    assert.equal(await manager.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne)), true);
    const roleSummary = await manager.reconcileParticipantRoles(new Map([
      [discordOne, { ...participants.get(discordOne)!, tournaments: [] }],
      [discordTwo, { ...participants.get(discordTwo)!, tournaments: ["cs2"] }],
      [discordThree, { name: "Missing enrollment", firstName: "Missing", steamId: steamThree }]
    ]), false);

    assert.equal(roleSummary.removed, 1);
    assert.equal(roleSummary.granted, 1);
    assert.equal(roleSummary.preservedMissingData, 1);
    assert.deepEqual(adapter.accessRevocations, [{ channelId: "222222222222222222", memberId: discordOne }]);
    assert.equal((await manager.getAssignments()).some(request => request.memberIds.includes(discordOne)), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manually changed MAT rooms are locked and skipped by later reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs-discord-manager-drift-"));
  const path = join(directory, "rooms.json");
  const adapter = new FakeDiscordAdapter();
  try {
    const manager = new CsDiscordManager(adapter, "111111111111111111", 5_000, path, false);
    await manager.load();
    adapter.memberChannels.set(discordOne, "111111111111111111");
    await manager.handleMatchEvent(
      matchEvent("match.ready", "3", "main-match", [steamOne, steamTwo], [steamThree, steamFour]),
      "main",
      participants,
      false
    );
    assert.equal(await manager.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne)), true);
    adapter.driftTeamId = "team-one";
    adapter.memberChannels.set(discordTwo, "111111111111111111");
    assert.equal(await manager.handleVoiceStateUpdate(voiceState("111111111111111111", discordTwo)), false);
    assert.equal(adapter.moved.some(move => move.memberId === discordTwo), false);
    assert.equal((await manager.getRooms()).find(room => room.teamId === "team-one")?.manualOverride, true);

    const restarted = new CsDiscordManager(adapter, "111111111111111111", 5_000, path, false);
    await restarted.load();
    const ensureCallsBefore = adapter.ensured.filter(room => room.teamId === "team-one").length;
    adapter.memberChannels.set(discordOne, "111111111111111111");
    assert.equal(await restarted.handleVoiceStateUpdate(voiceState("111111111111111111", discordOne)), false);
    assert.equal(adapter.ensured.filter(room => room.teamId === "team-one").length, ensureCallsBefore);
    assert.equal((await restarted.getRooms()).find(room => room.teamId === "team-one")?.manualOverride, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});