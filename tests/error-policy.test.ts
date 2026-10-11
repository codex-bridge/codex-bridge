import assert from "node:assert/strict";
import test from "node:test";
import { AppServerRpcError } from "../src/codex/app-server-connection.js";
import {
  extractRetryAfterSeconds,
  isActiveWriterConflictError,
  isIncompatibleHistoryError,
  isMissingRuntimeThreadError,
  isStaleActiveTurnError
} from "../src/codex/error-policy.js";

test("Codex error policy preserves recovery classifications", () => {
  assert.equal(isMissingRuntimeThreadError(new Error("404 thread not found")), true);
  assert.equal(isStaleActiveTurnError(new Error("expectedTurnId is stale")), true);
  assert.equal(isActiveWriterConflictError(new Error("already has an active writer")), true);
  assert.equal(extractRetryAfterSeconds("retry after 12 seconds"), 12);
  assert.equal(extractRetryAfterSeconds("unrelated"), 0);
});

test("RPC recovery errors respect the request method and do not infer from arbitrary prose", () => {
  assert.equal(isMissingRuntimeThreadError(new AppServerRpcError("thread/resume", {
    code: -32004, message: "thread not found: thread-1"
  })), true);
  assert.equal(isMissingRuntimeThreadError(new AppServerRpcError("account/read", {
    code: -32004, message: "thread not found: thread-1"
  })), false);
  assert.equal(isMissingRuntimeThreadError(new Error("account 404 while reading thread settings")), false);

  assert.equal(isStaleActiveTurnError(new AppServerRpcError("turn/steer", {
    code: -32602, message: "expectedTurnId is stale"
  })), true);
  assert.equal(isStaleActiveTurnError(new AppServerRpcError("turn/start", {
    code: -32602, message: "expectedTurnId is stale"
  })), false);
  assert.equal(isStaleActiveTurnError(new Error("other request mentions active turn")), false);

  assert.equal(isActiveWriterConflictError(new AppServerRpcError("thread/resume", {
    message: "thread thread-1 already has an active writer"
  })), true);
  assert.equal(isActiveWriterConflictError(new AppServerRpcError("account/read", {
    message: "thread thread-1 already has an active writer"
  })), false);
  assert.equal(isActiveWriterConflictError(new Error("someone quoted 'already has an active writer'")), false);
});

test("incompatible history auto-recovery uses one bounded compatibility signature", () => {
  const signature = "Invalid value for action.type. Supported values are: 'search', 'open_page', and 'find_in_page'";
  assert.equal(isIncompatibleHistoryError(signature), true);
  assert.equal(isIncompatibleHistoryError("Supported values are: 'search', 'open_page', and 'find_in_page'"), false);
  assert.equal(isIncompatibleHistoryError("action.type failed for another reason"), false);
  assert.equal(isIncompatibleHistoryError(`action.type ${"unrelated ".repeat(40)} Supported values are: 'search', 'open_page', and 'find_in_page'`), false);
});
