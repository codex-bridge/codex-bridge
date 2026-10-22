type BatchDecision = "accept" | "decline" | "cancel";

const CODE_BY_DECISION: Record<BatchDecision, string> = { accept: "a", decline: "d", cancel: "c" };

export function createBatchDecisionCallback(sessionId: string, leaseVersion: number, decision: BatchDecision): string {
  if (!sessionId || sessionId.includes(":")) throw new Error("Invalid batch callback session ID");
  if (!Number.isSafeInteger(leaseVersion) || leaseVersion < 0) throw new Error("Invalid batch callback lease version");
  return `b${CODE_BY_DECISION[decision]}:${sessionId}:${leaseVersion}`;
}

export function parseBatchDecisionCallback(value: string): {
  sessionId: string;
  expectedLeaseVersion: number;
  decision: BatchDecision;
} | null {
  const match = /^b([adc]):([^:]+):(\d+)$/.exec(value);
  if (!match) return null;
  const version = Number(match[3]);
  if (!Number.isSafeInteger(version)) return null;
  return {
    sessionId: match[2]!,
    expectedLeaseVersion: version,
    decision: match[1] === "a" ? "accept" : match[1] === "d" ? "decline" : "cancel"
  };
}
