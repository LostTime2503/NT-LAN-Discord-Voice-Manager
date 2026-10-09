import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { test } from "node:test";
import { createTemporaryVoiceOverwrites } from "../src/voicePermissions.js";

test("temporary channel preserves category overwrites and explicitly allows its creator", () => {
  const parent = [{
    id: "everyone-role",
    type: 0,
    allow: { bitfield: 0n },
    deny: { bitfield: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect }
  }];
  const overwrites = createTemporaryVoiceOverwrites(parent, "member-id", false);
  assert.equal(overwrites.length, 2);
  assert.equal(overwrites[0]?.id, "everyone-role");
  assert.deepEqual(overwrites[1]?.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
});

test("creator Manage Channels stays limited to access-disabled or dry-run mode", () => {
  const withoutManageChannels = createTemporaryVoiceOverwrites([], "member-id", false);
  const withManageChannels = createTemporaryVoiceOverwrites([], "member-id", true);
  assert.deepEqual(withoutManageChannels[0]?.allow, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
  assert.deepEqual(withManageChannels[0]?.allow, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.ManageChannels
  ]);
});