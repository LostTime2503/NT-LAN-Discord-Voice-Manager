import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCsTournament, classifyTournamentId, discoverActiveCsTournaments } from "../src/csTournamentDiscovery.js";
import type { MatTournamentSummary } from "../src/matClient.js";

const activeMain: MatTournamentSummary = { id: 12, type: "single_elimination", status: "active", teamSize: 5 };
const activeWingman: MatTournamentSummary = { id: 13, type: "shuffle", status: "active", teamSize: 2 };

test("discovers one active Main and Wingman by MAT format without configured IDs", () => {
  assert.deepEqual(discoverActiveCsTournaments([activeMain, activeWingman]), {
    main: activeMain,
    wingman: activeWingman,
    ambiguousMain: 0,
    ambiguousWingman: 0
  });
  assert.equal(classifyTournamentId([activeMain, activeWingman], "13"), "wingman");
});

test("does not choose arbitrarily if multiple active tournaments share a format", () => {
  const discovery = discoverActiveCsTournaments([
    activeMain,
    { ...activeMain, id: 14, type: "double_elimination" },
    activeWingman
  ]);
  assert.equal(discovery.main, undefined);
  assert.equal(discovery.ambiguousMain, 1);
  assert.equal(discovery.wingman?.id, activeWingman.id);
});

test("ignores inactive, unrelated, and unsupported tournament formats", () => {
  assert.equal(classifyCsTournament({ ...activeMain, status: "upcoming" }), null);
  assert.equal(classifyCsTournament({ ...activeMain, teamSize: 4 }), null);
  assert.equal(classifyCsTournament({ ...activeWingman, teamSize: 5 }), null);
  assert.deepEqual(discoverActiveCsTournaments([
    { ...activeMain, status: "upcoming" },
    { ...activeMain, id: 15, teamSize: 4 }
  ]), { ambiguousMain: 0, ambiguousWingman: 0 });
});