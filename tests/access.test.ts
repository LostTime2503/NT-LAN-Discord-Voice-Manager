import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type CategoryChannel, type Client, type GuildMember } from "discord.js";
import { AccessConfigurationError, AccessManager, describeAccessStartupError, isCrewMember, reconcileMember, startAccessSync, type AccessSettings } from "../src/accessManager.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualOverrideStore } from "../src/manualOverrides.js";
import { getBotText, parseBotMessages, renderCsNotification } from "../src/messages.js";

const settings: AccessSettings = {
  guildId: "123456789012345678", accessRoleId: "123456789012345679", manualAccessRoleId: "123456789012345686",
  crewRoleId: "123456789012345680",
  channelId: "123456789012345681", websiteUrl: "https://example.test/", dryRun: false,
  intervalMs: 60_000
};
const person = { name: "Test Person", firstName: "Test" };

function fixture(options: { crew?: boolean; higher?: boolean; manageable?: boolean; failRename?: boolean; nickname?: string } = {}) {
  const actions: string[] = [];
  const role = (id: string, position: number) => ({ id, position, managed: false, permissions: new PermissionsBitField(),
    comparePositionTo(other: { position: number }) { return this.position - other.position; } });
  const crew = role(settings.crewRoleId, 10);
  const access = role(settings.accessRoleId, 2);
  const manualAccess = role(settings.manualAccessRoleId, 3);
  const bot = role("123456789012345682", 8);
  const rolesById = new Map([[crew.id, crew], [access.id, access], [manualAccess.id, manualAccess]]);
  const memberRole = options.crew ? crew : role("123456789012345683", options.higher ? 11 : 1);
  const memberRoles = new Collection([[memberRole.id, memberRole]]);
  const member = {
    id: "123456789012345684", user: { bot: false }, nickname: options.nickname ?? null,
    manageable: options.manageable ?? true, permissions: new PermissionsBitField(),
    roles: { cache: memberRoles, highest: memberRole,
      async add(roleId: string) { actions.push(roleId === settings.manualAccessRoleId ? "manual-role" : "role"); memberRoles.set(roleId, rolesById.get(roleId) ?? {}); },
      async remove(roleId: string) { actions.push(roleId === settings.manualAccessRoleId ? "remove-manual-role" : "remove-role"); memberRoles.delete(roleId); } },
    async setNickname() { actions.push("nickname"); if (options.failRename) throw new Error("Synthetic failure"); },
    guild: {
      id: settings.guildId, ownerId: "123456789012345685",
      roles: { cache: new Collection([[crew.id, crew], [access.id, access], [manualAccess.id, manualAccess]]) },
      members: { me: { permissions: new PermissionsBitField([PermissionFlagsBits.ManageNicknames, PermissionFlagsBits.ManageRoles]),
        roles: { highest: bot } } }
    }
  } as unknown as GuildMember;
  return { member, actions };
}

test("ordinary members receive nickname before access", async () => {
  const { member, actions } = fixture();
  assert.equal(await reconcileMember(member, person, settings), "verified");
  assert.deepEqual(actions, ["nickname", "role"]);
});

