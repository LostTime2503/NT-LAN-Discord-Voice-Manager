import assert from "node:assert/strict";
import { test } from "node:test";
import { MatClient } from "../src/matClient.js";

const baseUrl = "https://mat.example.test";
const token = "synthetic-read-only-token";

test("tournament list requests GET and returns only safe tournament metadata", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const client = new MatClient({ baseUrl }, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({
      success: true,
      featuredId: 4,
      tournaments: [{ id: 4, type: "shuffle", status: "active", teamSize: 2, name: "private event label" }]
    });
  });

  assert.deepEqual(await client.getTournaments(), [{ id: 4, type: "shuffle", status: "active", teamSize: 2 }]);
  assert.equal(requestUrl, `${baseUrl}/api/tournaments`);
  assert.equal(requestInit?.method, "GET");
  assert.equal(requestInit?.redirect, "error");
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, undefined);
  assert.ok(requestInit?.signal);
});

test("signup and bracket methods return counts and match state, not roster values", async () => {
  const paths: string[] = [];
  const client = new MatClient({ baseUrl }, async input => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith("/bracket")) {
      return Response.json({
        success: true,
        tournament: { id: 4, type: "single_elimination", status: "active", teamSize: 5, name: "hidden" },
        totalRounds: 2,
        matches: [{ slug: "match-1", round: 1, status: "in_progress", team1: { name: "hidden roster" } }]
      });
    }
    return Response.json({ success: true, window: { registrationOpen: true }, registrations: [{ name: "hidden roster" }] });
  });

  assert.deepEqual(await client.getSignupSummary(4), { registrationCount: 1, registrationOpen: true });
  assert.deepEqual(await client.getBracketSummary(4), {
    tournament: { id: 4, type: "single_elimination", status: "active", teamSize: 5 },
    totalRounds: 2,
    matches: [{ slug: "match-1", round: 1, status: "in_progress", team1Id: null, team2Id: null }]
  });
  assert.deepEqual(paths, ["/api/tournament-signup/4", "/api/tournament/4/bracket"]);
});

test("player lookup requires a token and reports only match count", async () => {
  const discordId = "123456789012345678";
  const client = new MatClient({ baseUrl, apiToken: token }, async (input, init) => {
    assert.equal(String(input), `${baseUrl}/api/players/by-discord-id/${discordId}`);
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    return Response.json({ success: true, players: [{ name: "private" }, { name: "private" }] });
  });
  assert.equal(await client.getPlayerMatchCount(discordId), 2);
  await assert.rejects(new MatClient({ baseUrl }).getPlayerMatchCount(discordId), /MAT_API_TOKEN/);
  await assert.rejects(client.getPlayerMatchCount("invalid"), /Discord ID/);
});

test("MAT URLs and responses fail closed", async () => {
  assert.throws(() => new MatClient({ baseUrl: "http://mat.example.test" }), /HTTPS/);
  assert.throws(() => new MatClient({ baseUrl: "https://user:pass@mat.example.test" }), /HTTPS/);
  assert.throws(() => new MatClient({ baseUrl: "https://mat.example.test/api" }), /HTTPS/);
  await assert.rejects(new MatClient({ baseUrl }, async () => new Response("private body", { status: 503 }))
    .getTournaments(), /503/);
  await assert.rejects(new MatClient({ baseUrl }, async () => Response.json({ success: true, tournaments: [{}] }))
    .getTournaments(), /invalid tournament metadata/);
  await assert.rejects(new MatClient({ baseUrl }, async () => new Response("not-json"))
    .getTournaments(), /invalid JSON/);
});

test("empty brackets may have zero rounds", async () => {
  const client = new MatClient({ baseUrl }, async () => Response.json({
    success: true,
    tournament: { id: 4, type: "single_elimination", status: "upcoming", teamSize: 5 },
    totalRounds: 0,
    matches: []
  }));
  assert.deepEqual(await client.getBracketSummary(4), {
    tournament: { id: 4, type: "single_elimination", status: "upcoming", teamSize: 5 },
    totalRounds: 0,
    matches: []
  });
});

test("team lookup parses SteamID64 rosters without retaining player names", async () => {
  const client = new MatClient({ baseUrl, apiToken: token }, async (input, init) => {
    assert.equal(String(input), `${baseUrl}/api/teams`);
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    return Response.json({
      success: true,
      teams: [{
        id: 12,
        name: "Blue team",
        tag: "BLUE",
        players: [{ steamId: "76561198000000001", name: "private" }, { steamId: "invalid", name: "private" }]
      }]
    });
  });
  assert.deepEqual(await client.getTeams(), [{
    id: "12",
    name: "Blue team",
    tag: "BLUE",
    players: [{ steamId: "76561198000000001" }, { steamId: null }]
  }]);
});

test("match detail is read-only, decodes the slug, and keeps only Steam roster fields", async () => {
  const client = new MatClient({ baseUrl, apiToken: token }, async (input, init) => {
    assert.equal(String(input), `${baseUrl}/api/matches/round%2Fmatch-1`);
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    return Response.json({
      success: true,
      match: {
        id: 12,
        slug: "round/match-1",
        status: "live",
        game: "cs2",
        round: 2,
        tournament: { id: 9 },
        team1: { id: "team-1", name: "private", tag: "A", players: [{ steam_id64: "76561198000000001", name: "private player" }] },
        team2: { id: "team-2", name: "private", tag: "B", players: [{ steam_id64: "76561198000000002", name: "private player" }] },
        connect: { password: "private-server-password" }
      }
    });
  });
  assert.deepEqual(await client.getMatch("round/match-1"), {
    id: "12",
    slug: "round/match-1",
    status: "live",
    tournamentId: "9",
    round: 2,
    team1: { id: "team-1", name: "private", tag: "A", steamIds: ["76561198000000001"] },
    team2: { id: "team-2", name: "private", tag: "B", steamIds: ["76561198000000002"] }
  });
});