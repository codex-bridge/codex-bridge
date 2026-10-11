import type { AppServerThreadStatus, CodexAppServerClient } from "../../src/codex/client.js";
import type { CodexConfigSnapshot } from "../../src/codex/config-snapshot.js";
import type { ListedCodexThread, ThreadListOptions } from "../../src/codex/thread-list-api.js";

export const verificationScenarioNames = [
  "config",
  "session-inventory",
  "session-refresh",
  "thread",
  "provider-switch",
  "protocol"
] as const;

export type VerificationScenarioName = typeof verificationScenarioNames[number];

export type VerificationOptions = {
  scenario: VerificationScenarioName;
  cwd: string;
  threadId: string | null;
  sourceId: string | null;
  refreshApplyMode: "none" | "sandbox" | "production";
  refreshRepeatCount: number;
  provider: string | null;
  json: boolean;
  verbose: boolean;
  maxSamples: number;
};

export type VerificationCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type VerificationReport = {
  scenario: VerificationScenarioName;
  cwd: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  checks: VerificationCheck[];
  data: Record<string, unknown>;
};

export type VerificationClient = Pick<
  CodexAppServerClient,
  | "connect"
  | "readCodexConfigSnapshot"
  | "listThreadsForCwd"
  | "listArchivedThreadsForCwd"
  | "readThreadStatus"
  | "listKnownMethods"
>;

export type ThreadListCall = (
  cwd?: string,
  options?: Omit<ThreadListOptions, "archived">
) => Promise<ListedCodexThread[]>;

export type InventoryClient = Pick<VerificationClient, "readCodexConfigSnapshot" | "readThreadStatus"> & {
  listThreadsForCwd: ThreadListCall;
  listArchivedThreadsForCwd: ThreadListCall;
};

export type ThreadVerificationResult = Pick<
  AppServerThreadStatus,
  "threadId" | "cwd" | "model" | "modelProvider" | "reasoningEffort" | "activity" | "activityType"
>;

export type ConfigVerificationResult = Pick<
  CodexConfigSnapshot,
  "cwd" | "model" | "modelProvider" | "reasoningEffort" | "reasoningSummary" | "serviceTier" | "layerVersions"
>;
