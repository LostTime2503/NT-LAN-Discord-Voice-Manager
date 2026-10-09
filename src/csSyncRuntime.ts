import type { MatBracketSummary, MatClient } from "./matClient.js";
import type { RegisteredPerson } from "./registrationClient.js";
import { planCsTournamentRooms } from "./csTournamentSync.js";
import { discoverActiveCsTournaments } from "./csTournamentDiscovery.js";

export interface CsSyncSummary {
  participantCount: number;
  mainTeamRoomCount: number;
  mainSkippedTeamCount: number;
  wingmanPairRoomCount: number;
  wingmanSkippedPairCount: number;
  unmatchedParticipantCount: number;
  ambiguousSteamIdCount: number;
  ambiguousMainTournamentCount: number;
  ambiguousWingmanTournamentCount: number;
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
      const [participants, teams, tournaments] = await Promise.all([
        participantsRequest,
        this.mat.getTeams(),
        this.mat.getTournaments()
      ]);
      const discovery = discoverActiveCsTournaments(tournaments);
      const emptyMain: MatBracketSummary = {
        tournament: { id: 1, type: "single_elimination", status: "completed", teamSize: 5 },
        totalRounds: 0,
        matches: []
      };
      const emptyWingman: MatBracketSummary = {
        tournament: { id: 2, type: "shuffle", status: "completed", teamSize: 2 },
        totalRounds: 0,
        matches: []
      };
      const [mainBracket, wingmanBracket] = await Promise.all([
        discovery.main ? this.mat.getBracketSummary(discovery.main.id) : emptyMain,
        discovery.wingman ? this.mat.getBracketSummary(discovery.wingman.id) : emptyWingman
      ]);
      const plans = planCsTournamentRooms(mainBracket, wingmanBracket, teams, participants);
      const summary: CsSyncSummary = {
        participantCount: participants.size,
        mainTeamRoomCount: plans.main.rooms.length,
        mainSkippedTeamCount: plans.main.skippedTeamCount,
        wingmanPairRoomCount: plans.wingman.rooms.length,
        wingmanSkippedPairCount: plans.wingman.skippedTeamCount,
        unmatchedParticipantCount: plans.main.unmatchedParticipantCount + plans.wingman.unmatchedParticipantCount,
        ambiguousSteamIdCount: Math.max(plans.main.ambiguousSteamIdCount, plans.wingman.ambiguousSteamIdCount),
        ambiguousMainTournamentCount: discovery.ambiguousMain,
        ambiguousWingmanTournamentCount: discovery.ambiguousWingman
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