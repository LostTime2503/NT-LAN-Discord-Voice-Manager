import assert from "node:assert/strict";
import { test } from "node:test";
import { CsParticipantRoleRuntime, getCsEnrolledDiscordIds, summarizeCsParticipantList } from "../src/csParticipantRoleRuntime.js";
import type { RegisteredPerson } from "../src/registrationClient.js";

const enrolledId = "123456789012345678";
const withdrawnId = "123456789012345679";
const missingId = "123456789012345680";
const manualId = "123456789012345681";
const manualEnrolledId = "123456789012345682";

const participants = new Map<string, RegisteredPerson>([
  [enrolledId, { name: "Main", firstName: "Main", tournaments: ["cs2"] }],
  [withdrawnId, { name: "Withdrawn", firstName: "Withdrawn", tournaments: [] }],
  [missingId, { name: "Missing", firstName: "Missing" }],
  [manualId, { name: "Manual", firstName: "Manual", steamId: "76561198000000004", manualCsLink: true }],
  [manualEnrolledId, { name: "Crew Main", firstName: "Crew", tournaments: ["cs2"], steamId: "76561198000000005", manualCsLink: true }]
]);

test("CS participant summary separates Steam links, enrollment, and missing data", () => {
  assert.deepEqual(summarizeCsParticipantList(participants.values()), {
    participants: 5,
    steamMapped: 2,
    mainEnrolled: 2,
    wingmanEnrolled: 0,
    enrolled: 2,
    explicitlyNotEnrolled: 1,
    missingEnrollmentData: 2,
    manualLinks: 2
  });
});

test("CS enrolled member IDs include either Main or Wingman enrollment only", () => {
  assert.deepEqual(getCsEnrolledDiscordIds(participants.entries()), [enrolledId, manualEnrolledId]);
});

test("role dry-run reports enrollment but performs no role mutations", async () => {
  const calls: Array<{ memberId: string; shouldHaveRole: boolean }> = [];
  let report: unknown;
  const runtime = new CsParticipantRoleRuntime(
    { getParticipants: async () => new Map(), getCsParticipants: async () => participants },
    { setParticipantRole: async (memberId, shouldHaveRole) => { calls.push({ memberId, shouldHaveRole }); return true; } },
    30_000,
    true,
    summary => { report = summary; }
  );
  assert.deepEqual(await runtime.runOnce(), {
    participants: 5,
    enrolled: 2,
    explicitlyNotEnrolled: 1,
    missingEnrollmentData: 2,
    manualLinks: 2,
    rolesAdded: 0,
    rolesRemoved: 0,
    dryRun: true
  });
  assert.deepEqual(report, await runtime.runOnce());
  assert.deepEqual(calls, []);
});

test("live role sync follows explicit enrollment while preserving missing enrollment data", async () => {
  const calls: Array<{ memberId: string; shouldHaveRole: boolean }> = [];
  const runtime = new CsParticipantRoleRuntime(
    { getParticipants: async () => new Map(), getCsParticipants: async () => participants },
    { setParticipantRole: async (memberId, shouldHaveRole) => { calls.push({ memberId, shouldHaveRole }); return true; } },
    30_000,
    false,
    () => undefined
  );
  const summary = await runtime.runOnce();
  assert.equal(summary?.rolesAdded, 2);
  assert.equal(summary?.rolesRemoved, 1);
  assert.deepEqual(calls, [
    { memberId: enrolledId, shouldHaveRole: true },
    { memberId: withdrawnId, shouldHaveRole: false },
    { memberId: manualEnrolledId, shouldHaveRole: true }
  ]);
});

test("registration API failure never triggers role removals", async () => {
  let roleCalls = 0;
  const runtime = new CsParticipantRoleRuntime(
    { getParticipants: async () => { throw new Error("synthetic API failure"); } },
    { setParticipantRole: async () => { roleCalls += 1; return true; } },
    30_000,
    false,
    () => undefined
  );
  assert.equal(await runtime.runOnce(), null);
  assert.equal(roleCalls, 0);
});