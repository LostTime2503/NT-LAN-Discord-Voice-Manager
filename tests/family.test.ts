import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FAMILY_CHILD_BUTTON_ID, FAMILY_PARENT_BUTTON_ID } from "../src/accessManager.js";
import { FamilyAccessFlow } from "../src/familyAccess.js";
import { FamilyStore } from "../src/familyStore.js";
import { parseParticipants } from "../src/registrationClient.js";

const parentId = "123456789012345678";
const otherParentId = "123456789012345679";
const childId = "123456789012345680";
const parent = { name: "Parent Person", firstName: "Parent", children: [
  { name: "Child Person", firstName: "Child" }, { name: "Other Child", firstName: "Other" }
] };

async function withStore(run: (store: FamilyStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ntlan-family-test-"));
  try { await run(new FamilyStore(join(directory, "family.json")), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("family link persists across store instances and rejects name collisions", async () => {
  await withStore(async (store, directory) => {
    const link = await store.createLink(parentId, "  Child   Person ", childId);
    assert.equal(link.childName, "Child   Person");
    const reopened = new FamilyStore(join(directory, "family.json"));
    assert.deepEqual(await reopened.getLinksForParent(parentId), [link]);
    await assert.rejects(reopened.createLink(parentId, "child person", "123456789012345681"), /allerede koblet/);
    await assert.rejects(reopened.createLink(otherParentId, "Child Person", childId), /allerede koblet/);
  });
});

test("child request belongs to one parent, expires, and can be rejected only by that parent", async () => {
  await withStore(async (store) => {
    const request = await store.createRequest(parentId, childId);
    assert.deepEqual(await store.createRequest(parentId, childId), request);
    assert.equal((await store.getRequestsForParent(parentId))[0].id, request.id);
    assert.equal(await store.rejectRequest(otherParentId, request.id), false);
    assert.equal(await store.rejectRequest(parentId, request.id), true);
    assert.equal((await store.getRequestsForParent(parentId)).length, 0);
  });
});

test("approving one guardian link clears competing open requests for that account", async () => {
  await withStore(async (store) => {
    await store.createRequest(parentId, childId);
    await store.createRequest(otherParentId, childId);
    await store.createLink(parentId, "Child Person", childId);
    assert.equal((await store.getRequestsForParent(parentId)).length, 0);
    assert.equal((await store.getRequestsForParent(otherParentId)).length, 0);
  });
});

test("prejoin username invite becomes a guardian-reviewed claim after exact match", async () => {
  await withStore(async (store) => {
    const invite = await store.createInvite(parentId, "Child Person", "Child.User_1");
    assert.deepEqual(await store.findInviteByUsername("child.user_1"), invite);
    const claim = await store.addClaim(invite, childId);
    assert.equal((await store.getClaimsForParent(parentId))[0].id, claim.id);
    assert.equal((await store.getInvites()).length, 0);
    assert.equal(await store.rejectClaimByParent(otherParentId, claim.id), false);
    assert.equal(await store.rejectClaimByParent(parentId, claim.id), true);
    assert.equal((await store.getClaimsForParent(parentId)).length, 0);
  });
});

  test("family dry run does not persist invitations, requests, or links", async () => {
    await withStore(async (store) => {
      const access = { settings: { guildId: parentId, familyChannelId: "123456789012345682", dryRun: true }, async check() { throw new Error("Must not check access"); } } as never;
      const client = { users: { fetch: async () => ({ send: async () => { throw new Error("Must not DM"); } }) } } as never;
      const flow = new FamilyAccessFlow(access, store, async () => new Map([[parentId, parent]]), client);
      const fields = new Map([["family:invite-username", "child.user_1"]]);
      await assert.rejects(flow.handleModal({ customId: "family:invite-modal:test-token", user: { id: parentId },
        fields: { getTextInputValue: (key: string) => fields.get(key)! }, async deferReply() {}, async editReply() {} } as never), /ACCESS_DRY_RUN/);
      await assert.rejects(flow.handleUserSelect({ customId: "family:child-parent", user: { id: childId }, values: [parentId],
        async deferReply() {}, async editReply() {} } as never), /ACCESS_DRY_RUN/);
      assert.equal((await store.getInvites()).length, 0);
      assert.equal((await store.getRequestsForParent(parentId)).length, 0);
      assert.equal((await store.getLinks()).length, 0);
    });
  });

  test("expired family requests and invites are pruned when read", async () => {
    await withStore(async (store, directory) => {
      await store.createRequest(parentId, childId);
      await store.createInvite(parentId, "Child Person", "child.user_1");
      const path = join(directory, "family.json");
      const saved = JSON.parse(await readFile(path, "utf8")) as { requests: Array<{ expiresAt: number }>; invites: Array<{ expiresAt: number }> };
      saved.requests[0].expiresAt = Date.now() - 1;
      saved.invites[0].expiresAt = Date.now() - 1;
      await writeFile(path, JSON.stringify(saved));
      const reopened = new FamilyStore(path);
      assert.equal((await reopened.getRequestsForParent(parentId)).length, 0);
      assert.equal((await reopened.getInvitesForParent(parentId)).length, 0);
    });
  });

test("one username cannot be reserved by multiple guardians", async () => {
  await withStore(async (store) => {
    await store.createInvite(parentId, "Child Person", "child.username");
    await assert.rejects(store.createInvite(otherParentId, "Other Child", "CHILD.USERNAME"), /ventende familiekobling/);
  });
});

test("saved child mapping attaches to the verified parent and parser preserves nested children", () => {
  const parent = "123456789012345678";
  const participants = parseParticipants({ data: { participants: { [parent]: {
    name: "Parent", firstName: "Parent", children: [{ name: "Child Person", firstName: "Child", days: ["saturday"], meals: [] }]
  } } } });
  assert.deepEqual(participants.get(parent)?.children, [{ name: "Child Person", firstName: "Child" }]);
});

test("family data file is written with restrictive permissions and a versioned schema", async () => {
  await withStore(async (store, directory) => {
    await store.createLink(parentId, "Child Person", childId);
    const saved = JSON.parse(await readFile(join(directory, "family.json"), "utf8")) as { version: number; links: unknown[] };
    assert.equal(saved.version, 1);
    assert.equal(saved.links.length, 1);
  });
});

test("verified parent links an existing member through child and Discord user selectors", async () => {
  await withStore(async (store) => {
    const calls: string[] = [];
    const access = {
      settings: { guildId: parentId, familyChannelId: "123456789012345682" },
      async check(member: { id: string }) { calls.push(member.id); return "verified"; }
    } as never;
    const target = { id: childId, user: { bot: false, username: "childuser" } };
    const guild = { members: { fetch: async (id: string) => { assert.equal(id, childId); return target; } } };
    const client = { guilds: { fetch: async (id: string) => { assert.equal(id, parentId); return guild; } } } as never;
    let apiCalls = 0;
    const flow = new FamilyAccessFlow(access, store, async () => {
      apiCalls += 1;
      const children = apiCalls === 2 ? [...parent.children].reverse() : parent.children;
      return new Map([[parentId, { ...parent, children }]]);
    }, client);
    const replies: { content?: string; components?: Array<{ components: Array<{ customId?: string }> }> }[] = [];
    await flow.handleButton({
      customId: FAMILY_PARENT_BUTTON_ID, user: { id: parentId }, guildId: parentId,
      channelId: "123456789012345682",
      async reply(payload: typeof replies[number]) { replies.push(payload); }
    } as never);
    assert.match(replies[0].content ?? "", /Velg en handling/);
    await flow.handleButton({ customId: "family:link-parent", user: { id: parentId },
      async deferReply() {}, async editReply(payload: typeof replies[number]) { replies.push(payload); } } as never);
    await flow.handleStringSelect({ customId: "family:parent-child", user: { id: parentId }, values: ["Child Person"],
      async deferUpdate() {}, async editReply(payload: typeof replies[number]) { replies.push(payload); } } as never);
    await flow.handleUserSelect({ customId: "family:existing-member", user: { id: parentId }, values: [childId],
      guild: { members: { fetch: async () => target } },
      async deferUpdate() {}, async editReply(payload: typeof replies[number]) { replies.push(payload); } } as never);
    assert.match(replies.at(-1)?.content ?? "", /childuser.*Child Person/);
    const confirmButton = replies.at(-1)!.components![0].components[0] as { customId?: string; data?: { custom_id?: string } };
    const confirmId = confirmButton.customId ?? confirmButton.data?.custom_id;
    assert.ok(confirmId);
    await flow.handleButton({ customId: confirmId, user: { id: parentId }, deferred: false, replied: false,
      async deferUpdate() {}, async editReply(payload: typeof replies[number]) { replies.push(payload); } } as never);
    assert.match(replies.at(-1)?.content ?? "", /tilgang er gitt/);
    assert.deepEqual(calls, [childId]);
    assert.equal((await store.getLinksForParent(parentId))[0].childDiscordId, childId);
  });
});

test("child asks a verified parent and access remains untouched before approval", async () => {
  await withStore(async (store) => {
    const sent: unknown[] = [];
    const access = { settings: { guildId: parentId, familyChannelId: "123456789012345682" }, async check() { throw new Error("No grant before approval"); } } as never;
    const client = { users: { fetch: async (id: string) => ({ id, send: async (payload: unknown) => { sent.push(payload); } }) } } as never;
    const flow = new FamilyAccessFlow(access, store, async () => new Map([[parentId, parent]]), client);
    let reply: { content: string } | undefined;
    await flow.handleUserSelect({ customId: "family:child-parent", user: { id: childId }, values: [parentId],
      async deferReply() {}, async editReply(payload: { content: string }) { reply = payload; } } as never);
    assert.match(reply?.content ?? "", /sendt privat/);
    assert.equal(sent.length, 1);
    assert.equal((await store.getRequestsForParent(parentId)).length, 1);
    assert.equal((await store.getLinks()).length, 0);
  });
});

test("parent approves a child-started request only after selecting their API child", async () => {
  await withStore(async (store) => {
    const accessCalls: string[] = [];
    const access = { settings: { guildId: parentId, familyChannelId: "123456789012345682" },
      async check(member: { id: string }) { accessCalls.push(member.id); return "verified"; } } as never;
    const target = { id: childId, user: { bot: false, username: "childuser" } };
    const guild = { members: { fetch: async () => target } };
    const client = { users: { fetch: async (id: string) => ({ id, send: async () => {} }) }, guilds: { fetch: async () => guild } } as never;
    const flow = new FamilyAccessFlow(access, store, async () => new Map([[parentId, parent]]), client);
    await flow.handleUserSelect({ customId: "family:child-parent", user: { id: childId }, values: [parentId],
      async deferReply() {}, async editReply() {} } as never);
    const request = (await store.getRequestsForParent(parentId))[0];
    assert.ok(request);
    let prompt = "";
    await flow.handleButton({ customId: `family:approve-request:${request.id}`, user: { id: parentId },
      async deferReply() {}, async editReply(payload: { content: string }) { prompt = payload.content; } } as never);
    assert.match(prompt, /Velg hvilket/);
    assert.equal((await store.getLinks()).length, 0);
    let result = "";
    await flow.handleStringSelect({ customId: `family:request-child:${request.id}`, user: { id: parentId }, values: ["Child Person"],
      async deferUpdate() {}, async editReply(payload: { content: string }) { result = payload.content; } } as never);
    assert.match(result, /tilgang er gitt/);
    assert.deepEqual(accessCalls, [childId]);
    assert.equal((await store.getLinksForParent(parentId))[0].childDiscordId, childId);
    assert.equal((await store.getRequestsForParent(parentId)).length, 0);
  });
});

test("parent invite modal accepts only a unique child name from their API account", async () => {
  await withStore(async (store) => {
    const access = { settings: { guildId: parentId } } as never;
    const flow = new FamilyAccessFlow(access, store, async () => new Map([[parentId, parent]]), {} as never);
    let pickerPayload: any;
    await flow.handleButton({ customId: "family:invite-parent", user: { id: parentId },
      async deferReply() {}, async editReply(payload: typeof pickerPayload) { pickerPayload = payload; } } as never);
    assert.match(pickerPayload?.content ?? "", /Velg barnet/);
    const pickerOptions = pickerPayload!.components![0].components[0].options;
    assert.deepEqual(pickerOptions.map((option: { data: { value: string } }) => option.data.value), ["Child Person", "Other Child"]);
    let modal: any;
    await flow.handleStringSelect({ customId: "family:invite-child", user: { id: parentId }, values: ["Child Person"],
      async showModal(value: typeof modal) { modal = value; } } as never);
    const modalJson = modal!.toJSON();
    assert.equal(modalJson.components.length, 1);
    assert.equal(modalJson.components[0].components[0].custom_id, "family:invite-username");
    const fields = new Map([["family:invite-username", "child.user_1"]]);
    let message = "";
    await flow.handleModal({ customId: modal!.data!.custom_id!, user: { id: parentId },
      fields: { getTextInputValue: (key: string) => fields.get(key)! },
      async deferReply() {}, async editReply(payload: { content: string }) { message = payload.content; } } as never);
    assert.match(message, /utloeper om 7 dager/);
    assert.equal((await store.getInvitesForParent(parentId)).length, 1);
    const duplicateParent = { ...parent, children: [parent.children[0], { ...parent.children[0] }] };
    await withStore(async (duplicateStore) => {
      const duplicateFlow = new FamilyAccessFlow(access, duplicateStore, async () => new Map([[parentId, duplicateParent]]), {} as never);
      await assert.rejects(duplicateFlow.handleButton({ customId: "family:invite-parent", user: { id: parentId },
        async deferReply() {}, async editReply() {} } as never), /Ingen barn har et unikt navn/);
    });
  });
});

test("prejoin invite is exact-match, parent confirms after join, then access sync runs", async () => {
  await withStore(async (store) => {
    const sent: unknown[] = [];
    const access = {
      settings: { guildId: parentId, familyChannelId: "123456789012345682" },
      async check(member: { id: string }) { assert.equal(member.id, childId); return "verified"; }
    } as never;
    const target = { id: childId, user: { bot: false, username: "child.user_1" } };
    const guild = { members: { fetch: async () => target } };
    const client = {
      users: { fetch: async (id: string) => ({ id, send: async (payload: unknown) => { sent.push(payload); } }) },
      guilds: { fetch: async () => guild }
    } as never;
    const flow = new FamilyAccessFlow(access, store, async () => new Map([[parentId, parent]]), client);
    await store.createInvite(parentId, "Child Person", "child.user_1");
    await flow.handleJoin({ guild: { id: parentId }, id: childId, user: target.user } as never);
    assert.equal(sent.length, 1);
    const claim = (await store.getClaimsForParent(parentId))[0];
    assert.ok(claim);
    let reply = "";
    await flow.handleButton({ customId: `family:approve-claim:${claim.id}`, user: { id: parentId }, deferred: false, replied: false,
      async deferUpdate() {}, async editReply(payload: { content: string }) { reply = payload.content; } } as never);
    assert.match(reply, /tilgang er gitt/);
    assert.equal((await store.getLinksForParent(parentId))[0].childDiscordId, childId);
    assert.equal((await store.getClaimsForParent(parentId)).length, 0);
  });
});

test("one API child cannot have multiple outstanding prejoin usernames", async () => {
  await withStore(async (store) => {
    await store.createInvite(parentId, "Child Person", "child.username");
    await assert.rejects(store.createInvite(parentId, " child person ", "another.username"), /ventende invitasjon/);
  });
});