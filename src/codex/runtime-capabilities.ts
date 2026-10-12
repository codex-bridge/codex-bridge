import { AppServerRpcError } from "./app-server-connection.js";
import { asRecord } from "./protocol-utils.js";

export type CapabilityRead<T> =
  | { state: "available"; value: T }
  | { state: "unsupported" | "unavailable"; value: null };

export type ServerDiagnostics = {
  processId: number;
  residentMemoryBytes: number | null;
  physicalFootprintBytes: number | null;
  gauges: Array<{ name: string; value: number }>;
};

export type ProviderCapabilities = { imageGeneration: boolean | null; webSearch: boolean | null };
export type ConfigRequirements = {
  configured: boolean;
  modelProvider: string | null;
  allowedApprovalPolicies: string[] | null;
  allowedApprovalsReviewers: string[] | null;
  allowedSandboxModes: string[] | null;
  allowedWebSearchModes: string[] | null;
  featureRequirements: Record<string, boolean>;
};
export type RuntimeCapabilities = {
  diagnostics: CapabilityRead<ServerDiagnostics>;
  requirements: CapabilityRead<ConfigRequirements>;
  provider: CapabilityRead<ProviderCapabilities>;
};

type CapabilityMethod = "server/diagnostics" | "configRequirements/read" | "modelProvider/capabilities/read";
type Dependencies = {
  connect: () => Promise<void>;
  request: (method: CapabilityMethod, params: unknown, options: { timeoutMs: number }) => Promise<unknown>;
};

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const boolean = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const strings = (value: unknown): string[] | null => Array.isArray(value)
  && value.every((item) => typeof item === "string") ? value : null;

function approvalPolicies(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const policies: string[] = [];
  for (const policy of value) {
    if (typeof policy === "string") policies.push(policy);
    else {
      const granular = asRecord(asRecord(policy)?.granular);
      if (!granular || !Object.values(granular).every((entry) => typeof entry === "boolean")) return null;
      policies.push(`granular (${Object.entries(granular).map(([name, enabled]) => `${name}: ${enabled}`).join(", ")})`);
    }
  }
  return policies;
}

function diagnostics(payload: unknown): ServerDiagnostics {
  const result = asRecord(payload);
  const process = asRecord(result?.process);
  const processId = finiteNumber(process?.id);
  if (processId === null || !Array.isArray(result?.gauges)) throw new Error("Invalid diagnostics response");
  return {
    processId,
    residentMemoryBytes: finiteNumber(process?.residentMemoryBytes),
    physicalFootprintBytes: finiteNumber(process?.physicalFootprintBytes),
    gauges: result.gauges.flatMap((entry) => {
      const gauge = asRecord(entry);
      const value = finiteNumber(gauge?.value);
      return typeof gauge?.name === "string" && value !== null ? [{ name: gauge.name, value }] : [];
    })
  };
}

function requirements(payload: unknown): ConfigRequirements {
  const result = asRecord(payload);
  if (!result || !("requirements" in result)) throw new Error("Invalid requirements response");
  const policy = asRecord(result.requirements);
  if (!policy && result.requirements !== null) throw new Error("Invalid requirements response");
  // Only presentation-safe policy fields leave this boundary. Provider definitions
  // and developer instructions may contain credentials or private configuration.
  return {
    configured: policy !== null,
    modelProvider: typeof policy?.modelProvider === "string" ? policy.modelProvider : null,
    allowedApprovalPolicies: approvalPolicies(policy?.allowedApprovalPolicies),
    allowedApprovalsReviewers: strings(policy?.allowedApprovalsReviewers),
    allowedSandboxModes: strings(policy?.allowedSandboxModes),
    allowedWebSearchModes: strings(policy?.allowedWebSearchModes),
    featureRequirements: Object.fromEntries(Object.entries(asRecord(policy?.featureRequirements) ?? {})
      .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
  };
}

function provider(payload: unknown): ProviderCapabilities {
  const result = asRecord(payload);
  if (!result || !("imageGeneration" in result || "webSearch" in result)) throw new Error("Invalid provider capabilities response");
  return { imageGeneration: boolean(result.imageGeneration), webSearch: boolean(result.webSearch) };
}

/** Fresh, bounded reads; connection loss or an older CLI never implies false capabilities. */
export class CodexRuntimeCapabilitiesApi {
  constructor(private readonly deps: Dependencies) {}

  async read(): Promise<RuntimeCapabilities> {
    try {
      await this.deps.connect();
    } catch {
      const unavailable = { state: "unavailable", value: null } as const;
      return { diagnostics: unavailable, requirements: unavailable, provider: unavailable };
    }
    const [diagnosticResult, requirementsResult, providerResult] = await Promise.all([
      this.readOne("server/diagnostics", diagnostics),
      this.readOne("configRequirements/read", requirements),
      this.readOne("modelProvider/capabilities/read", provider)
    ]);
    return { diagnostics: diagnosticResult, requirements: requirementsResult, provider: providerResult };
  }

  private async readOne<T>(method: CapabilityMethod, parse: (payload: unknown) => T): Promise<CapabilityRead<T>> {
    try {
      return { state: "available", value: parse(await this.deps.request(method, {}, { timeoutMs: 3_000 })) };
    } catch (error) {
      return { state: error instanceof AppServerRpcError && error.code === -32601 ? "unsupported" : "unavailable", value: null };
    }
  }
}