test("manual access is promoted to website-verified access after a successful live check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-access-promotion-"));
  const { member, actions } = fixture();
  const manualRole = member.guild.roles.cache.get(settings.manualAccessRoleId)!;
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me, fetch: async () => member });
  Object.assign(member.roles, {
    add: async (roleId: string) => {
      actions.push(roleId === settings.manualAccessRoleId ? "manual-role" : "role");
      member.roles.cache.set(roleId, roleId === settings.manualAccessRoleId ? manualRole : member.guild.roles.cache.get(roleId)!);
    },
    remove: async (roleId: string) => {
      actions.push(roleId === settings.manualAccessRoleId ? "remove-manual-role" : "remove-role");
      member.roles.cache.delete(roleId);
    }
  });
  Object.assign(member, { setNickname: async (nickname: string) => { actions.push("nickname"); member.nickname = nickname; } });
  let apiCalls = 0;
  const store = new ManualOverrideStore(join(directory, "overrides.json"));
  const manager = new AccessManager(settings, async () => {
    apiCalls += 1;
    return new Map([[member.id, { name: "Website Name", firstName: "Website" }]]);
  }, store);
  const auditActions: Array<{ action: string; nickname?: string }> = [];
  manager.setActionReporter(action => auditActions.push({
    action: action.action,
    ...(action.nickname ? { nickname: action.nickname } : {})
  }));
  try {
    await manager.grantManualAccess(member, "Chosen Nickname", "123456789012345685");
    assert.equal(await manager.check(member), "verified");
    assert.equal(member.nickname, "Website N.");
    assert.equal(apiCalls, 1);
    assert.equal(member.roles.cache.has(settings.manualAccessRoleId), false);
    assert.equal(member.roles.cache.has(settings.accessRoleId), true);
    assert.equal(await store.getAccessOverride(member.id), undefined);
    assert.deepEqual(auditActions, [
      { action: "nickname-set", nickname: "Chosen Nickname" },
      { action: "manual-role-granted" },
      { action: "nickname-set", nickname: "Website N." },
      { action: "manual-role-promoted" }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual access preview reports a found website link without mutating either role", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-access-linked-preview-"));
  const { member, actions } = fixture();
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me, fetch: async () => member });
  const store = new ManualOverrideStore(join(directory, "overrides.json"));
  let apiCalls = 0;
  const manager = new AccessManager({ ...settings, dryRun: true }, async () => {
    apiCalls += 1;
    return new Map([[member.id, person]]);
  }, store);
  try {
    await manager.grantManualAccess(member, "Chosen Nickname", "123456789012345685", true);
    actions.length = 0;
    assert.equal(await manager.check(member), "dry-run-linked");
    assert.equal(apiCalls, 1);
    assert.deepEqual(actions, []);
    assert.equal(member.roles.cache.has(settings.manualAccessRoleId), true);
    assert.equal(member.roles.cache.has(settings.accessRoleId), false);
    assert.ok(await store.getAccessOverride(member.id));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registration API failure preserves manual access and its override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-access-api-failure-"));
  const { member } = fixture();
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me, fetch: async () => member });
  const store = new ManualOverrideStore(join(directory, "overrides.json"));
  const manager = new AccessManager(settings, async () => { throw new Error("Synthetic API outage"); }, store);
  try {
    await manager.grantManualAccess(member, "Chosen Nickname", "123456789012345685");
    assert.equal(await manager.check(member), "manual-override");
    assert.equal(member.roles.cache.has(settings.manualAccessRoleId), true);
    assert.ok(await store.getAccessOverride(member.id));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manually removed access role clears its override and is not restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-access-revoke-event-"));
  const { member, actions } = fixture();
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me, fetch: async () => member });
  const store = new ManualOverrideStore(join(directory, "overrides.json"));
  let apiCalls = 0;
  const manager = new AccessManager(settings, async () => { apiCalls += 1; return new Map(); }, store);
  try {
    await manager.grantManualAccess(member, "Chosen Nickname", "123456789012345685");
    actions.length = 0;
    const oldMember = {
      ...member,
      roles: { ...member.roles, cache: new Collection(member.roles.cache) }
    } as GuildMember;
    member.roles.cache.delete(settings.manualAccessRoleId);
    await manager.handleManualAccessRoleRemoval(oldMember, member, false);

    assert.equal(await store.getAccessOverride(member.id), undefined);
    assert.equal(await manager.check(member), "not-linked");
    assert.equal(member.roles.cache.has(settings.manualAccessRoleId), false);
    assert.equal(member.roles.cache.has(settings.accessRoleId), false);
    assert.equal(apiCalls, 1);
    assert.deepEqual(actions, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missed manual-role removal event is detected by the next access check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-access-revoke-poll-"));
  const { member } = fixture();
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me, fetch: async () => member });
  const store = new ManualOverrideStore(join(directory, "overrides.json"));
  const manager = new AccessManager(settings, async () => new Map(), store);
  try {
    await manager.grantManualAccess(member, "Chosen Nickname", "123456789012345685");
    member.roles.cache.delete(settings.manualAccessRoleId);
    assert.equal(await manager.check(member), "not-linked");
    assert.equal(await store.getAccessOverride(member.id), undefined);
    assert.equal(member.roles.cache.has(settings.manualAccessRoleId), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("confirmed manual access works during dry-run and can be cleared without resuming paused sync", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-access-dry-run-"));
  const { member, actions } = fixture();
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, {
    fetchMe: async () => member.guild.members.me,
    fetch: async () => member
  });
  let apiCalls = 0;
  const store = new ManualOverrideStore(join(directory, "overrides.json"));
  const manager = new AccessManager({ ...settings, dryRun: true }, async () => {
    apiCalls += 1;
    return new Map([[member.id, person]]);
  }, store);
  try {
    await assert.rejects(manager.grantManualAccess(member, "Chosen Nickname", "123456789012345685"), /bekreft:true/);
    await manager.grantManualAccess(member, "Chosen Nickname", "123456789012345685", true);
    assert.equal(member.roles.cache.has(settings.manualAccessRoleId), true);
    assert.equal(member.roles.cache.has(settings.accessRoleId), false);
    assert.equal(apiCalls, 0);

    assert.equal(await manager.clearManualAccess(member, true, false), true);
    assert.equal(member.roles.cache.has(settings.manualAccessRoleId), false);
    assert.equal(member.roles.cache.has(settings.accessRoleId), false);
    assert.equal(apiCalls, 0);
    assert.ok(actions.includes("manual-role"));
    assert.ok(actions.includes("remove-manual-role"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed manual role removal preserves its persisted access override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-access-clear-failure-"));
  const { member } = fixture();
  const manualRole = member.guild.roles.cache.get(settings.manualAccessRoleId)!;
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me, fetch: async () => member });
  Object.assign(member.roles, {
    add: async (roleId: string) => { member.roles.cache.set(roleId, roleId === settings.manualAccessRoleId ? manualRole : {}); },
    remove: async () => { throw new Error("synthetic Discord permission failure"); }
  });
  const store = new ManualOverrideStore(join(directory, "overrides.json"));
  const manager = new AccessManager(settings, async () => new Map(), store);
  try {
    await manager.grantManualAccess(member, "Chosen Nickname", "123456789012345685");
    await assert.rejects(manager.clearManualAccess(member, true, false), /synthetic Discord permission failure/);
    assert.ok(await store.getAccessOverride(member.id));
    assert.equal(member.roles.cache.has(settings.manualAccessRoleId), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("linked nickname edits are immediately restored; dry run and unlinked members are untouched", async () => {
  const linked = fixture({ nickname: "Manual Nickname" });
  (linked.member.roles.cache as Collection<string, unknown>).set(settings.accessRoleId, {});
  Object.assign(linked.member.guild.roles, { fetch: async () => linked.member.guild.roles.cache });
  Object.assign(linked.member.guild.members, {
    fetchMe: async () => linked.member.guild.members.me,
    fetch: async () => linked.member
  });
  const manager = new AccessManager(settings, async () => new Map([[linked.member.id, person]]));
  await manager.handleNicknameUpdate({ guild: linked.member.guild, nickname: null }, linked.member);
  assert.deepEqual(linked.actions, ["nickname"]);

  const unlinked = fixture({ nickname: "Chosen Nickname" });
  let apiCalls = 0;
  const managerForUnlinked = new AccessManager(settings, async () => { apiCalls += 1; return new Map(); });
  await managerForUnlinked.handleNicknameUpdate({ guild: unlinked.member.guild, nickname: null }, unlinked.member);
  assert.equal(apiCalls, 0);
  assert.deepEqual(unlinked.actions, []);

  const dry = fixture({ nickname: "Chosen Nickname" });
  (dry.member.roles.cache as Collection<string, unknown>).set(settings.accessRoleId, {});
  const dryManager = new AccessManager({ ...settings, dryRun: true }, async () => new Map([[dry.member.id, person]]));
  await dryManager.handleNicknameUpdate({ guild: dry.member.guild, nickname: null }, dry.member);
  assert.deepEqual(dry.actions, []);
});

test("periodic sync fetches the complete guild member cache once, not every interval", async () => {
  const { member, actions } = fixture();
  let fullFetches = 0;
  let individualFetches = 0;
  const cache = new Collection([[member.id, member]]);
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, {
    cache,
    fetchMe: async () => member.guild.members.me,
    fetch: async (options?: { user?: string; force?: boolean }) => {
      if (options) { individualFetches += 1; return member; }
      fullFetches += 1;
      return cache;
    }
  });
  let apiCalls = 0;
  const manager = new AccessManager(settings, async () => { apiCalls += 1; return new Map([[member.id, person]]); });
  await manager.sync(member.guild);
  await manager.sync(member.guild);
  assert.equal(fullFetches, 1);
  assert.equal(individualFetches, 0);
  assert.equal(apiCalls, 2);
  assert.equal(actions.length, 3);
});

test("entry message uses Norwegian copy and updates the existing link URL", async () => {
  const { member } = fixture();
  const botId = "123456789012345682";
  const captures: Array<{ content: string; components: Array<{ toJSON(): { components: Array<{ label?: string; url?: string; custom_id?: string }> } }> }> = [];
  const channel = {
    type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory
    ]),
    messages: {
      fetch: async () => new Collection([[
        "entry",
        { author: { id: botId }, components: [{ components: [{ customId: "check-registration-access" }] }],
          edit: async (payload: typeof captures[number]) => { captures.push(payload); } }
      ]])
    },
    send: async (payload: typeof captures[number]) => { captures.push(payload); }
  };
  Object.assign(member.guild, { channels: { fetch: async () => channel } });
  Object.assign(member.guild.members.me!, { id: botId });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me });
  const manager = new AccessManager({ ...settings, websiteUrl: "https://new-login.example/discord" }, async () => new Map());
  await manager.publishEntry(member.guild);
  assert.equal(captures.length, 1);
  const entry = captures[0];
  assert.match(entry.content, /Discord-kontoen din være koblet til NTLAN-kontoen din på ntlan\.no/);
  assert.match(entry.content, /«Sjekk tilgang» her/);
  assert.match(entry.content, /initialer for resten av navnet/);
  assert.match(entry.content, /Velkommen til NTLAN/);
  assert.match(entry.content, /under 18.*foreldrene dine har fått innloggingen din på e-post/i);
  assert.doesNotMatch(entry.content, /spør foresatt/i);
  assert.doesNotMatch(entry.content, /familie/i);
  const buttons = entry.components.flatMap((row) => row.toJSON().components);
  assert.ok(buttons.some((button) => button.label === "Åpne nettsiden" && button.url === "https://new-login.example/discord"));
  assert.ok(buttons.some((button) => button.label === "Sjekk tilgang" && button.custom_id === "check-registration-access"));
});

