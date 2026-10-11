import type { VerificationReport } from "./types.js";

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function createVerificationReport(
  input: Omit<VerificationReport, "startedAt" | "durationMs" | "ok">,
  startedAt: number
): VerificationReport {
  const durationMs = Math.max(0, Date.now() - startedAt);
  return {
    ...input,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    ok: input.checks.every((check) => check.ok)
  };
}

export function renderVerificationReport(report: VerificationReport): string {
  const lines = [
    `Scenario: ${report.scenario}`,
    `Cwd: ${report.cwd}`,
    `Result: ${report.ok ? "PASS" : "FAIL"}`,
    `Duration: ${report.durationMs}ms`,
    "",
    "Checks:"
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  if (Object.keys(report.data).length > 0) {
    lines.push("", "Data:");
    for (const [key, value] of Object.entries(report.data)) {
      lines.push(`- ${key}: ${formatValue(value)}`);
    }
  }
  return lines.join("\n");
}

export function formatVerificationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[_-]?key|token|authorization|cookie)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
