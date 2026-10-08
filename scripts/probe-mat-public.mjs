import "dotenv/config";

const baseUrl = process.env.MAT_URL;
if (!baseUrl) {
  console.log("MAT_URL_MISSING");
  process.exit(0);
}

const base = new URL(baseUrl);
if (base.protocol !== "https:" || base.username || base.password) {
  console.log("MAT_URL_INVALID");
  process.exit(1);
}

const safeFields = ["id", "type", "status", "teamSize"];

for (const route of ["/api/tournament/current-id", "/api/tournaments"]) {
  try {
    const response = await fetch(new URL(route, base), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    const summary = { route, status: response.status };
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (payload && typeof payload === "object") {
      summary.keys = Object.keys(payload);
      const records = Array.isArray(payload)
        ? payload
        : Array.isArray(payload.data)
          ? payload.data
          : Array.isArray(payload.tournaments)
            ? payload.tournaments
            : null;
      if (records) {
        summary.count = records.length;
        summary.events = records.map(record => record && typeof record === "object"
          ? Object.fromEntries(safeFields
            .filter(key => ["string", "number", "boolean"].includes(typeof record[key]))
            .map(key => [key, record[key]]))
          : null);
      } else {
        for (const key of safeFields) {
          if (["string", "number", "boolean"].includes(typeof payload[key])) summary[key] = payload[key];
        }
        if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
          summary.dataKeys = Object.keys(payload.data);
          for (const key of safeFields) {
            if (["string", "number", "boolean"].includes(typeof payload.data[key])) summary[key] = payload.data[key];
          }
        }
      }
    }

    console.log(JSON.stringify(summary));
  } catch (error) {
    const code = error && typeof error === "object" && "cause" in error
      && error.cause && typeof error.cause === "object" && "code" in error.cause
      && typeof error.cause.code === "string"
      ? error.cause.code
      : undefined;
    console.log(JSON.stringify({ route, error: error instanceof Error ? error.name : "request_failed", code }));
  }
}