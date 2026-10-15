import assert from "node:assert/strict";
import test from "node:test";
import { sessionControls } from "../web/src/lib/session-controls.ts";
import type { SessionEntry } from "../web/src/lib/protocol.ts";
import type { WorkbenchState } from "../web/src/lib/workbench.ts";

const entry: SessionEntry = { threadId: "thread-a", sessionId: "session-a", name: "Project A",
  directory: "/projects/a", archived: false, updatedAt: null, provider: "example", connection: "active",
  capabilities: { releaseToCodex: true },
  ownership: { state: "active", ownerSourceId: "web:local", pendingSourceId: null, version: 2 } };

function stateFor(session: SessionEntry = entry, patch: Partial<WorkbenchState> = {}): WorkbenchState {
  return { connection: "connected", occupied: false, catalog: { directories: ["/projects/a"], sessions: session ? [session] : [] },
    catalogFresh: true, selected: "thread-a", viewableSessionId: "session-a", ready: true, loading: false,
    catalogError: null, operation: null, feedback: null, timelines: {}, drafts: {}, attachments: {}, queues: {}, ...patch };
}

test("selected session controls keep ownership, readiness, running and release capability independent", () => {
  assert.deepEqual(sessionControls(stateFor()), {
    showTools: true, toolsEnabled: true, compactEnabled: true, showInterrupt: false,
    showBind: false, bindEnabled: true, bindLabel: "Bind session", showCancel: false, cancelEnabled: true,
    showRelease: true, releaseEnabled: true
  });
  const running = sessionControls(stateFor({ ...entry, capabilities: { releaseToCodex: false } }, {
    queues: { "thread-a": { threadId: "thread-a", sessionId: "session-a", leaseVersion: 2, running: true, entries: [] } }
  }));
  assert.equal(running.showInterrupt, true);
  assert.equal(running.toolsEnabled, true);
  assert.equal(running.compactEnabled, false);
  assert.equal(running.releaseEnabled, false);
  assert.equal(sessionControls(stateFor(entry, { ready: false })).toolsEnabled, false);
  assert.equal(sessionControls(stateFor({ ...entry, capabilities: undefined })).releaseEnabled, false);
});

for (const patch of [
  { connection: "offline" }, { connection: "revoked" }, { connection: "connecting" }, { connection: "idle" },
  { catalogFresh: false }, { operation: { kind: "send", threadId: "other" } }
] satisfies Partial<WorkbenchState>[]) {
  test(`session controls disable mutations for ${JSON.stringify(patch)}`, () => {
    const controls = sessionControls(stateFor(entry, patch));
    for (const key of ["toolsEnabled", "compactEnabled", "bindEnabled", "cancelEnabled", "releaseEnabled"] as const)
      assert.equal(controls[key], false, key);
  });
}

test("waiting handoffs and external ownership retain explicit bind and cancel actions", () => {
  const external = { ...entry, ownership: { state: "handoff_pending", ownerSourceId: "slack:other",
    pendingSourceId: "web:local", version: 3 } };
  const controls = sessionControls(stateFor(external));
  assert.equal(controls.showBind, true);
  assert.equal(controls.bindLabel, "Request again");
  assert.equal(controls.bindEnabled, true);
  assert.equal(controls.showCancel, true);
  assert.equal(controls.cancelEnabled, true);
  assert.equal(controls.showTools, false);
  assert.equal(controls.releaseEnabled, false);
  assert.equal(sessionControls(stateFor(external, { operation: { kind: "binding", threadId: "thread-a" } })).bindLabel, "Working…");
  assert.equal(sessionControls(stateFor(external, { operation: { kind: "binding", threadId: "other" } })).bindLabel, "Request again");
  const handedOff = sessionControls(stateFor({ ...entry, ownership: { ...external.ownership, pendingSourceId: null } }));
  assert.equal(handedOff.showCancel, false);
  assert.equal(handedOff.showTools, false);
});

test("missing, archived and released sessions never retain interactive or release controls", () => {
  for (const session of [undefined, { ...entry, archived: true }, { ...entry, ownership: null }]) {
    const state = stateFor();
    state.catalog!.sessions = session ? [session] : [];
    const controls = sessionControls(state);
    assert.equal(controls.showTools, false);
    assert.equal(controls.toolsEnabled, false);
    assert.equal(controls.releaseEnabled, false);
    if (!session || session.archived) {
      assert.equal(controls.bindEnabled, false);
      assert.equal(controls.cancelEnabled, false);
      assert.equal(controls.showRelease, false);
    }
  }
});
