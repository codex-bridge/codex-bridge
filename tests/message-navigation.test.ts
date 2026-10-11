import assert from "node:assert/strict";
import test from "node:test";

import { helpMenuActions } from "../src/bridge/messages/actions.js";
import { parseGoalNavigation, parseStatusNavigation } from "../src/bridge/messages/navigation.js";

test("Help exposes only feature entry actions in stable groups", () => {
  const actions = helpMenuActions({ hasActiveSession: true, runtimeConnected: true });
  assert.deepEqual(actions.map(({ label, callback, group }) => ({ label, callback, group })), [
    { label: "Session", callback: "quick:sessions", group: "Session" },
    { label: "Status", callback: "quick:status", group: "Session" },
    { label: "Goal", callback: "quick:goal", group: "Run" },
    { label: "Compact", callback: "quick:compact", group: "Run" },
    { label: "Disconnect", callback: "quick:bot_disconnect", group: "Bot" },
    { label: "Restart", callback: "quick:bot_restart", group: "Bot" }
  ]);
});

test("Help exposes Connect only while the runtime is disconnected", () => {
  const actions = helpMenuActions({ runtimeConnected: false });
  assert.deepEqual(
    actions.filter((action) => action.group === "Bot").map((action) => action.label),
    ["Connect", "Restart"]
  );
});

test("Help exposes Queue and Interrupt only while a session is active", () => {
  const actions = helpMenuActions({
    hasActiveSession: true,
    hasActiveTurn: true,
    runtimeConnected: true
  });
  assert.deepEqual(
    actions.filter((action) => action.group === "Run").map((action) => action.label),
    ["Goal", "Queue", "Interrupt"]
  );
});

test("Goal entry actions send while internal navigation edits", () => {
  assert.deepEqual(parseGoalNavigation("quick:goal"), { delivery: "send", view: "current", page: 0 });
  assert.deepEqual(parseGoalNavigation("quick:goals"), { delivery: "send", view: "list", page: 0 });
  assert.deepEqual(parseGoalNavigation("goal:current"), { delivery: "edit", view: "current", page: 0 });
  assert.deepEqual(parseGoalNavigation("goal-page:2"), { delivery: "edit", view: "list", page: 2 });
  assert.deepEqual(parseGoalNavigation("goal-page:bad"), { delivery: "edit", view: "list", page: 0 });
  assert.equal(parseGoalNavigation("goal:view:session"), null);
});

test("Status entry actions send while internal navigation edits", () => {
  assert.deepEqual(parseStatusNavigation("quick:status"), { delivery: "send", full: false });
  assert.deepEqual(parseStatusNavigation("quick:status_full"), { delivery: "send", full: true });
  assert.deepEqual(parseStatusNavigation("status:view:basic"), { delivery: "edit", full: false });
  assert.deepEqual(parseStatusNavigation("status:view:full"), { delivery: "edit", full: true });
  assert.equal(parseStatusNavigation("quick:help"), null);
});
