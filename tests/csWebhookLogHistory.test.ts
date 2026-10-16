import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchRecentCsWebhookLogs, type CsWebhookLogEntry, type CsWebhookLogPage } from "../src/csWebhookLogHistory.js";

function page(messages: CsWebhookLogEntry[]): CsWebhookLogPage<CsWebhookLogEntry> {
  return {
    size: messages.length,
    values: () => messages.values(),
    last: () => messages.at(-1)
  };
}

function logEntry(id: string, authorId: string, content: string): CsWebhookLogEntry {
  return { id, author: { id: authorId }, content, createdAt: new Date("2026-10-15T12:00:00Z") };
}

test("webhook log lookup returns bot CS summaries and signed test-event logs", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    logEntry(`page-one-${index}`, "other-user", "ordinary crew message"));
  firstPage[0] = logEntry("not-bot-webhook", "other-user", "CS webhook Main match.ready: ignored");
  const secondPage = [
    logEntry("move", "bot", "CS webhook action: Flyttet en tildelt spiller til CS ONE."),
    logEntry("test", "bot", "CS webhook test: signert MAT-testevent mottatt (match.ready); ingen kamp ble behandlet."),
    logEntry("newest", "bot", "CS webhook Wingman match.finished: 0 rooms in plan"),
    logEntry("oldest", "bot", "CS webhook Main match.ready: 2 rooms in plan")
  ];
  const requestedCursors: Array<string | undefined> = [];
  const entries = await fetchRecentCsWebhookLogs(async options => {
    requestedCursors.push(options.before);
    return options.before ? page(secondPage) : page(firstPage);
  }, "bot", 8, 200);

  assert.deepEqual(requestedCursors, [undefined, "page-one-99"]);
  assert.deepEqual(entries.map(message => message.id), ["oldest", "newest", "test", "move"]);
});

test("webhook log lookup stops at the configured scan limit", async () => {
  let fetchCount = 0;
  await fetchRecentCsWebhookLogs(async () => {
    fetchCount += 1;
    return page(Array.from({ length: 100 }, (_, index) => logEntry(`p${fetchCount}-${index}`, "user", "not a webhook summary")));
  }, "bot", 8, 250);

  assert.equal(fetchCount, 3);
});