test("message catalog allows access copy overrides and falls back for missing keys", () => {
  const messages = parseBotMessages({ access: {
    entry: "Custom welcome",
    button: { verified: "Custom success" }
  } });
  assert.equal(messages.access.entry, "Custom welcome");
  assert.equal(messages.access.button.verified, "Custom success");
  assert.match(messages.access.button["not-linked"], /Discord-koblingen/);
  assert.match(messages.access.button["dry-run-linked"], /koblingen din er funnet.*forhåndsvisning/i);
  assert.equal(messages.access.openWebsiteLabel, "Åpne nettsiden");
});

test("command and audit messages are editable from the message catalog with placeholder values", () => {
  const messages = parseBotMessages({
    commands: { "giveAccess.complete": "Gitt til <@{userId}> med {nickname}" },
    logs: { "access.nicknameSet": "Navn for {username}: {nickname}" }
  });
  assert.equal(getBotText("giveAccess.complete", { userId: "123", nickname: "Ada A." }, "commands", messages),
    "Gitt til <@123> med Ada A.");
  assert.equal(getBotText("access.nicknameSet", { username: "ada", nickname: "Ada A." }, "logs", messages),
    "Navn for ada: Ada A.");
  assert.ok(getBotText("botSettings.notLoaded", {}, "commands", messages).length > 0);
});

