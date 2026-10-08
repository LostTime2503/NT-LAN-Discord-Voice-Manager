import "dotenv/config";

const baseUrl = process.env.MAT_URL;
const apiToken = process.env.MAT_API_TOKEN;
const discordId = process.env.MAT_PROBE_DISCORD_ID;
const steamId = process.env.MAT_PROBE_STEAM_ID;

if (!baseUrl || !apiToken) {
  console.log("MAT_READONLY_CONFIGURATION_MISSING");
  process.exit(1);
}

const base = new URL(baseUrl);
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
  console.log("MAT_URL_INVALID");
  process.exit(1);
}
if (discordId && !/^\d{17,20}$/.test(discordId)) {
  console.log("MAT_PROBE_DISCORD_ID_INVALID");
  process.exit(1);
}
if (steamId && !/^\d{17}$/.test(steamId)) {
  console.log("MAT_PROBE_STEAM_ID_INVALID");
  process.exit(1);
}

function fieldNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter(key => /^[a-z][A-Za-z0-9_]{0,39}$/.test(key)).sort();
}

async function get(route, displayRoute = route) {
  const response = await fetch(new URL(route, base), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/json", Authorization: `Bearer ${apiToken}` }
  });
  if (!response.ok) {
    console.log(JSON.stringify({ route: displayRoute, status: response.status }));
    return null;
  }
  try {
    return await response.json();
  } catch {
    console.log(JSON.stringify({ route, error: "invalid_json" }));
    return null;
  }
}

try {
  const teamsPayload = await get("/api/teams");
  if (teamsPayload) {
    const teams = Array.isArray(teamsPayload.teams)
      ? teamsPayload.teams
      : isRecord(teamsPayload.data) && Array.isArray(teamsPayload.data.teams)
        ? teamsPayload.data.teams
        : Array.isArray(teamsPayload.data)
          ? teamsPayload.data
          : null;
    const players = teams?.flatMap(team => isRecord(team) && Array.isArray(team.players)
      ? team.players.filter(isRecord)
      : []) ?? [];
    const steamFields = [...new Set(players.flatMap(player => Object.keys(player)
      .filter(key => /steam.*(id|identifier)|(?:id|identifier).*steam/i.test(key))))].sort();
    const discordFields = [...new Set(players.flatMap(player => Object.keys(player)
      .filter(key => /discord.*id|id.*discord/i.test(key))))].sort();
    const steamMatches = steamId
      ? players.filter(player => steamFields.some(key => String(player[key]) === steamId))
      : [];
    const steamMatchesWithDiscordId = steamMatches.filter(player => discordFields.some(key => {
      const value = player[key];
      return value !== undefined && value !== null && String(value).trim() !== "";
    }));
    const discordMatches = discordId
      ? steamMatches.filter(player => discordFields.some(key => String(player[key]) === discordId))
      : [];
    console.log(JSON.stringify({
      route: "/api/teams",
      success: teamsPayload.success === true,
      teamCount: teams?.length ?? null,
      teamPlayerCount: players.length,
      firstTeamFields: teams?.length ? fieldNames(teams[0]) : [],
      firstPlayerFields: players.length ? fieldNames(players[0]) : [],
      steamFields,
      steamMatchCount: steamId ? steamMatches.length : null,
      discordFields,
      steamMatchDiscordIdCount: steamId ? steamMatchesWithDiscordId.length : null,
      discordMatchCount: discordId && steamId ? discordMatches.length : null
    }));
  }

  if (discordId) {
    const route = `/api/players/by-discord-id/${discordId}`;
    const displayRoute = "/api/players/by-discord-id/:discordId";
    const playerPayload = await get(route, displayRoute);
    if (playerPayload) {
      const players = Array.isArray(playerPayload.players) ? playerPayload.players : null;
      console.log(JSON.stringify({
        route: "/api/players/by-discord-id/:discordId",
        success: playerPayload.success === true,
        matchCount: players?.length ?? null,
        playerFields: players?.length ? fieldNames(players[0]) : []
      }));
    }
  } else {
    console.log(JSON.stringify({ route: "/api/players/by-discord-id/:discordId", skipped: "MAT_PROBE_DISCORD_ID_NOT_SET" }));
  }
} catch (error) {
  const code = error && typeof error === "object" && "cause" in error
    && error.cause && typeof error.cause === "object" && "code" in error.cause
    && typeof error.cause.code === "string"
    ? error.cause.code
    : undefined;
  console.log(JSON.stringify({ error: error instanceof Error ? error.name : "request_failed", code }));
  process.exitCode = 1;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}