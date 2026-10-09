import type { CsDiscordAdapter } from "./csDiscordManager.js";
import type { CsRegistrationSource } from "./csSyncRuntime.js";

export interface CsRoleSyncSummary {
  participants: number;
  enrolled: number;
  explicitlyNotEnrolled: number;
  missingEnrollmentData: number;
  manualLinks: number;
  rolesAdded: number;
  rolesRemoved: number;
  dryRun: boolean;
}

export class CsParticipantRoleRuntime {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly source: CsRegistrationSource,
    private readonly adapter: Pick<CsDiscordAdapter, "setParticipantRole">,
    private readonly intervalMs: number,
    private readonly dryRun: boolean,
    private readonly report: (summary: CsRoleSyncSummary) => void = summary => console.log("CS participant role sync", summary)
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<CsRoleSyncSummary | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const participants = this.source.getCsParticipants
        ? await this.source.getCsParticipants()
        : await this.source.getParticipants();
      const summary: CsRoleSyncSummary = {
        participants: participants.size,
        enrolled: 0,
        explicitlyNotEnrolled: 0,
        missingEnrollmentData: 0,
        manualLinks: 0,
        rolesAdded: 0,
        rolesRemoved: 0,
        dryRun: this.dryRun
      };
      for (const [discordId, participant] of participants) {
        if (participant.manualCsLink) {
          summary.manualLinks += 1;
          continue;
        }
        if (!Array.isArray(participant.tournaments)) {
          summary.missingEnrollmentData += 1;
          continue;
        }
        const enrolled = participant.tournaments.includes("cs2") || participant.tournaments.includes("cs2-wingman");
        if (enrolled) summary.enrolled += 1;
        else summary.explicitlyNotEnrolled += 1;
        if (this.dryRun) continue;
        try {
          const changed = await this.adapter.setParticipantRole(discordId, enrolled);
          if (changed && enrolled) summary.rolesAdded += 1;
          if (changed && !enrolled) summary.rolesRemoved += 1;
        } catch {
          console.error("One CS participant role update failed; remaining members will still be processed.");
        }
      }
      this.report(summary);
      return summary;
    } catch {
      console.error("CS participant role sync failed; existing roles were preserved.");
      return null;
    } finally {
      this.running = false;
    }
  }
}