test("messages.json includes every built-in command and audit message and keeps the current welcome copy", async () => {
  const raw = JSON.parse(await readFile(join(process.cwd(), "messages.json"), "utf8")) as {
    commands?: Record<string, unknown>;
    logs?: Record<string, unknown>;
    access?: { entry?: string };
  };
  const parsed = parseBotMessages(raw);
  for (const key of Object.keys(parsed.commands)) assert.equal(typeof raw.commands?.[key], "string", `Missing messages.json commands.${key}`);
  for (const key of Object.keys(parsed.logs)) assert.equal(typeof raw.logs?.[key], "string", `Missing messages.json logs.${key}`);
  assert.equal(parsed.access.entry, raw.access?.entry);
});

test("CS notification templates validate placeholders and require configured values", () => {
  const messages = parseBotMessages({ cs: { notifications: {
    custom: { label: "Custom", template: "Starter om {minutes} minutter", required: ["minutes"] },
    invalid: { label: "Invalid", template: "Ping {everyone}", required: ["everyone"] }
  } } });
  assert.equal(renderCsNotification("custom", { minutes: "10" }, messages.cs.notifications), "Starter om 10 minutter");
  assert.throws(() => renderCsNotification("custom", {}, messages.cs.notifications), /Missing notification value/);
  assert.equal(messages.cs.notifications.invalid, undefined);
});

