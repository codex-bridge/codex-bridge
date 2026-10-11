import { resolveCodexProvider } from "../../../src/codex/provider.js";
import { createVerificationReport } from "../report.js";
import type { VerificationClient, VerificationOptions, VerificationReport } from "../types.js";

export async function verifyProviderSwitch(
  client: Pick<VerificationClient, "readCodexConfigSnapshot">,
  options: VerificationOptions
): Promise<VerificationReport> {
  const startedAt = Date.now();
  const snapshot = await client.readCodexConfigSnapshot(options.cwd);
  const expectedProvider = options.provider;
  const effectiveProvider = resolveCodexProvider(snapshot.modelProvider);
  return createVerificationReport({
    scenario: "provider-switch",
    cwd: options.cwd,
    checks: [{
      name: "post_switch_config",
      ok: !expectedProvider || effectiveProvider === expectedProvider,
      detail: expectedProvider
        ? `Expected ${expectedProvider}; app-server resolved ${effectiveProvider}.`
        : `App-server resolved ${effectiveProvider}; pass --provider to assert a completed switch.`
    }],
    data: {
      configuredProvider: snapshot.modelProvider ?? "built-in default",
      effectiveProvider,
      model: snapshot.model,
      reasoning: snapshot.reasoningEffort,
      note: "This scenario does not modify config.toml. Run it after changing Codex configuration."
    }
  }, startedAt);
}
