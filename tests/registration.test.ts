import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createNickname, parseCsParticipants, parseParticipants, RegistrationClient } from "../src/registrationClient.js";

const discordId = "123456789012345678";
const payload = { data: { participants: { [discordId]: { name: "Test Person", firstName: "Test", crew: true } } } };
const options = { apiUrl: "https://example.test/api", tokenUrl: "https://example.test/token", clientId: "test", clientSecret: "test" };

test("participants are keyed by string Discord IDs and unrelated fields are discarded", () => {
  assert.deepEqual(parseParticipants(payload).get(discordId), { name: "Test Person", firstName: "Test" });
  assert.throws(() => parseParticipants({ data: { participants: [] } }));
  assert.throws(() => parseParticipants({ data: { participants: { invalid: {} } } }));
});

test("nicknames keep the first name and initial every remaining name part", () => {
  assert.equal(createNickname({ name: " Leah  Olafsen Opsahlseter ", firstName: "Leah" }), "Leah O. O.");
  assert.equal(createNickname({ name: "Test Verylongmiddle Anotherlongmiddle Person", firstName: "Test" }), "Test V. A. P.");
  assert.equal(createNickname({ name: "Anne Marie Wold Hansen", firstName: "Anne Marie" }), "Anne Marie W. H.");
  assert.equal(createNickname({ name: "Silje Marie Kornerud", firstName: "Silje" }), "Silje M. K.");
  assert.equal(createNickname({ name: "Åse Ødegård", firstName: "Åse" }), "Åse Ø.");
  assert.equal(createNickname({ name: "Leah", firstName: "Leah" }), "Leah");
});

test("invalid or overlong abbreviated names are rejected", () => {
  assert.equal(createNickname({ name: "", firstName: "" }), null);
  assert.equal(createNickname({ name: "Test\u0000 Person", firstName: "Test" }), null);
  assert.equal(createNickname({ name: "Other Person", firstName: "Test" }), null);
  assert.equal(createNickname({ name: "Test Person", firstName: "" }), null);
  assert.equal(createNickname({ name: "x".repeat(33) + " Person", firstName: "x".repeat(33) }), null);
});

test("concurrent requests share a fetch, refresh after 401, and cache success", async () => {
  let tokenCalls = 0;
  let apiCalls = 0;
  const request: typeof fetch = async (url) => {
    if (url === options.tokenUrl) {
      tokenCalls += 1;
      return Response.json({ access_token: "synthetic", expires_in: 300 });
    }
    apiCalls += 1;
    return apiCalls === 1 ? new Response(null, { status: 401 }) : Response.json(payload);
  };
  const client = new RegistrationClient(options, request);
  const results = await Promise.all([client.getParticipants(), client.getParticipants()]);
  assert.equal(results[0], results[1]);
  await client.getParticipants();
  assert.equal(tokenCalls, 2);
  assert.equal(apiCalls, 2);
});

test("API failures are not interpreted as an empty member list", async () => {
  const request: typeof fetch = async (url) => url === options.tokenUrl
    ? Response.json({ access_token: "synthetic", expires_in: 300 })
    : new Response(null, { status: 503 });
  await assert.rejects(new RegistrationClient(options, request).getParticipants(), /503/);
  assert.throws(() => new RegistrationClient({ ...options, apiUrl: "http://example.test/api" }), /HTTPS/);
});