test("startup validation identifies exact missing roles, hierarchy and permissions", async () => {
  const scenarios: { mutate: (member: GuildMember) => void; expected: RegExp }[] = [
    { mutate: (member) => { member.guild.roles.cache.delete(settings.crewRoleId); }, expected: /CREW_ROLE_ID/ },
    { mutate: (member) => { member.guild.roles.cache.delete(settings.accessRoleId); }, expected: /ACCESS_ROLE_ID/ },
    { mutate: (member) => { Object.assign(member.guild.roles.cache.get(settings.accessRoleId)!, { position: 12 }); }, expected: /under Crew/ },
    { mutate: (member) => { Object.assign(member.guild.members.me!.roles.highest, { position: 1 }); }, expected: /botrollen over/ },
    { mutate: (member) => { member.guild.members.me!.permissions.remove(PermissionFlagsBits.ManageNicknames); }, expected: /Manage Nicknames/ },
    { mutate: (member) => { member.guild.members.me!.permissions.remove(PermissionFlagsBits.ManageRoles); }, expected: /Manage Roles/ }
  ];
  const manager = new AccessManager(settings, async () => new Map());
  for (const scenario of scenarios) {
    const { member } = fixture();
    Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
    Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me });
    scenario.mutate(member);
    await assert.rejects(manager.validateGuild(member.guild), scenario.expected);
  }
});

test("startup diagnostics expose only trusted messages and known Discord error codes", () => {
  assert.equal(describeAccessStartupError(new AccessConfigurationError("Known configuration issue")), "Known configuration issue");
  assert.match(describeAccessStartupError({ code: 50013, token: "synthetic-private-value" }), /Missing Permissions/);
  assert.equal(describeAccessStartupError(new Error("synthetic-private-value")).includes("synthetic-private-value"), false);
});

test("basic member permissions pass both startup and role assignment without changing permissions", async () => {
  const { member, actions } = fixture();
  const role = member.guild.roles.cache.get(settings.accessRoleId)!;
  const permissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.Connect | PermissionFlagsBits.ChangeNickname;
  role.permissions.add(permissions);
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me });
  const manager = new AccessManager(settings, async () => new Map());
  await manager.validateGuild(member.guild);
  assert.equal(await reconcileMember(member, person, settings), "verified");
  assert.deepEqual(actions, ["nickname", "role"]);
  assert.equal(role.permissions.bitfield, permissions);
});

