import "dotenv/config";

const options = {
  apiUrl: process.env.REGISTRATION_API_URL,
  tokenUrl: process.env.REGISTRATION_TOKEN_URL,
  clientId: process.env.REGISTRATION_CLIENT_ID,
  clientSecret: process.env.REGISTRATION_CLIENT_SECRET
};

if (Object.values(options).some(value => !value)) {
  console.log("REGISTRATION_CONFIGURATION_MISSING");
  process.exit(1);
}

for (const url of [options.apiUrl, options.tokenUrl]) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    console.log("REGISTRATION_URL_INVALID");
    process.exit(1);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectSteam(value, fields, depth = 0) {
  if (depth > 6) return false;
  if (Array.isArray(value)) {
    let hasSteamValue = false;
    for (const nested of value) {
      if (inspectSteam(nested, fields, depth + 1)) hasSteamValue = true;
    }
    return hasSteamValue;
  }
  if (!isRecord(value)) return false;
  let hasSteamValue = false;
  for (const [key, nested] of Object.entries(value)) {
    if (/steam/i.test(key)) {
      fields.add(key);
      if (nested !== null && nested !== undefined && String(nested).trim()) hasSteamValue = true;
    } else if ((isRecord(nested) || Array.isArray(nested)) && inspectSteam(nested, fields, depth + 1)) {
      hasSteamValue = true;
    }
  }
  return hasSteamValue;
}

function collectFieldNames(value, fields, depth = 0) {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const nested of value) collectFieldNames(nested, fields, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) fields.add(key);
    collectFieldNames(nested, fields, depth + 1);
  }
}

function inspectGenericIds(value, summary, depth = 0) {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const nested of value) inspectGenericIds(nested, summary, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase() === "id") {
      const type = nested === null ? "null" : Array.isArray(nested) ? "array" : typeof nested;
      summary.types[type] = (summary.types[type] ?? 0) + 1;
      if ((typeof nested === "string" || typeof nested === "number")
        && /^7656119\d{10}$/.test(String(nested))) {
        summary.steamId64FormatCount += 1;
      }
    }
    inspectGenericIds(nested, summary, depth + 1);
  }
}

try {
  const tokenResponse = await fetch(options.tokenUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      scope: "openid",
      grant_type: "client_credentials"
    })
  });
  if (!tokenResponse.ok) {
    console.log(JSON.stringify({ route: "token", status: tokenResponse.status }));
    process.exit(1);
  }
  const tokenPayload = await tokenResponse.json();
  if (!isRecord(tokenPayload) || typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) {
    console.log(JSON.stringify({ route: "token", error: "invalid_response" }));
    process.exit(1);
  }

  const response = await fetch(options.apiUrl, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/json", Authorization: `Bearer ${tokenPayload.access_token}` }
  });
  if (!response.ok) {
    console.log(JSON.stringify({ route: "participants", status: response.status }));
    process.exit(1);
  }

  const payload = await response.json();
  const participants = isRecord(payload) && isRecord(payload.data) && isRecord(payload.data.participants)
    ? Object.values(payload.data.participants).filter(isRecord)
    : null;
  if (!participants) {
    console.log(JSON.stringify({ route: "participants", error: "invalid_response_shape" }));
    process.exit(1);
  }

  const steamFields = new Set();
  const participantsWithSteamData = participants.filter(person => inspectSteam(person, steamFields)).length;
  const allFieldNames = new Set();
  collectFieldNames(payload, allFieldNames);
  const genericIdSummary = { types: {}, steamId64FormatCount: 0 };
  inspectGenericIds(participants, genericIdSummary);
  console.log(JSON.stringify({
    route: "participants",
    participantCount: participants.length,
    allFieldNames: [...allFieldNames].sort(),
    steamFieldNames: [...steamFields].sort(),
    participantsWithSteamData,
    genericIdTypes: genericIdSummary.types,
    genericIdSteam64FormatCount: genericIdSummary.steamId64FormatCount
  }));
} catch (error) {
  const code = error && typeof error === "object" && "cause" in error
    && error.cause && typeof error.cause === "object" && "code" in error.cause
    && typeof error.cause.code === "string"
    ? error.cause.code
    : undefined;
  console.log(JSON.stringify({ error: error instanceof Error ? error.name : "request_failed", code }));
  process.exitCode = 1;
}