test("command definitions load without initializing incomplete access configuration", () => {
  const script = `
    const { commands } = await import('./src/commands/index.ts');
    const { default: assert } = await import('node:assert/strict');
    const definitions = commands.map(command => command.data.toJSON());
    if (!definitions.some(command => command.name === 'setup-access')) throw new Error('Missing setup-access');
    if (!definitions.some(command => command.name === 'voice-name')) throw new Error('Missing voice-name');
    for (const name of ['giveaccess', 'clearaccessoverride', 'cs-link', 'cs-unlink', 'cs-status', 'cs-webhook-check', 'cs-webhook-logs', 'cs-max-bitrate', 'make-cs-team-rooms', 'cs-notifications', 'meal-notifications', 'manual-overrides', 'crew-help', 'set-up-crew-help']) {
      if (!definitions.some(command => command.name === name)) throw new Error('Missing ' + name);
    }
    const fixedRooms = definitions.find(command => command.name === 'make-cs-team-rooms');
    const competitionChoices = fixedRooms.options.find(option => option.name === 'konkurranse').choices.map(choice => choice.value);
    assert.deepEqual(competitionChoices, ['main', 'wingman', 'generic']);
    const notifications = definitions.find(command => command.name === 'cs-notifications');
    assert.deepEqual(notifications.options, []);
    const mealNotifications = definitions.find(command => command.name === 'meal-notifications');
    assert.deepEqual(mealNotifications.options, []);
    const csUnlink = definitions.find(command => command.name === 'cs-unlink');
    assert.equal(csUnlink.options.some(option => option.name === 'behold_rolle' && option.required === false), true);
    const giveAccessPerson = definitions.find(command => command.name === 'giveaccess').options.find(option => option.name === 'person');
    if (giveAccessPerson.type !== 3 || giveAccessPerson.autocomplete !== true) throw new Error('giveaccess person must use member autocomplete');
    assert.equal(definitions.find(command => command.name === 'setup-access').options.some(option => option.name === 'beskytt_kanaler'), false);
    const runtime = await import('./src/accessRuntime.ts');
    assert.equal(runtime.accessManager, undefined);
    assert.match(runtime.accessInitializationError, /REGISTRATION|ACCESS_ROLE_ID/);
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previousDirectory = process.cwd();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'voice-without-access-'));
    process.chdir(temporaryDirectory);
    try {
      const { handleVoiceStateUpdate } = await import('./src/voiceManager.ts');
      let createdChannels = 0;
      let movedTo = '';
      const createdChannel = { id: '222222222222222222', parent: null };
      const guild = {
        id: '${discordId}',
        maximumBitrate: 64000,
        channels: { create: async () => { createdChannels += 1; return createdChannel; } }
      };
      const member = {
        id: '${discordId}',
        guild,
        displayName: 'Test member',
        voice: { setChannel: async channel => { movedTo = channel.id; } }
      };
      await handleVoiceStateUpdate({ channel: null }, {
        channelId: '${discordId}', channel: null, member
      });
      assert.equal(createdChannels, 1);
      assert.equal(movedTo, createdChannel.id);
    } finally {
      process.chdir(previousDirectory);
      await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  `;
  for (const completeApi of [false, true]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        DISCORD_TOKEN: "synthetic", DISCORD_CLIENT_ID: discordId, DISCORD_GUILD_ID: discordId,
        JOIN_TO_CREATE_CHANNEL_ID: discordId,
        ACCESS_ROLE_ID: "", ACCESS_CHANNEL_ID: "", CREW_ROLE_ID: "", REGISTRATION_URL: "",
        ACCESS_DRY_RUN: "true", ACCESS_SYNC_INTERVAL_MS: "60000",
        REGISTRATION_API_URL: options.apiUrl,
        REGISTRATION_TOKEN_URL: completeApi ? options.tokenUrl : "",
        REGISTRATION_CLIENT_ID: completeApi ? "test" : "",
        REGISTRATION_CLIENT_SECRET: completeApi ? "test" : ""
      }
    });
    assert.equal(result.status, 0, `Incomplete access settings must not crash imports or allow unguarded voice creation.\n${result.stderr}\n${result.stdout}`);
  }
});

