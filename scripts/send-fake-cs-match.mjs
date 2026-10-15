import { createHmac, randomUUID } from "node:crypto";

function readOption(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find(value => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function parseTeam(name) {
  const value = readOption(name) ?? "";
  const steamIds = value.split(",").map(item => item.trim()).filter(Boolean);
  if (steamIds.length !== 2 || steamIds.some(id => !/^7656119\d{10}$/.test(id))) {
    throw new Error(`--${name} must contain exactly two valid SteamID64 values separated by a comma.`);
  }
  if (new Set(steamIds).size !== steamIds.length) throw new Error("A SteamID64 cannot appear twice on the same team.");
  return steamIds;
}

const secret = process.env.MAT_WEBHOOK_SECRET;
const rawTournamentId = readOption("tournament-id");
const port = Number(process.env.CS_WEBHOOK_PORT ?? 8787);

if (!secret) throw new Error("MAT_WEBHOOK_SECRET must be set in this PowerShell process; no secret is read from a file.");
if (!rawTournamentId || !/^\d+$/.test(rawTournamentId) || Number(rawTournamentId) <= 0) {
  throw new Error("Pass the active Wingman ID shown by /cs-status as --tournament-id=<id>.");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CS_WEBHOOK_PORT is invalid.");

const teamOneSteamIds = parseTeam("team-one");
const teamTwoSteamIds = parseTeam("team-two");
if (new Set([...teamOneSteamIds, ...teamTwoSteamIds]).size !== 4) {
  throw new Error("All four Wingman SteamID64 values must be unique.");
}

const matchId = randomUUID();
const payload = {
  id: `local-test-${matchId}`,
  type: "match.ready",
  test: false,
  data: {
    sequence: 1,
    match: {
      id: matchId,
      slug: `local-test-${matchId}`,
      status: "loaded",
      game: "cs2",
      tournament: { id: Number(rawTournamentId) },
      team1: {
        id: `local-test-${matchId}-a`,
        name: "Test pair A",
        tag: "TEST-A",
        players: teamOneSteamIds.map(steam_id64 => ({ steam_id64 }))
      },
      team2: {
        id: `local-test-${matchId}-b`,
        name: "Test pair B",
        tag: "TEST-B",
        players: teamTwoSteamIds.map(steam_id64 => ({ steam_id64 }))
      }
    }
  }
};

const body = Buffer.from(JSON.stringify(payload));
const timestamp = Math.floor(Date.now() / 1000);
const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
const response = await fetch(`http://127.0.0.1:${port}/webhooks/mat`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-at-signature": `t=${timestamp},v1=${digest}`
  },
  body,
  signal: AbortSignal.timeout(5_000)
});

console.log(`Synthetic Wingman match ${payload.id}: webhook returned HTTP ${response.status}.`);
if (response.status !== 202) process.exitCode = 1;