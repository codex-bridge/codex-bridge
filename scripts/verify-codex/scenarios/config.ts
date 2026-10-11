import { createVerificationReport } from "../report.js";
import type { VerificationClient, VerificationOptions, VerificationReport } from "../types.js";

export async function verifyConfig(
  client: Pick<VerificationClient, "readCodexConfigSnapshot">,
  options: VerificationOptions
): Promise<VerificationReport> {
  const startedAt = Date.now();
  const snapshot = await client.readCodexConfigSnapshot(options.cwd);
  const expectedProvider = options.provider;
  return createVerificationReport({
    scenario: "config",
    cwd: options.cwd,
    checks: [
      {
        name: "effective_config",
        ok: Boolean(snapshot.model),
        detail: snapshot.model ? "Codex returned an effective model." : "Codex did not return a model."
      },
      {
        name: "provider",
        ok: !expectedProvider || snapshot.modelProvider === expectedProvider,
        detail: expectedProvider
          ? `expected ${expectedProvider}, received ${snapshot.modelProvider ?? "built-in default"}.`
          : `received ${snapshot.modelProvider ?? "built-in default"}.`
      }
    ],
    data: {
      model: snapshot.model,
      provider: snapshot.modelProvider ?? "built-in default",
      reasoning: snapshot.reasoningEffort,
      summary: snapshot.reasoningSummary,
      serviceTier: snapshot.serviceTier,
      providerOrigin: snapshot.origins.model_provider?.type ?? null,
      configLayers: snapshot.layerVersions
    }
  }, startedAt);
}