test("setup-access publishes the entry without requiring categories or editing permissions", () => {
  const script = `
    const { default: assert } = await import('node:assert/strict');
    const { accessManager } = await import('./src/accessRuntime.ts');
    const { setupAccessCommand } = await import('./src/commands/setupAccess.ts');
    let validations = 0;
    let publications = 0;
    let reply = '';
    accessManager.validateGuild = async () => { validations += 1; };
    accessManager.publishEntry = async () => { publications += 1; };
    const guild = {
      id: '${discordId}',
      members: { fetch: async () => ({ permissions: { has: () => true }, guild: {} }) },
      channels: { fetch: () => { throw new Error('Must not inspect or edit category permissions'); } }
    };
    await setupAccessCommand.execute({
      guild, guildId: guild.id, user: { id: '${discordId}' },
      deferReply: async () => {}, editReply: async value => { reply = value; },
      options: { getBoolean: name => { assert.equal(name, 'gjenopprett'); return false; } }
    });
    assert.equal(validations, 1);
    assert.equal(publications, 1);
    assert.match(reply, /ikke endret/);
    assert.equal(reply.includes('https://example.test/'), true);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      DISCORD_TOKEN: "synthetic", DISCORD_CLIENT_ID: discordId, DISCORD_GUILD_ID: discordId,
      ACCESS_ROLE_ID: "123456789012345679", MANUAL_ACCESS_ROLE_ID: "123456789012345682",
      ACCESS_CHANNEL_ID: "123456789012345680", CREW_ROLE_ID: "123456789012345681",
      ACCESS_DRY_RUN: "false", ACCESS_SYNC_INTERVAL_MS: "60000",
      REGISTRATION_URL: "https://example.test/", REGISTRATION_API_URL: options.apiUrl,
      REGISTRATION_TOKEN_URL: options.tokenUrl, REGISTRATION_CLIENT_ID: "test", REGISTRATION_CLIENT_SECRET: "test"
    }
  });
  assert.equal(result.status, 0, `Manual setup must publish without category configuration or permission mutations.\n${result.stderr}\n${result.stdout}`);
});

test("participant SteamID64 is retained only when valid", () => {
  const withSteamId = { data: { participants: {
    [discordId]: { name: "Test Person", firstName: "Test", steamId: "76561198000000001" }
  } } };
  const invalidSteamId = { data: { participants: {
    [discordId]: { name: "Test Person", firstName: "Test", steamId: "not-a-steam-id" }
  } } };
  assert.equal(parseParticipants(withSteamId).get(discordId)?.steamId, "76561198000000001");
  assert.equal(parseParticipants(invalidSteamId).get(discordId)?.steamId, undefined);
});

test("CS participants include Discord-linked children without changing access participants", () => {
  const guardianId = "123456789012345678";
  const childDiscordId = "123456789012345679";
  const payloadWithChildren = { data: { participants: {
    [guardianId]: {
      name: "Guardian Person", firstName: "Guardian", steamId: "76561198000000001", tournaments: ["cs2"],
      children: [
        { id: "child-linked", discordId: childDiscordId, name: "Child Person", firstName: "Child", steamId: "76561198000000002", tournaments: ["cs2-wingman"], meals: [{ day: "saturday", round: "Pulje 2", time: "18:00" }] },
        { id: "child-unlinked", discordId: "", name: "Unlinked Child", firstName: "Unlinked", steamId: "76561198000000003" }
      ]
    }
  } } };

  assert.equal(parseParticipants(payloadWithChildren).size, 1);
  const csParticipants = parseCsParticipants(payloadWithChildren);
  assert.equal(csParticipants.size, 2);
  assert.deepEqual(csParticipants.get(childDiscordId), {
    name: "Child Person", firstName: "Child", steamId: "76561198000000002", tournaments: ["cs2-wingman"],
    meals: [{ day: "saturday", round: "Pulje 2", time: "18:00" }]
  });
  assert.deepEqual(csParticipants.get(guardianId)?.tournaments, ["cs2"]);
});

test("duplicate child Discord IDs are retained without a Steam mapping", () => {
  const guardianId = "123456789012345678";
  const childDiscordId = "123456789012345679";
  const payloadWithDuplicateChild = { data: { participants: {
    [guardianId]: {
      name: "Guardian Person", firstName: "Guardian",
      children: [
        { id: "child-one", discordId: childDiscordId, name: "Child One", firstName: "Child", steamId: "76561198000000002" },
        { id: "child-two", discordId: childDiscordId, name: "Child Two", firstName: "Child", steamId: "76561198000000003" }
      ]
    }
  } } };
  assert.equal(parseCsParticipants(payloadWithDuplicateChild).get(childDiscordId)?.steamId, undefined);
});

test("identical top-level and nested child records retain an unambiguous CS identity", () => {
  const guardianId = "123456789012345678";
  const childDiscordId = "123456789012345679";
  const child = {
    name: "Ludvig Arnesen",
    firstName: "Ludvig",
    steamId: "76561199545530816",
    tournaments: ["cs2", "cs2-wingman"]
  };
  const payloadWithMirroredChild = { data: { participants: {
    [guardianId]: {
      name: "Guardian Person", firstName: "Guardian",
      children: [{ id: "child-id", discordId: childDiscordId, ...child }]
    },
    [childDiscordId]: { ...child, child: true }
  } } };

  assert.deepEqual(parseCsParticipants(payloadWithMirroredChild).get(childDiscordId), child);
});

test("conflicting top-level and nested child records still fail closed", () => {
  const guardianId = "123456789012345678";
  const childDiscordId = "123456789012345679";
  const payloadWithConflictingChild = { data: { participants: {
    [guardianId]: {
      name: "Guardian Person", firstName: "Guardian",
      children: [{ id: "child-id", discordId: childDiscordId, name: "Child Person", firstName: "Child", steamId: "76561199545530816", tournaments: ["cs2"] }]
    },
    [childDiscordId]: { name: "Different Person", firstName: "Different", steamId: "76561199545530816", tournaments: ["cs2"], child: true }
  } } };

  const participant = parseCsParticipants(payloadWithConflictingChild).get(childDiscordId);
  assert.equal(participant?.steamId, undefined);
  assert.equal(participant?.tournaments, undefined);
});

test("registration client shares its response cache while exposing separate access and CS views", async () => {
  let apiCalls = 0;
  const childDiscordId = "123456789012345679";
  const responsePayload = { data: { participants: {
    [discordId]: {
      name: "Guardian Person", firstName: "Guardian",
      children: [{ id: "child", discordId: childDiscordId, name: "Child Person", firstName: "Child", steamId: "76561198000000002" }]
    }
  } } };
  const request: typeof fetch = async url => {
    if (url === options.tokenUrl) return Response.json({ access_token: "synthetic", expires_in: 300 });
    apiCalls += 1;
    return Response.json(responsePayload);
  };
  const client = new RegistrationClient(options, request);
  const accessParticipants = await client.getParticipants();
  const csParticipants = await client.getCsParticipants();
  assert.equal(accessParticipants.size, 1);
  assert.equal(accessParticipants.has(childDiscordId), false);
  assert.equal(csParticipants.size, 2);
  assert.equal(csParticipants.get(childDiscordId)?.steamId, "76561198000000002");
  assert.equal(apiCalls, 1);
});

test("meal fields preserve valid Saturday meal groups and fail closed on invalid lists", () => {
  const valid = { data: { participants: {
    [discordId]: { name: "Test Person", firstName: "Test", meals: [{ day: "saturday", round: "Pulje 1", time: "18:00" }] }
  } } };
  const empty = { data: { participants: { [discordId]: { name: "Test Person", firstName: "Test", meals: [] } } } };
  const invalid = { data: { participants: {
    [discordId]: { name: "Test Person", firstName: "Test", meals: [{ day: "saturday", round: "Pulje 3", time: "18:00" }] }
  } } };
  assert.deepEqual(parseParticipants(valid).get(discordId)?.meals, [{ day: "saturday", round: "Pulje 1", time: "18:00" }]);
  assert.deepEqual(parseParticipants(empty).get(discordId)?.meals, []);
  assert.equal(parseParticipants(invalid).get(discordId)?.meals, undefined);
  assert.equal(parseParticipants(payload).get(discordId)?.meals, undefined);
});