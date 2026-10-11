import assert from "node:assert/strict";
import test from "node:test";

import { parseVerificationOptions, runVerification } from "../scripts/verify-codex/cli.js";
import { verifyProtocol } from "../scripts/verify-codex/scenarios/protocol.js";
import { verifyProviderSwitch } from "../scripts/verify-codex/scenarios/provider-switch.js";
import type { VerificationClient, VerificationOptions } from "../scripts/verify-codex/types.js";

const options: VerificationOptions = {
  scenario: "session-inventory",
  cwd: "/workspace/project",
  threadId: null,
  sourceId: null,
  refreshApplyMode: "none",
  refreshRepeatCount: 1,
  provider: null,
  json: false,
  verbose: false,
  maxSamples: 5
};

test("verification CLI parses bounded read-only options", () => {
  const parsed = parseVerificationOptions([
    "--scenario", "thread",
    "--cwd", "/workspace/project",
    "--thread-id", "thread-1",
    "--max-samples", "3",
    "--json"
  ]);
  assert.deepEqual(parsed, {
    scenario: "thread",
    cwd: "/workspace/project",
    threadId: "thread-1",
    sourceId: null,
    refreshApplyMode: "none",
    refreshRepeatCount: 1,
    provider: null,
    json: true,
    verbose: false,
    maxSamples: 3
  });
  assert.throws(() => parseVerificationOptions(["--max-samples", "21"]), /0 to 20/);
  assert.equal(parseVerificationOptions(["--scenario", "session-refresh", "--apply"]).refreshApplyMode, "sandbox");
  assert.equal(parseVerificationOptions(["--scenario", "session-refresh", "--repeat", "2"]).refreshRepeatCount, 2);
  assert.throws(() => parseVerificationOptions(["--apply", "--apply-production"]), /only one/);
  assert.throws(() => parseVerificationOptions(["--scenario", "session-refresh", "--repeat", "6"]), /1 to 5/);
  assert.equal(parseVerificationOptions(["--verbose"]).verbose, true);
});

test("session inventory validates native provider filtering without mutating Codex", async () => {
  const calls: string[] = [];
  const client = {
    readCodexConfigSnapshot: async () => ({
      cwd: options.cwd,
      model: "gpt-test",
      modelProvider: "codex-lb",
      reasoningEffort: "high",
      reasoningSummary: null,
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      serviceTier: null,
      personality: null,
      origins: { model_provider: { type: "user", version: null } },
      layerVersions: ["global"]
    }),
    listThreadsForCwd: async (_cwd?: string, listOptions?: { modelProviders?: string[] }) => {
      calls.push(`active:${listOptions?.modelProviders?.join(",") ?? "all"}`);
      return listOptions?.modelProviders
        ? [{ threadId: "lb", modelProvider: "codex-lb", modelProviderKnown: true, updatedAt: null, createdAt: null, name: null, preview: null, pathKey: null, currentCwd: options.cwd, archivedAt: null }]
        : [{ threadId: "openai", modelProvider: null, modelProviderKnown: false, updatedAt: null, createdAt: null, name: null, preview: null, pathKey: null, currentCwd: options.cwd, archivedAt: null }];
    },
    listArchivedThreadsForCwd: async (_cwd?: string, listOptions?: { modelProviders?: string[] }) => {
      calls.push(`archived:${listOptions?.modelProviders?.join(",") ?? "all"}`);
      return [];
    },
    readThreadStatus: async () => ({ modelProvider: "openai" })
  } as unknown as VerificationClient;

  const report = await runVerification(client, options);
  assert.equal(report.ok, true);
  assert.deepEqual(calls, ["active:all", "archived:all", "active:codex-lb", "archived:codex-lb"]);
  assert.deepEqual(report.data.providerFallbackSamples, [{ threadId: "openai", provider: "openai" }]);
});

test("protocol verification establishes its client before concurrent reads", async () => {
  let connected = false;
  let connectCalls = 0;
  const requireConnection = <T>(value: T): Promise<T> => {
    assert.equal(connected, true);
    return Promise.resolve(value);
  };
  const client = {
    connect: async () => {
      connectCalls += 1;
      connected = true;
    },
    readCodexConfigSnapshot: () => requireConnection({
      cwd: options.cwd,
      model: "gpt-test",
      modelProvider: null,
      reasoningEffort: null,
      reasoningSummary: null,
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      serviceTier: null,
      personality: null,
      origins: {},
      layerVersions: []
    }),
    listThreadsForCwd: () => requireConnection([]),
    listArchivedThreadsForCwd: () => requireConnection([]),
    listKnownMethods: () => []
  } as unknown as VerificationClient;

  const report = await verifyProtocol(client, { ...options, scenario: "protocol" });
  assert.equal(report.ok, true);
  assert.equal(connectCalls, 1);
});

test("provider verification normalizes the built-in default before asserting", async () => {
  const client = {
    readCodexConfigSnapshot: async () => ({
      cwd: options.cwd,
      model: "gpt-test",
      modelProvider: null,
      reasoningEffort: "high"
    })
  } as unknown as VerificationClient;

  const report = await verifyProviderSwitch(client, {
    ...options,
    scenario: "provider-switch",
    provider: "openai"
  });
  assert.equal(report.ok, true);
  assert.equal(report.data.configuredProvider, "built-in default");
  assert.equal(report.data.effectiveProvider, "openai");
});