test("administrative permissions warn once without blocking or modifying the role", async () => {
  const manager = new AccessManager(settings, async () => new Map());
  const { member, actions } = fixture();
  const role = member.guild.roles.cache.get(settings.accessRoleId)!;
  role.permissions.add([PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageRoles]);
  const original = role.permissions.bitfield;
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me });
  const warnings = mock.method(console, "warn", () => undefined);
  try {
    await manager.validateGuild(member.guild);
    await manager.validateGuild(member.guild);
    assert.equal(warnings.mock.callCount(), 1);
    assert.match(warnings.mock.calls[0].arguments[0], /Administrator.*ManageRoles/);
    assert.equal(await reconcileMember(member, person, settings), "verified");
    assert.deepEqual(actions, ["nickname", "role"]);
    assert.equal(role.permissions.bitfield, original);
  } finally { warnings.mock.restore(); }
});

test("missing roles or bot permissions pause access startup but preserve safe voice eligibility", async () => {
  for (const missingRole of [true, false]) {
    const { member, actions } = fixture();
    Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
    Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me });
    if (missingRole) member.guild.roles.cache.delete(settings.accessRoleId);
    else member.guild.members.me!.permissions.remove(PermissionFlagsBits.ManageRoles);
    let apiCalls = 0;
    const manager = new AccessManager(settings, async () => { apiCalls += 1; return new Map(); });
    const client = { guilds: { fetch: async () => member.guild } } as unknown as Client;
    const errors = mock.method(console, "error", () => undefined);
    try {
      assert.equal(await startAccessSync(manager, client), false);
      assert.match(errors.mock.calls[0].arguments[0], /Access sync paused/);
      assert.equal(manager.canUseVoice(member), false);
      assert.equal(manager.canUseVoice(fixture({ crew: true }).member), true);
      assert.equal(apiCalls, 0);
      assert.deepEqual(actions, []);
    } finally { errors.mock.restore(); manager.stop(); }
  }
});

test("failed rename, absent record and unmanageable member never grant access", async () => {
  const failed = fixture({ failRename: true });
  await assert.rejects(reconcileMember(failed.member, person, settings));
  assert.deepEqual(failed.actions, ["nickname"]);
  const missing = fixture();
  assert.equal(await reconcileMember(missing.member, undefined, settings), "not-linked");
  assert.deepEqual(missing.actions, []);
  const blocked = fixture({ manageable: false });
  assert.equal(await reconcileMember(blocked.member, person, settings), "cannot-rename");
  assert.deepEqual(blocked.actions, []);
});

test("crew exemption preserves access independently of nickname and website", async () => {
  const crew = fixture({ crew: true, manageable: false });
  assert.equal(await reconcileMember(crew.member, undefined, settings), "exempt");
  assert.equal(await reconcileMember(crew.member, person, settings), "exempt");
  assert.deepEqual(crew.actions, []);
  const editable = fixture({ crew: true });
  assert.equal(await reconcileMember(editable.member, person, settings), "exempt");
  assert.deepEqual(editable.actions, ["nickname"]);
  assert.equal(isCrewMember(fixture({ higher: true }).member, settings.crewRoleId), true);
  assert.equal(isCrewMember(fixture().member, settings.crewRoleId), false);
});

test("dry run and already synchronized members avoid mutations", async () => {
  const dry = fixture();
  assert.equal(await reconcileMember(dry.member, person, { ...settings, dryRun: true }), "dry-run");
  assert.deepEqual(dry.actions, []);
  const existing = fixture({ nickname: "Test P." });
  (existing.member.roles.cache as Collection<string, unknown>).set(settings.accessRoleId, {});
  assert.equal(await reconcileMember(existing.member, person, settings), "verified");
  assert.deepEqual(existing.actions, []);
});

