import { asRecord, firstString } from "./protocol-utils.js";

export type CodexConfigOrigin = {
  type: string | null;
  version: string | null;
};

export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly" }
  | {
    type: "workspaceWrite";
    writableRoots: string[];
    networkAccess: boolean;
    excludeTmpdirEnvVar: boolean;
    excludeSlashTmp: boolean;
  };

export interface CodexConfigSnapshot {
  cwd: string;
  model: string;
  modelProvider: string | null;
  reasoningEffort: string | null;
  reasoningSummary: string | null;
  approvalPolicy: unknown | null;
  approvalsReviewer: string | null;
  sandboxPolicy: CodexSandboxPolicy | null;
  serviceTier: string | null;
  personality: string | null;
  origins: Record<string, CodexConfigOrigin>;
  layerVersions: string[];
}

const SNAPSHOT_KEYS = [
  "model",
  "model_provider",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "approval_policy",
  "approvals_reviewer",
  "sandbox_mode",
  "sandbox_workspace_write",
  "service_tier",
  "personality"
] as const;

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function buildSandboxPolicy(config: Record<string, unknown>): CodexSandboxPolicy | null {
  const mode = firstString(config.sandbox_mode);
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly" };
  if (mode !== "workspace-write") return null;

  const workspace = asRecord(config.sandbox_workspace_write);
  return {
    type: "workspaceWrite",
    writableRoots: readStringArray(workspace?.writable_roots),
    networkAccess: workspace?.network_access === true,
    excludeTmpdirEnvVar: workspace?.exclude_tmpdir_env_var === true,
    excludeSlashTmp: workspace?.exclude_slash_tmp === true
  };
}

export function extractCodexConfigSnapshot(value: unknown, cwd: string): CodexConfigSnapshot {
  const result = asRecord(value);
  const config = asRecord(result?.config);
  if (!config) throw new Error("Codex config/read did not return config.");

  const model = firstString(config.model);
  if (!model) throw new Error("Codex effective config did not resolve a model.");

  const rawOrigins = asRecord(result?.origins);
  const origins = Object.fromEntries(SNAPSHOT_KEYS.map((key) => {
    const metadata = asRecord(rawOrigins?.[key]);
    const source = asRecord(metadata?.name);
    return [key, {
      type: firstString(source?.type, metadata?.type) ?? null,
      version: firstString(metadata?.version) ?? null
    }];
  }));
  const layers = Array.isArray(result?.layers) ? result.layers : [];

  return {
    cwd,
    model,
    modelProvider: firstString(config.model_provider) ?? null,
    reasoningEffort: firstString(config.model_reasoning_effort) ?? null,
    reasoningSummary: firstString(config.model_reasoning_summary) ?? null,
    approvalPolicy: config.approval_policy ?? null,
    approvalsReviewer: firstString(config.approvals_reviewer) ?? null,
    sandboxPolicy: buildSandboxPolicy(config),
    serviceTier: firstString(config.service_tier) ?? null,
    personality: firstString(config.personality) ?? null,
    origins,
    layerVersions: layers
      .map((layer) => firstString(asRecord(layer)?.version))
      .filter((version): version is string => Boolean(version))
  };
}

export function buildTurnConfigParams(snapshot: CodexConfigSnapshot): Record<string, unknown> {
  return {
    model: snapshot.model,
    ...(snapshot.reasoningEffort ? { effort: snapshot.reasoningEffort } : {}),
    ...(snapshot.reasoningSummary ? { summary: snapshot.reasoningSummary } : {}),
    ...(snapshot.approvalPolicy !== null ? { approvalPolicy: snapshot.approvalPolicy } : {}),
    ...(snapshot.approvalsReviewer ? { approvalsReviewer: snapshot.approvalsReviewer } : {}),
    ...(snapshot.sandboxPolicy ? { sandboxPolicy: snapshot.sandboxPolicy } : {}),
    ...(snapshot.serviceTier ? { serviceTier: snapshot.serviceTier } : {}),
    ...(snapshot.personality ? { personality: snapshot.personality } : {})
  };
}
