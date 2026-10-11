import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTurnConfigParams,
  extractCodexConfigSnapshot
} from "../src/codex/config-snapshot.js";

test("extracts the effective Codex config and maps workspace sandbox fields", () => {
  const snapshot = extractCodexConfigSnapshot({
    config: {
      model: "gpt-5.6-sol",
      model_provider: "codex-lb",
      model_reasoning_effort: "high",
      model_reasoning_summary: "concise",
      approval_policy: "on-request",
      approvals_reviewer: "auto_review",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: ["/project", 42],
        network_access: true,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: false
      },
      service_tier: "priority",
      personality: "pragmatic"
    },
    origins: {
      model: { name: { type: "project" }, version: "model-v1" }
    },
    layers: [{ version: "global-v1" }, { version: "project-v1" }]
  }, "/project");

  assert.deepEqual(snapshot, {
    cwd: "/project",
    model: "gpt-5.6-sol",
    modelProvider: "codex-lb",
    reasoningEffort: "high",
    reasoningSummary: "concise",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/project"],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: false
    },
    serviceTier: "priority",
    personality: "pragmatic",
    origins: {
      model: { type: "project", version: "model-v1" },
      model_provider: { type: null, version: null },
      model_reasoning_effort: { type: null, version: null },
      model_reasoning_summary: { type: null, version: null },
      approval_policy: { type: null, version: null },
      approvals_reviewer: { type: null, version: null },
      sandbox_mode: { type: null, version: null },
      sandbox_workspace_write: { type: null, version: null },
      service_tier: { type: null, version: null },
      personality: { type: null, version: null }
    },
    layerVersions: ["global-v1", "project-v1"]
  });
});

test("turn params omit unresolved optional values and never forward provider", () => {
  const snapshot = extractCodexConfigSnapshot({
    config: {
      model: "gpt-5.6-sol",
      model_provider: "codex-lb",
      sandbox_mode: "read-only"
    }
  }, "/project");

  assert.deepEqual(buildTurnConfigParams(snapshot), {
    model: "gpt-5.6-sol",
    sandboxPolicy: { type: "readOnly" }
  });
});

test("rejects incomplete config/read responses instead of using a Bridge fallback", () => {
  assert.throws(
    () => extractCodexConfigSnapshot({ config: {} }, "/project"),
    /did not resolve a model/
  );
  assert.throws(
    () => extractCodexConfigSnapshot({}, "/project"),
    /did not return config/
  );
});
