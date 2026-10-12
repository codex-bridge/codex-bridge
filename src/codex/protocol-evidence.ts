import snapshot from "./protocol-evidence.generated.json" with { type: "json" };

export type ProtocolEvidenceSnapshot = {
  version: string;
  generatedAt: string;
  includesExperimental: boolean;
  schemaMethods: { request: string[]; serverRequest: string[]; notification: string[] };
  runtimeRequests: string[];
  productionReferences: Record<string, string[]>;
  liveVerification: Record<string, { version: string; verifiedAt: string; scenario: string }>;
};

export const APP_SERVER_PROTOCOL_EVIDENCE: ProtocolEvidenceSnapshot = snapshot;
export type ProtocolMethodEvidence = {
  baselineVersion: string;
  runtime: "listed" | "notListed" | "notChecked";
  generatedType: boolean;
  productionReferences: readonly string[];
  liveVerification: { version: string; verifiedAt: string; scenario: string } | null;
};

const generatedMethods = new Set(Object.values(snapshot.schemaMethods).flat());
const runtimeMethods = new Set<string>(snapshot.runtimeRequests);
const references: Record<string, string[]> = snapshot.productionReferences;
const verification: Record<string, NonNullable<ProtocolMethodEvidence["liveVerification"]>> = snapshot.liveVerification;

export function getProtocolMethodEvidence(method: string, kind: string): ProtocolMethodEvidence {
  return {
    baselineVersion: snapshot.version,
    runtime: kind === "request" ? runtimeMethods.has(method) ? "listed" : "notListed" : "notChecked",
    generatedType: generatedMethods.has(method),
    productionReferences: references[method] ?? [],
    liveVerification: verification[method] ?? null
  };
}