test("missing identity removes ordinary access once, keeps nickname, and respects dry run", async () => {
  const manager = new AccessManager(settings, async () => new Map());
  const missing = fixture({ nickname: person.name });
  (missing.member.roles.cache as Collection<string, unknown>).set(settings.accessRoleId, {});
  assert.equal(await reconcileMember(missing.member, undefined, settings), "revoked");
  assert.deepEqual(missing.actions, ["remove-role"]);
  assert.equal(missing.member.nickname, person.name);
  assert.equal(manager.canUseVoice(missing.member), false);
  assert.equal(await reconcileMember(missing.member, undefined, settings), "not-linked");
  assert.deepEqual(missing.actions, ["remove-role"]);

  const dry = fixture();
  (dry.member.roles.cache as Collection<string, unknown>).set(settings.accessRoleId, {});
  assert.equal(await reconcileMember(dry.member, undefined, { ...settings, dryRun: true }), "dry-run");
  assert.equal(dry.member.roles.cache.has(settings.accessRoleId), true);
  assert.deepEqual(dry.actions, []);
});

test("crew, higher roles, administrators and owner retain access when the identity disappears", async () => {
  for (const options of [{ crew: true }, { higher: true }, { administrator: true }, { owner: true }]) {
    const exempt = fixture(options);
    if ("administrator" in options) exempt.member.permissions.add(PermissionFlagsBits.Administrator);
    if ("owner" in options) Object.assign(exempt.member.guild, { ownerId: exempt.member.id });
    (exempt.member.roles.cache as Collection<string, unknown>).set(settings.accessRoleId, {});
    assert.equal(await reconcileMember(exempt.member, undefined, settings), "exempt");
    assert.equal(exempt.member.roles.cache.has(settings.accessRoleId), true);
    assert.deepEqual(exempt.actions, []);
  }
});

test("API failure preserves an existing access role while a successful missing record revokes it", async () => {
  const { member, actions } = fixture();
  (member.roles.cache as Collection<string, unknown>).set(settings.accessRoleId, {});
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me, fetch: async () => member });
  const failed = new AccessManager(settings, async () => { throw new Error("Synthetic API outage"); });
  await assert.rejects(failed.check(member));
  assert.equal(member.roles.cache.has(settings.accessRoleId), true);
  assert.deepEqual(actions, []);

  const successful = new AccessManager(settings, async () => new Map());
  assert.equal(await successful.check(member), "revoked");
  assert.equal(member.roles.cache.has(settings.accessRoleId), false);
  assert.deepEqual(actions, ["remove-role"]);
});

test("missing role management permissions cannot trigger access removal", async () => {
  const { member, actions } = fixture();
  (member.roles.cache as Collection<string, unknown>).set(settings.accessRoleId, {});
  member.guild.members.me!.permissions.remove(PermissionFlagsBits.ManageRoles);
  await assert.rejects(reconcileMember(member, undefined, settings), /Access role/);
  assert.equal(member.roles.cache.has(settings.accessRoleId), true);
  assert.deepEqual(actions, []);
});

test("crew retain access without a website link or when nickname update fails", async () => {
  const manager = new AccessManager(settings, async () => new Map());
  const unlinked = fixture({ crew: true });
  assert.equal(await reconcileMember(unlinked.member, undefined, settings), "exempt");
  assert.equal(manager.canUseVoice(unlinked.member), true);
  assert.deepEqual(unlinked.actions, []);

  const failed = fixture({ crew: true, failRename: true });
  assert.equal(await reconcileMember(failed.member, person, settings), "exempt");
  assert.equal(manager.canUseVoice(failed.member), true);
  assert.deepEqual(failed.actions, ["nickname"]);
  assert.equal(failed.member.roles.cache.has(settings.accessRoleId), false);
});

test("unmanageable access roles and invalid names cannot grant access", async () => {
  const unsafe = fixture();
  Object.assign(unsafe.member.guild.roles.cache.get(settings.accessRoleId)!, { managed: true });
  await assert.rejects(reconcileMember(unsafe.member, person, settings), /Access role/);
  assert.deepEqual(unsafe.actions, []);
  const invalid = fixture();
  assert.equal(await reconcileMember(invalid.member, { name: "", firstName: "" }, settings), "manual-name");
  assert.deepEqual(invalid.actions, []);
});

