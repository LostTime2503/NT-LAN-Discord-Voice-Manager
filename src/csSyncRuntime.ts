import type { MatClient } from "./matClient.js";
import type { RegisteredPerson } from "./registrationClient.js";
import { planCsTournamentRooms } from "./csTournamentSync.js";

export interface CsSyncSummary {
  participantCount: number;
  mainTeamRoomCount: number;
  mainSkippedTeamCount: number;
  wingmanPairRoomCount: number;
  wingmanSkippedPairCount: number;
  unmatchedParticipantCount: number;
  ambiguousSteamIdCount: number;
}

export interface CsRegistrationSource {
  getParticipants(): Promise<Map<string, RegisteredPerson>>;
  getCsParticipants?(): Promise<Map<string, RegisteredPerson>>;
}

export class CsSyncRuntime {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly mat: MatClient,
    private readonly registration: CsRegistrationSource,
    private readonly mainTournamentId: number,
    private readonly wingmanTournamentId: number,
    private readonly intervalMs: number,
    private readonly report: (summary: CsSyncSummary) => void = summary => console.log("CS sync dry-run", summary)
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

  async runOnce(): Promise<CsSyncSummary | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const participantsRequest = this.registration.getCsParticipants?.() ?? this.registration.getParticipants();
      const [participants, teams, mainBracket, wingmanBracket] = await Promise.all([
        participantsRequest,
        this.mat.getTeams(),
        this.mat.getBracketSummary(this.mainTournamentId),
        this.mat.getBracketSummary(this.wingmanTournamentId)
      ]);
      const plans = planCsTournamentRooms(mainBracket, wingmanBracket, teams, participants);
      const summary: CsSyncSummary = {
        participantCount: participants.size,
        mainTeamRoomCount: plans.main.rooms.length,
        mainSkippedTeamCount: plans.main.skippedTeamCount,
        wingmanPairRoomCount: plans.wingman.rooms.length,
        wingmanSkippedPairCount: plans.wingman.skippedTeamCount,
        unmatchedParticipantCount: plans.main.unmatchedParticipantCount + plans.wingman.unmatchedParticipantCount,
        ambiguousSteamIdCount: Math.max(plans.main.ambiguousSteamIdCount, plans.wingman.ambiguousSteamIdCount)
      };
      this.report(summary);
      return summary;
    } catch {
      console.error("CS sync dry-run failed; no Discord changes were made.");
      return null;
    } finally {
      this.running = false;
    }
  }
}