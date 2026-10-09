import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeCommandPreview, issueCommandPreview } from "../src/commandPreviews.js";

test("command preview is one-use and bound to exact actor, guild, and resources", () => {
  const token = issueCommandPreview("clean", "guild", "actor", ["one", "two"], 100);
  assert.equal(consumeCommandPreview(token, "clean", "guild", "actor", ["two", "one"], 101), true);
  assert.equal(consumeCommandPreview(token, "clean", "guild", "actor", ["one", "two"], 102), false);

  const changed = issueCommandPreview("clean", "guild", "actor", ["one"], 100);
  assert.equal(consumeCommandPreview(changed, "clean", "guild", "actor", ["one", "new"], 101), false);
  const wrongActor = issueCommandPreview("clean", "guild", "actor", ["one"], 100);
  assert.equal(consumeCommandPreview(wrongActor, "clean", "guild", "other", ["one"], 101), false);
});

test("command preview expires", () => {
  const token = issueCommandPreview("make", "guild", "actor", ["room"], 100);
  assert.equal(consumeCommandPreview(token, "make", "guild", "actor", ["room"], 300_101), false);
});