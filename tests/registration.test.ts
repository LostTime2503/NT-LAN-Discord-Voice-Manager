import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createNickname, parseParticipants, RegistrationClient } from "../src/registrationClient.js";

const discordId = "123456789012345678";
const payload = { data: { participants: { [discordId]: { name: "Test Person", firstName: "Test", crew: true } } } };
const options = { apiUrl: "https://example.test/api", tokenUrl: "https://example.test/token", clientId: "test", clientSecret: "test" };

test("participants are keyed by string Discord IDs and unrelated fields are discarded", () => {
  assert.deepEqual(parseParticipants(payload).get(discordId), { name: "Test Person", firstName: "Test" });
  assert.throws(() => parseParticipants({ data: { participants: [] } }));
  assert.throws(() => parseParticipants({ data: { participants: { invalid: {} } } }));
});

test("nicknames keep the first name and use the final surname initial", () => {
  assert.equal(createNickname({ name: " Leah  Olafsen Opsahlseter ", firstName: "Leah" }), "Leah O.");
  assert.equal(createNickname({ name: "Test Verylongmiddle Anotherlongmiddle Person", firstName: "Test" }), "Test P.");
  assert.equal(createNickname({ name: "Anne Marie Wold Hansen", firstName: "Anne Marie" }), "Anne Marie H.");
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
    const definitions = commands.map(command => command.data.toJSON());
    if (!definitions.some(command => command.name === 'setup-access')) throw new Error('Missing setup-access');
    if (!definitions.some(command => command.name === 'voice-name')) throw new Error('Missing voice-name');
    const { default: assert } = await import('node:assert/strict');
    assert.equal(definitions.find(command => command.name === 'setup-access').options.some(option => option.name === 'beskytt_kanaler'), false);
    const runtime = await import('./src/accessRuntime.ts');
    assert.equal(runtime.accessManager, undefined);
    assert.match(runtime.accessInitializationError, /REGISTRATION|ACCESS_ROLE_ID/);
    const { handleVoiceStateUpdate } = await import('./src/voiceManager.ts');
    await assert.rejects(handleVoiceStateUpdate(
      { channel: null }, { channelId: '${discordId}', member: {}, channel: { parent: null } }
    ), /Access sync is unavailable/);
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
    assert.equal(result.status, 0, "Incomplete access settings must not crash imports or allow unguarded voice creation.");
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
      ACCESS_ROLE_ID: "123456789012345679", ACCESS_CHANNEL_ID: "123456789012345680", CREW_ROLE_ID: "123456789012345681",
      ACCESS_DRY_RUN: "false", ACCESS_SYNC_INTERVAL_MS: "60000",
      REGISTRATION_URL: "https://example.test/", REGISTRATION_API_URL: options.apiUrl,
      REGISTRATION_TOKEN_URL: options.tokenUrl, REGISTRATION_CLIENT_ID: "test", REGISTRATION_CLIENT_SECRET: "test"
    }
  });
  assert.equal(result.status, 0, `Manual setup must publish without category configuration or permission mutations.\n${result.stderr}\n${result.stdout}`);
});