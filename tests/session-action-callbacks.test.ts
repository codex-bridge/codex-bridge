import assert from "node:assert/strict";
import test from "node:test";

import { createSessionActionCallback, parseSessionActionCallback, type SessionActionCallbackKind } from "../src/bridge/sessions/action-callbacks.js";
import { parseApprovalInteractionAction, parseSessionInteractionAction } from "../src/bridge/interactions/action.js";
import { createBatchDecisionCallback } from "../src/bridge/decisions/action-callbacks.js";
import { parseSessionWorkflowAction } from "../src/slack/interactions/session-workflow.js";

const sessionId = "session_01234567-89ab-4cde-8fab-0123456789ab";
const cases: Array<[SessionActionCallbackKind, string, string]> = [
  ["handoff", "sh", "session-handoff"],
  ["releaseBridge", "sb", "session-release-bridge"],
  ["releaseCodex", "sc", "session-release-codex"],
  ["archive", "sa", "session-archive"],
  ["delete", "sd", "session-delete"],
  ["deleteConfirm", "sx", "session-delete-confirm"],
  ["refresh", "sr", "session-refresh"]
];

test("all session callbacks fit Telegram with full IDs and growing lease versions", () => {
  assert.equal(Buffer.byteLength(sessionId), 44);
  for (const [kind, prefix] of cases) {
    for (const version of [undefined, 9, 1123, 10000, Number.MAX_SAFE_INTEGER]) {
      const callback = createSessionActionCallback(kind, sessionId, version);
      assert.equal(callback, `${prefix}:${sessionId}${version === undefined ? "" : `:${version}`}`);
      assert.ok(Buffer.byteLength(callback) <= 64, `${kind} version ${version}`);
      assert.deepEqual(parseSessionActionCallback(callback), { kind, sessionId, expectedLeaseVersion: version });
    }
  }
});

test("compact and legacy session callbacks reach the same interaction handlers", () => {
  for (const [kind, prefix, legacy] of cases) {
    for (const version of [undefined, 1123]) {
      const suffix = `${sessionId}${version === undefined ? "" : `:${version}`}`;
      assert.deepEqual(parseSessionActionCallback(`${legacy}:${suffix}`), { kind, sessionId, expectedLeaseVersion: version });
      if (kind === "refresh") {
        assert.deepEqual(parseSessionWorkflowAction(`${prefix}:${suffix}`), {
          type: "session.refresh", sessionId, expectedLeaseVersion: version
        });
      } else {
        assert.deepEqual(parseSessionInteractionAction(`${prefix}:${suffix}`), parseSessionInteractionAction(`${legacy}:${suffix}`));
        assert.ok(parseSessionInteractionAction(`${prefix}:${suffix}`));
      }
    }
  }
});

test("malformed versions cannot silently bypass session lease guards", () => {
  for (const prefix of ["sh", "session-handoff", "sr", "session-refresh"]) {
    for (const version of ["", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1:extra"]) {
      assert.equal(parseSessionActionCallback(`${prefix}:${sessionId}:${version}`), null);
    }
    assert.equal(parseSessionActionCallback(`${prefix}::1`), null);
  }
  assert.throws(() => createSessionActionCallback("handoff", sessionId, -1));
  assert.throws(() => createSessionActionCallback("handoff", sessionId, Number.MAX_SAFE_INTEGER + 1));
});

test("batch approval callbacks fit Telegram and preserve ownership guards", () => {
  for (const [decision, code] of [["accept", "a"], ["decline", "d"], ["cancel", "c"]] as const) {
    for (const version of [1123, Number.MAX_SAFE_INTEGER]) {
      const callback = createBatchDecisionCallback(sessionId, version, decision);
      assert.equal(callback, `b${code}:${sessionId}:${version}`);
      assert.ok(Buffer.byteLength(callback) <= 64);
      assert.deepEqual(parseApprovalInteractionAction(callback), {
        type: "approval.batch.resolve", sessionId, expectedLeaseVersion: version, decision
      });
      assert.deepEqual(parseApprovalInteractionAction(callback),
        parseApprovalInteractionAction(`decision-batch:${sessionId}:${version}:${code}`));
    }
  }
  assert.equal(parseApprovalInteractionAction(`ba:${sessionId}:9007199254740992`), null);
});
