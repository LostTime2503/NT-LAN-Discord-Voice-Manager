import type { RegisteredPerson } from "./registrationClient.js";

export interface MealRoleRegistrationSource {
  getParticipants(): Promise<Map<string, RegisteredPerson>>;
}

export interface MealRoleChangeSummary {
  roundOneAdded: number;
  roundOneRemoved: number;
  roundTwoAdded: number;
  roundTwoRemoved: number;
  unchanged: number;
}

export interface MealRoleAdapter {
  syncMealRoles(memberId: string, hasRoundOneMeal: boolean, hasRoundTwoMeal: boolean): Promise<MealRoleChangeSummary>;
}

export interface MealRoleSyncSummary extends MealRoleChangeSummary {
  participants: number;
  participantsWithMealData: number;
  participantsMissingMealData: number;
  roundOneParticipants: number;
  roundTwoParticipants: number;
}

export class MealParticipantRoleRuntime {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly source: MealRoleRegistrationSource,
    private readonly adapter: MealRoleAdapter,
    private readonly intervalMs: number,
    private readonly report: (summary: MealRoleSyncSummary) => void = summary => console.log("Meal role sync", summary)
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<MealRoleSyncSummary | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const participants = await this.source.getParticipants();
      const summary: MealRoleSyncSummary = {
        participants: participants.size,
        participantsWithMealData: 0,
        participantsMissingMealData: 0,
        roundOneParticipants: 0,
        roundTwoParticipants: 0,
        roundOneAdded: 0,
        roundOneRemoved: 0,
        roundTwoAdded: 0,
        roundTwoRemoved: 0,
        unchanged: 0
      };
      for (const [memberId, person] of participants) {
        if (!Array.isArray(person.meals)) {
          summary.participantsMissingMealData += 1;
          continue;
        }
        summary.participantsWithMealData += 1;
        const saturdayMeals = person.meals.filter(meal => meal.day === "saturday");
        const hasRoundOneMeal = saturdayMeals.some(meal => meal.round === "Pulje 1");
        const hasRoundTwoMeal = saturdayMeals.some(meal => meal.round === "Pulje 2");
        if (hasRoundOneMeal) summary.roundOneParticipants += 1;
        if (hasRoundTwoMeal) summary.roundTwoParticipants += 1;
        try {
          const changes = await this.adapter.syncMealRoles(memberId, hasRoundOneMeal, hasRoundTwoMeal);
          summary.roundOneAdded += changes.roundOneAdded;
          summary.roundOneRemoved += changes.roundOneRemoved;
          summary.roundTwoAdded += changes.roundTwoAdded;
          summary.roundTwoRemoved += changes.roundTwoRemoved;
          summary.unchanged += changes.unchanged;
        } catch {
          console.error("One meal role update failed; other participants will still be processed.");
        }
      }
      this.report(summary);
      return summary;
    } catch {
      console.error("Meal role sync failed; existing Pulje roles were preserved.");
      return null;
    } finally {
      this.running = false;
    }
  }
}