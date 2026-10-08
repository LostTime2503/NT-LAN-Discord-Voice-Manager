import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MatWebhookEvent, MatWebhookTeam } from "./csWebhookServer.js";

interface PersistedCsEventState {
  version: 1;
  recentEventIds: string[];
  lastSequenceByMatch: Record<string, number>;
  pending: MatWebhookEvent[];
}

export type CsEventAcceptance = "accepted" | "duplicate" | "stale";

const maxPendingEvents = 5_000;
const maxRecentEventIds = 10_000;
const steamId64Pattern = /^7656119\d{10}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTeam(value: unknown): value is MatWebhookTeam | null {
  return value === null || (isRecord(value) && typeof value.id === "string"
    && (typeof value.name === "string" || value.name === null)
    && (typeof value.tag === "string" || value.tag === null)
    && Array.isArray(value.steamIds) && value.steamIds.every(id => typeof id === "string" && steamId64Pattern.test(id)));
}

function isEvent(value: unknown): value is MatWebhookEvent {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.type !== "string"
    || value.test !== false || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
    || !isRecord(value.match)) return false;
  const match = value.match;
  return typeof match.id === "string" && typeof match.slug === "string" && typeof match.status === "string"
    && typeof match.tournamentId === "string" && isTeam(match.team1) && isTeam(match.team2);
}

export class CsEventStore {
  private state: PersistedCsEventState = {
    version: 1,
    recentEventIds: [],
    lastSequenceByMatch: {},
    pending: []
  };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = "data/cs-webhook-events.json") {}

  async load(): Promise<void> {
    try {
      const payload: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.recentEventIds)
        || payload.recentEventIds.some(id => typeof id !== "string") || !isRecord(payload.lastSequenceByMatch)
        || Object.values(payload.lastSequenceByMatch).some(sequence => !Number.isSafeInteger(sequence) || (sequence as number) < 0)
        || !Array.isArray(payload.pending) || payload.pending.some(event => !isEvent(event))) {
        throw new Error("CS webhook event store is invalid.");
      }
      this.state = {
        version: 1,
        recentEventIds: payload.recentEventIds.slice(-maxRecentEventIds) as string[],
        lastSequenceByMatch: payload.lastSequenceByMatch as Record<string, number>,
        pending: payload.pending as MatWebhookEvent[]
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CS webhook event store could not be loaded.");
    }
    this.loaded = true;
  }

  async accept(event: MatWebhookEvent): Promise<CsEventAcceptance> {
    return this.serialize(async () => {
      this.assertLoaded();
      if (this.state.recentEventIds.includes(event.id)) return "duplicate";
      if (this.state.pending.length >= maxPendingEvents) throw new Error("CS webhook event queue is full.");

      const previousState = this.state;
      this.state = structuredClone(this.state);
      const matchKey = `${event.match.tournamentId}:${event.match.id}`;
      const lastSequence = this.state.lastSequenceByMatch[matchKey];
      this.state.recentEventIds.push(event.id);
      if (this.state.recentEventIds.length > maxRecentEventIds) {
        this.state.recentEventIds.splice(0, this.state.recentEventIds.length - maxRecentEventIds);
      }

      if (lastSequence !== undefined && event.sequence <= lastSequence) {
        try {
          await this.persist();
        } catch (error) {
          this.state = previousState;
          throw error;
        }
        return "stale";
      }

      this.state.lastSequenceByMatch[matchKey] = event.sequence;
      this.state.pending.push(event);
      try {
        await this.persist();
      } catch (error) {
        this.state = previousState;
        throw error;
      }
      return "accepted";
    });
  }

  async getPending(): Promise<MatWebhookEvent[]> {
    await this.writeQueue;
    this.assertLoaded();
    return this.state.pending.map(event => structuredClone(event));
  }

  async markProcessed(eventId: string): Promise<void> {
    await this.serialize(async () => {
      this.assertLoaded();
      const nextPending = this.state.pending.filter(event => event.id !== eventId);
      if (nextPending.length === this.state.pending.length) return;
      const previousState = this.state;
      this.state = structuredClone(this.state);
      this.state.pending = nextPending;
      try {
        await this.persist();
      } catch (error) {
        this.state = previousState;
        throw error;
      }
    });
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("CS webhook event store has not been loaded.");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.writeQueue.then(operation);
    this.writeQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}