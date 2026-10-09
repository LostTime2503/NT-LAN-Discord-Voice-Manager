import type { MatTournamentSummary } from "./matClient.js";

export type CsCompetition = "main" | "wingman";
export type TournamentDiscovery = {
  main?: MatTournamentSummary;
  wingman?: MatTournamentSummary;
  ambiguousMain: number;
  ambiguousWingman: number;
};

const activeStatuses = new Set(["active", "live", "in_progress", "ongoing", "running"]);

export function classifyCsTournamentFormat(tournament: MatTournamentSummary): CsCompetition | null {
  if (tournament.type === "shuffle" && tournament.teamSize === 2) return "wingman";
  if (tournament.type !== "shuffle" && tournament.teamSize === 5) return "main";
  return null;
}

export function classifyCsTournament(tournament: MatTournamentSummary): CsCompetition | null {
  return activeStatuses.has(tournament.status.toLowerCase()) ? classifyCsTournamentFormat(tournament) : null;
}

export function discoverActiveCsTournaments(tournaments: MatTournamentSummary[]): TournamentDiscovery {
  const main = tournaments.filter(tournament => classifyCsTournament(tournament) === "main");
  const wingman = tournaments.filter(tournament => classifyCsTournament(tournament) === "wingman");
  return {
    ...(main.length === 1 ? { main: main[0] } : {}),
    ...(wingman.length === 1 ? { wingman: wingman[0] } : {}),
    ambiguousMain: Math.max(0, main.length - 1),
    ambiguousWingman: Math.max(0, wingman.length - 1)
  };
}

export function classifyTournamentId(
  tournaments: MatTournamentSummary[],
  tournamentId: string
): CsCompetition | null {
  const tournament = tournaments.find(candidate => String(candidate.id) === tournamentId);
  return tournament ? classifyCsTournament(tournament) : null;
}