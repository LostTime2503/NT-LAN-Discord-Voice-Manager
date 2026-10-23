import { createHmac, randomUUID } from "node:crypto";

function readOption(name) {
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const eventType = readOption("event") ?? "match.live";
const statuses = {
  "match.ready": "loaded",
  "match.live": "live",
  "match.finished": "completed",
  "match.cancelled": "cancelled",
  "match.reset": "pending"
};
if (!(eventType in statuses)) throw new Error("Use --event=match.ready|match.live|match.finished|match.cancelled|match.reset.");
const url = new URL(readOption("url") ?? "http://127.0.0.1:8788/webhooks/cs-test");
if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/webhooks/cs-test"
  || url.username || url.password || url.search || url.hash) {
  throw new Error("Use a plain HTTP(S) test receiver URL ending in /webhooks/cs-test, without credentials or query parameters.");
}
const secret = process.env.CS_TEST_WEBHOOK_SECRET;
if (!secret) throw new Error("Set CS_TEST_WEBHOOK_SECRET in this process. No secret is read from a file.");
const matchId = readOption("match-id");
if (!matchId || !/^[A-Za-z0-9_-]{1,64}$/.test(matchId)) {
  throw new Error("Provide --match-id=<unique-test-name>; reuse it for the match lifecycle.");
}
const sequence = Number(readOption("sequence"));
if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Provide --sequence=<positive-integer>, increasing per match.");
const signatureOnly = process.argv.includes("--signature-test");
const terminal = ["match.finished", "match.cancelled", "match.reset"].includes(eventType);
const scope = readOption("scope") ?? "wingman";
if (!["main", "wingman"].includes(scope)) throw new Error("Use --scope=wingman or --scope=main.");
const teamSize = scope === "main" ? 5 : 2;
function parseTeam(name) {
  const ids = (readOption(name) ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (ids.length !== teamSize || ids.some(id => !/^7656119\d{10}$/.test(id))) {
    throw new Error(`--${name} must contain ${teamSize} unique, format-valid SteamID64 strings.`);
  }
  return ids;
}
const teamOne = terminal || signatureOnly ? [] : parseTeam("team-one");
const teamTwo = terminal || signatureOnly ? [] : parseTeam("team-two");
if (new Set([...teamOne, ...teamTwo]).size !== teamOne.length + teamTwo.length) {
  throw new Error("A SteamID64 may appear only once across the two teams.");
}
const payload = {
  id: `testscript-${randomUUID()}`,
  type: eventType,
  test: signatureOnly,
  data: {
    sequence,
    match: {
      id: matchId,
      slug: matchId,
      status: statuses[eventType],
      game: "cs2",
      tournament: null,
      team1: terminal ? null : {
        id: `${matchId}-a`, name: "Test team A", tag: "TEST-A",
        players: teamOne.map(steam_id64 => ({ steam_id64 }))
      },
      team2: terminal ? null : {
        id: `${matchId}-b`, name: "Test team B", tag: "TEST-B",
        players: teamTwo.map(steam_id64 => ({ steam_id64 }))
      }
    }
  }
};
const body = Buffer.from(JSON.stringify(payload));
const timestamp = Math.floor(Date.now() / 1000);
const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
const response = await fetch(url, {
  method: "POST",
  redirect: "error",
  headers: { "content-type": "application/json", "x-at-signature": `t=${timestamp},v1=${digest}` },
  body,
  signal: AbortSignal.timeout(10_000)
});
console.log(`TESTSCRIPT ${eventType}, match ${matchId}, sequence ${sequence}: HTTP ${response.status}.`);
if (response.status !== 202) process.exitCode = 1;