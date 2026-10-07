import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type CategoryChannel, type Client, type GuildMember } from "discord.js";
import { AccessConfigurationError, AccessManager, FAMILY_PARENT_BUTTON_ID, describeAccessStartupError, isCrewMember, reconcileMember, startAccessSync, type AccessSettings } from "../src/accessManager.js";

const settings: AccessSettings = {
  guildId: "123456789012345678", accessRoleId: "123456789012345679", crewRoleId: "123456789012345680",
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
  const bot = role("123456789012345682", 8);
  const memberRole = options.crew ? crew : role("123456789012345683", options.higher ? 11 : 1);
  const memberRoles = new Collection([[memberRole.id, memberRole]]);
  const member = {
    id: "123456789012345684", user: { bot: false }, nickname: options.nickname ?? null,
    manageable: options.manageable ?? true, permissions: new PermissionsBitField(),
    roles: { cache: memberRoles, highest: memberRole, async add() { actions.push("role"); },
      async remove(roleId: string) { actions.push("remove-role"); memberRoles.delete(roleId); } },
    async setNickname() { actions.push("nickname"); if (options.failRename) throw new Error("Synthetic failure"); },
    guild: {
      id: settings.guildId, ownerId: "123456789012345685",
      roles: { cache: new Collection([[crew.id, crew], [access.id, access]]) },
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

test("entry message optionally points children to the family channel", async () => {
  const familyChannelId = "123456789012345687";
  for (const configured of [false, true]) {
    const { member } = fixture();
    let content = "";
    const channel = {
      type: ChannelType.GuildText,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory
      ]),
      messages: { fetch: async () => new Collection() },
      send: async (payload: { content: string }) => { content = payload.content; }
    };
    Object.assign(member.guild, { channels: { fetch: async () => channel } });
    Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me });
    const manager = new AccessManager({ ...settings, familyChannelId: configured ? familyChannelId : undefined }, async () => new Map());
    await manager.publishEntry(member.guild);
    assert.equal(content.includes(`<#${familyChannelId}>`), configured);
    assert.equal(content.includes("tilgang via foresatt"), configured);
    assert.match(content, /Logg inn med Discord/);
  }
  assert.throws(() => new AccessManager({ ...settings, familyChannelId: "invalid" }, async () => new Map()), /FAMILY_ACCESS_CHANNEL_ID/);
});

test("family entry has two buttons, updates existing messages, and respects dry run", async () => {
  const familyChannelId = "123456789012345687";
  const botId = "123456789012345682";
  for (const mode of ["new", "existing", "dry"] as const) {
    const { member, actions } = fixture();
    let sends = 0;
    let edits = 0;
    let serialized = "";
    const existing = {
      author: { id: botId },
      components: [{ components: [{ customId: FAMILY_PARENT_BUTTON_ID }] }],
      edit: async (payload: { content: string; components: unknown[] }) => { edits += 1; serialized = JSON.stringify(payload); }
    };
    const channel = {
      type: ChannelType.GuildText,
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory
      ]),
      messages: { fetch: async () => new Collection(mode === "existing" ? [["message", existing]] : []) },
      send: async (payload: { content: string; components: unknown[] }) => { sends += 1; serialized = JSON.stringify(payload); }
    };
    Object.assign(member.guild, { channels: { fetch: async () => channel } });
    Object.assign(member.guild.members.me!, { id: botId });
    Object.assign(member.guild.members, { fetchMe: async () => member.guild.members.me });
    const manager = new AccessManager({ ...settings, familyChannelId, dryRun: mode === "dry" }, async () => new Map());
    await manager.publishFamilyEntry(member.guild);
    assert.equal(sends, mode === "new" ? 1 : 0);
    assert.equal(edits, mode === "existing" ? 1 : 0);
    assert.deepEqual(actions, []);
    if (mode !== "dry") {
      assert.match(serialized, /Jeg er foresatt/);
      assert.match(serialized, /Jeg trenger tilgang via foresatt/);
      assert.match(serialized, /Discords alderskrav/);
      assert.match(serialized, /foresatt har bekreftet/);
    }
  }
  const manager = new AccessManager(settings, async () => new Map());
  await assert.rejects(manager.publishFamilyEntry(fixture().member.guild), /FAMILY_ACCESS_CHANNEL_ID/);
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
  const existing = fixture({ nickname: person.name });
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

test("family links authorize a unique API child, but not renamed, duplicate, or orphaned children", async () => {
  const parentId = "123456789012345690";
  const childId = "123456789012345691";
  const childMember = fixture();
  Object.assign(childMember.member, { id: childId });
  const participants = new Map([[parentId, { name: "Parent Person", firstName: "Parent", children: [{ name: "Child Person", firstName: "Child" }] }]]);
  let links = [{ parentDiscordId: parentId, childName: "Child Person", childDiscordId: childId, linkedAt: Date.now() }];
  const manager = new AccessManager(settings, async () => participants, async () => links);
  assert.equal((await manager.getAuthorizedPeople()).get(childId)?.name, "Child Person");
  links = [{ ...links[0], childName: "Old Child Name" }];
  assert.equal((await manager.getAuthorizedPeople()).has(childId), false);
  links = [{ ...links[0], childName: "Child Person" }];
  participants.set(parentId, { ...participants.get(parentId)!, children: [
    { name: "Child Person", firstName: "Child" }, { name: " child   person ", firstName: "Child" }
  ] });
  assert.equal((await manager.getAuthorizedPeople()).has(childId), false);
  participants.delete(parentId);
  assert.equal((await manager.getAuthorizedPeople()).has(childId), false);
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
  const outside = fixture();
  Object.assign(outside.member.guild, { id: "123456789012345686" });
  assert.equal(manager.canUseVoice(outside.member), false);
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
    [settings.guildId, { allow: new PermissionsBitField(), deny: new PermissionsBitField(PermissionFlagsBits.ViewChannel) }],
    [settings.accessRoleId, { allow: new PermissionsBitField(PermissionFlagsBits.ViewChannel), deny: new PermissionsBitField() }]
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
  Object.assign(category.guild, { id: "123456789012345686" });
  assert.equal(manager.isVoiceCategoryProtected(category), false);
});
