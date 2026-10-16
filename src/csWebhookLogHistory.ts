export interface CsWebhookLogEntry {
  id: string;
  author: { id: string };
  content: string;
  createdAt: Date;
}

export interface CsWebhookLogPage<T extends CsWebhookLogEntry> {
  size: number;
  values(): Iterable<T>;
  last(): T | undefined;
}

export interface CsWebhookLogPageOptions {
  limit: number;
  before?: string;
}

export async function fetchRecentCsWebhookLogs<T extends CsWebhookLogEntry>(
  fetchPage: (options: CsWebhookLogPageOptions) => Promise<CsWebhookLogPage<T>>,
  botUserId: string,
  limit = 8,
  maxMessages = 1_000
): Promise<T[]> {
  const pageSize = 100;
  const maxPages = Math.ceil(maxMessages / pageSize);
  const matches: T[] = [];
  let before: string | undefined;

  for (let pageNumber = 0; pageNumber < maxPages && matches.length < limit; pageNumber += 1) {
    const page = await fetchPage({ limit: pageSize, ...(before ? { before } : {}) });
    if (!page.size) break;

    for (const message of page.values()) {
      if (message.author.id === botUserId && message.content.startsWith("CS webhook ")) {
        matches.push(message);
        if (matches.length === limit) break;
      }
    }

    if (matches.length === limit || page.size < pageSize) break;
    before = page.last()?.id;
    if (!before) break;
  }

  return matches.reverse();
}
