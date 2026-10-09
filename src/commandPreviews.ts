import { randomBytes } from "node:crypto";

interface PendingPreview {
  operation: string;
  guildId: string;
  actorId: string;
  resourceIds: string[];
  expiresAt: number;
}

const pending = new Map<string, PendingPreview>();

export function issueCommandPreview(
  operation: string,
  guildId: string,
  actorId: string,
  resourceIds: string[],
  now = Date.now()
): string {
  for (const [token, preview] of pending) if (preview.expiresAt <= now) pending.delete(token);
  const token = randomBytes(4).toString("hex").toUpperCase();
  pending.set(token, { operation, guildId, actorId, resourceIds: [...resourceIds].sort(), expiresAt: now + 5 * 60_000 });
  return token;
}

export function consumeCommandPreview(
  token: string,
  operation: string,
  guildId: string,
  actorId: string,
  resourceIds: string[],
  now = Date.now()
): boolean {
  const preview = pending.get(token.toUpperCase());
  if (!preview) return false;
  pending.delete(token.toUpperCase());
  if (preview.expiresAt <= now || preview.operation !== operation || preview.guildId !== guildId || preview.actorId !== actorId) {
    return false;
  }
  const current = [...resourceIds].sort();
  return preview.resourceIds.length === current.length
    && preview.resourceIds.every((resourceId, index) => resourceId === current[index]);
}