test("voice access uses role or crew exemption only, and checks guild scope", () => {
  const manager = new AccessManager(settings, async () => new Map());
  assert.equal(manager.canUseVoice(fixture().member), false);
  assert.equal(manager.canUseVoice(fixture({ crew: true }).member), true);
  const verified = fixture();
  (verified.member.roles.cache as Collection<string, unknown>).set(settings.accessRoleId, {});
  assert.equal(manager.canUseVoice(verified.member), true);
  const manual = fixture();
  (manual.member.roles.cache as Collection<string, unknown>).set(settings.manualAccessRoleId, {});
  assert.equal(manager.canUseVoice(manual.member), true);
  const outside = fixture();
  Object.assign(outside.member.guild, { id: "123456789012345686" });
  assert.equal(manager.canUseVoice(outside.member), false);
  const dryRun = new AccessManager({ ...settings, dryRun: true }, async () => new Map());
  assert.equal(dryRun.canUseVoice(fixture().member), false);
});

test("concurrent checks share processing and API failure causes no mutations", async () => {
  const { member, actions } = fixture();
  Object.assign(member.guild.members, { fetch: async () => member });
  Object.assign(member.guild.roles, { fetch: async () => member.guild.roles.cache });
  Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me });
  let calls = 0;
  const manager = new AccessManager(settings, async () => { calls += 1; return new Map([[member.id, person]]); });
  await Promise.all([manager.check(member), manager.check(member)]);
  assert.equal(calls, 1);
  assert.deepEqual(actions, ["nickname", "role"]);
  actions.length = 0;
  const failed = new AccessManager(settings, async () => { throw new Error("Synthetic API outage"); });
  await assert.rejects(failed.check(member));
  assert.deepEqual(actions, []);
});

test("manually protected voice category needs no configured category ID list", () => {
  const manager = new AccessManager(settings, async () => new Map());
  const overwrites = new Collection([
    [settings.guildId, { allow: new PermissionsBitField(), deny: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]) }],
    [settings.accessRoleId, { allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]), deny: new PermissionsBitField() }],
    [settings.manualAccessRoleId, { allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]), deny: new PermissionsBitField() }]
  ]);
  const category = { guild: { id: settings.guildId }, permissionOverwrites: { cache: overwrites } } as unknown as CategoryChannel;
  assert.equal(manager.isVoiceCategoryProtected(category), true);
  assert.equal(manager.isVoiceCategoryProtected(null), false);
  overwrites.get(settings.guildId)!.deny.remove(PermissionFlagsBits.ViewChannel);
  assert.equal(manager.isVoiceCategoryProtected(category), false);
  overwrites.get(settings.guildId)!.deny.add(PermissionFlagsBits.ViewChannel);
  overwrites.get(settings.accessRoleId)!.allow.remove(PermissionFlagsBits.ViewChannel);
  assert.equal(manager.isVoiceCategoryProtected(category), false);
  overwrites.get(settings.accessRoleId)!.allow.add(PermissionFlagsBits.ViewChannel);
  overwrites.get(settings.manualAccessRoleId)!.allow.remove(PermissionFlagsBits.ViewChannel);
  assert.equal(manager.isVoiceCategoryProtected(category), false);
  overwrites.get(settings.manualAccessRoleId)!.allow.add(PermissionFlagsBits.ViewChannel);
  overwrites.get(settings.accessRoleId)!.allow.remove(PermissionFlagsBits.Connect);
  assert.equal(manager.isVoiceCategoryProtected(category), false);
  overwrites.get(settings.accessRoleId)!.allow.add(PermissionFlagsBits.Connect);
  overwrites.get(settings.manualAccessRoleId)!.allow.remove(PermissionFlagsBits.Connect);
  assert.equal(manager.isVoiceCategoryProtected(category), false);
  overwrites.get(settings.manualAccessRoleId)!.allow.add(PermissionFlagsBits.Connect);
  Object.assign(category.guild, { id: "123456789012345686" });
  assert.equal(manager.isVoiceCategoryProtected(category), false);
});
