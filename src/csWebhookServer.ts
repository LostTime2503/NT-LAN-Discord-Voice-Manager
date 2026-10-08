import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const steamId64Pattern = /^7656119\d{10}$/;
const acceptedEventTypes = new Set([
  "match.ready",
  "match.live",
  "match.map_started",
  "match.score_updated",
  "match.map_ended",
  "match.finished",
  "match.cancelled",
  "match.reset"
]);
const relevantEventTypes = new Set(["match.ready", "match.finished", "match.cancelled", "match.reset"]);

export interface MatWebhookTeam {
  id: string;
  name: string | null;
  tag: string | null;
  steamIds: string[];
}

export interface MatWebhookEvent {
  id: string;
  type: string;
  test: boolean;
  sequence: number;
  match: {
    id: string;
    slug: string;
    status: string;
    tournamentId: string;
    team1: MatWebhookTeam | null;
    team2: MatWebhookTeam | null;
  };
}

export interface MatWebhookReceiverOptions {
  secret: string;
  path?: string;
  maxBodyBytes?: number;
  timestampToleranceMs?: number;
  now?: () => number;
  onEvent(event: MatWebhookEvent): Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function parseTeam(value: unknown): MatWebhookTeam | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("invalid_team");
  const id = stringId(value.id);
  if (!id || !Array.isArray(value.players)) throw new Error("invalid_team");
  const steamIds = value.players.map(player => {
    if (!isRecord(player) || typeof player.steam_id64 !== "string" || !steamId64Pattern.test(player.steam_id64)) {
      throw new Error("invalid_team_player");
    }
    return player.steam_id64;
  });
  return {
    id,
    name: typeof value.name === "string" ? value.name : null,
    tag: typeof value.tag === "string" ? value.tag : null,
    steamIds
  };
}

export function parseMatWebhookEvent(value: unknown): MatWebhookEvent | null {
  if (!isRecord(value) || typeof value.test !== "boolean" || typeof value.id !== "string"
    || !value.id || typeof value.type !== "string" || !acceptedEventTypes.has(value.type)
    || !isRecord(value.data) || !Number.isSafeInteger(value.data.sequence) || (value.data.sequence as number) < 0
    || !isRecord(value.data.match)) {
    throw new Error("invalid_event");
  }
  if (value.test) return null;

  const match = value.data.match;
  const matchId = stringId(match.id);
  const tournament = isRecord(match.tournament) ? stringId(match.tournament.id) : null;
  if (!matchId || typeof match.slug !== "string" || !match.slug || typeof match.status !== "string" || !tournament) {
    throw new Error("invalid_match");
  }
  if (match.game !== undefined && match.game !== "cs2") throw new Error("unsupported_game");

  return {
    id: value.id,
    type: value.type,
    test: false,
    sequence: value.data.sequence as number,
    match: {
      id: matchId,
      slug: match.slug,
      status: match.status,
      tournamentId: tournament,
      team1: parseTeam(match.team1),
      team2: parseTeam(match.team2)
    }
  };
}

export function verifyMatWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
  now = Date.now(),
  timestampToleranceMs = 5 * 60_000
): boolean {
  if (!signature || !secret) return false;
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/i.exec(signature);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp * 1000) > timestampToleranceMs) return false;
  const expected = createHmac("sha256", secret).update(`${match[1]}.`).update(rawBody).digest();
  const received = Buffer.from(match[2]!, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function respond(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Content-Length": "0", "Cache-Control": "no-store" });
  response.end();
}

function readRawBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBodyBytes) {
        reject(new Error("body_too_large"));
        request.resume();
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

export function createMatWebhookReceiver(options: MatWebhookReceiverOptions): Server {
  const route = options.path ?? "/webhooks/mat";
  const maxBodyBytes = options.maxBodyBytes ?? 128 * 1024;
  const timestampToleranceMs = options.timestampToleranceMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;

  return createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && pathname === "/healthz") {
      respond(response, 204);
      return;
    }
    if (pathname !== route) {
      respond(response, 404);
      return;
    }
    if (request.method !== "POST") {
      respond(response, 405);
      return;
    }

    void readRawBody(request, maxBodyBytes).then(async rawBody => {
      const signature = request.headers["x-at-signature"];
      if (typeof signature !== "string"
        || !verifyMatWebhookSignature(rawBody, signature, options.secret, now(), timestampToleranceMs)) {
        respond(response, 401);
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        respond(response, 400);
        return;
      }
      if (isRecord(payload) && (payload.test === true
        || (typeof payload.type === "string" && acceptedEventTypes.has(payload.type)
          && !relevantEventTypes.has(payload.type)))) {
        respond(response, 202);
        return;
      }
      let event: MatWebhookEvent | null;
      try {
        event = parseMatWebhookEvent(payload);
      } catch {
        respond(response, 400);
        return;
      }
      if (!event) {
        respond(response, 202);
        return;
      }
      try {
        await options.onEvent(event);
        respond(response, 202);
      } catch {
        respond(response, 503);
      }
    }).catch(error => {
      respond(response, error instanceof Error && error.message === "body_too_large" ? 413 : 400);
    });
  });
}