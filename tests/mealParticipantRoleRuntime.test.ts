import assert from "node:assert/strict";
import { test } from "node:test";
import { MealParticipantRoleRuntime, type MealRoleAdapter } from "../src/mealParticipantRoleRuntime.js";
import type { RegisteredPerson } from "../src/registrationClient.js";

const memberOne = "123456789012345678";
const memberTwo = "123456789012345679";
const memberThree = "123456789012345680";
const memberFour = "123456789012345681";

class FakeMealRoleAdapter implements MealRoleAdapter {
  readonly calls: Array<{ memberId: string; roundOne: boolean; roundTwo: boolean }> = [];

  async syncMealRoles(memberId: string, hasRoundOneMeal: boolean, hasRoundTwoMeal: boolean) {
    this.calls.push({ memberId, roundOne: hasRoundOneMeal, roundTwo: hasRoundTwoMeal });
    return { roundOneAdded: 0, roundOneRemoved: 0, roundTwoAdded: 0, roundTwoRemoved: 0, unchanged: 2 };
  }
}

function person(meals?: RegisteredPerson["meals"]): RegisteredPerson {
  return { name: "Test Person", firstName: "Test", ...(meals === undefined ? {} : { meals }) };
}

test("Saturday meals assign Pulje roles, empty meals clear both, and missing data is preserved", async () => {
  const participants = new Map<string, RegisteredPerson>([
    [memberOne, person([{ day: "saturday", round: "Pulje 1", time: "18:00" }])],
    [memberTwo, person([{ day: "saturday", round: "Pulje 2", time: "19:00" }])],
    [memberThree, person([])],
    [memberFour, person([{ day: "friday", round: "Pulje 1", time: "18:00" }])],
    ["123456789012345682", person()]
  ]);
  const adapter = new FakeMealRoleAdapter();
  const runtime = new MealParticipantRoleRuntime({ getParticipants: async () => participants }, adapter, 60_000);
  const summary = await runtime.runOnce();

  assert.equal(summary?.participantsWithMealData, 4);
  assert.equal(summary?.participantsMissingMealData, 1);
  assert.equal(summary?.roundOneParticipants, 1);
  assert.equal(summary?.roundTwoParticipants, 1);
  assert.deepEqual(adapter.calls, [
    { memberId: memberOne, roundOne: true, roundTwo: false },
    { memberId: memberTwo, roundOne: false, roundTwo: true },
    { memberId: memberThree, roundOne: false, roundTwo: false },
    { memberId: memberFour, roundOne: false, roundTwo: false }
  ]);
});

test("registration API failure does not attempt any meal role removals", async () => {
  const adapter = new FakeMealRoleAdapter();
  const runtime = new MealParticipantRoleRuntime({ getParticipants: async () => { throw new Error("API unavailable"); } }, adapter, 60_000);
  assert.equal(await runtime.runOnce(), null);
  assert.deepEqual(adapter.calls, []);
});
