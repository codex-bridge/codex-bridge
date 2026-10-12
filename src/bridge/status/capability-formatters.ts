import type { CapabilityRead, ConfigRequirements, ProviderCapabilities, ServerDiagnostics } from "../../codex/runtime-capabilities.js";

const field = (key: string, value: string): string => `**${key}** ${value}`;
const flag = (value: boolean | null): string => value === null ? "unknown" : value ? "supported" : "not supported";

export function formatProviderCapabilities(result: CapabilityRead<ProviderCapabilities>): string[] {
  if (result.state !== "available") return [field("Configured provider capabilities", result.state)];
  return [field("Configured provider capabilities", `Image generation: ${flag(result.value.imageGeneration)} · Web search: ${flag(result.value.webSearch)}`)];
}

export function formatConfigRequirements(result: CapabilityRead<ConfigRequirements>, full: boolean): string[] {
  if (result.state !== "available") return [field("Managed policy", result.state)];
  const policy = result.value;
  if (!policy.configured) return [field("Managed policy", "none reported")];
  const lines = [field("Managed policy", "configured")];
  if (policy.modelProvider !== null) lines.push(field("Required provider", policy.modelProvider));
  for (const [label, values] of [
    ["Allowed approval policies", policy.allowedApprovalPolicies],
    ["Allowed reviewers", policy.allowedApprovalsReviewers],
    ["Allowed sandbox modes", policy.allowedSandboxModes],
    ["Allowed Web search", policy.allowedWebSearchModes]
  ] as const) {
    if (values !== null) lines.push(field(label, values.length ? values.join(", ") : "none allowed"));
  }
  const features = Object.entries(policy.featureRequirements).filter(([, enabled]) => full || !enabled);
  if (features.length) lines.push(field("Required features", features.map(([name, enabled]) => `${name}: ${enabled ? "enabled" : "disabled"}`).join(" · ")));
  return lines;
}

export function formatServerDiagnostics(result: CapabilityRead<ServerDiagnostics>, full: boolean): string[] {
  if (result.state !== "available") return [field("Process diagnostics", result.state)];
  const data = result.value;
  const lines = [field("Process", String(data.processId))];
  const memory = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (data.residentMemoryBytes !== null) lines.push(field("Resident memory", memory(data.residentMemoryBytes)));
  if (data.physicalFootprintBytes !== null) lines.push(field("Physical footprint", memory(data.physicalFootprintBytes)));
  if (full) for (const gauge of data.gauges) lines.push(field(gauge.name, String(gauge.value)));
  return lines;
}
