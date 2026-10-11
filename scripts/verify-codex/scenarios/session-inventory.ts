import { createVerificationReport } from "../report.js";
import { resolveCodexProvider } from "../../../src/codex/provider.js";
import type { InventoryClient, VerificationOptions, VerificationReport } from "../types.js";

function countProviders(threads: Array<{ modelProvider: string | null }>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    const provider = thread.modelProvider ?? "unknown";
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export async function verifySessionInventory(
  client: InventoryClient,
  options: VerificationOptions
): Promise<VerificationReport> {
  const startedAt = Date.now();
  const snapshot = await client.readCodexConfigSnapshot(options.cwd);
  const provider = options.provider ?? resolveCodexProvider(snapshot.modelProvider);
  const active = await client.listThreadsForCwd(options.cwd);
  const archived = await client.listArchivedThreadsForCwd(options.cwd);
  const filteredActive = provider
    ? await client.listThreadsForCwd(options.cwd, { modelProviders: [provider] })
    : [];
  const filteredArchived = provider
    ? await client.listArchivedThreadsForCwd(options.cwd, { modelProviders: [provider] })
    : [];
  const sampledUnknowns = [...active, ...archived]
    .filter((thread) => !thread.modelProviderKnown)
    .slice(0, options.maxSamples);
  const sampledProviders = await Promise.all(sampledUnknowns.map(async (thread) => {
    const status = await client.readThreadStatus(thread.threadId, thread.currentCwd ?? options.cwd, {
      readOnly: true,
      timeoutMs: 3_000
    });
    return { threadId: thread.threadId, provider: status.modelProvider };
  }));
  const unexpected = provider
    ? [...filteredActive, ...filteredArchived].filter((thread) =>
      thread.modelProviderKnown && thread.modelProvider !== provider
    )
    : [];

  return createVerificationReport({
    scenario: "session-inventory",
    cwd: options.cwd,
    checks: [
      {
        name: "effective_provider",
        ok: true,
        detail: snapshot.modelProvider
          ? `Using ${provider} for native thread/list filtering.`
          : `Codex built-in default is normalized to ${provider} for native thread/list filtering.`
      },
      {
        name: "native_provider_filter",
        ok: unexpected.length === 0,
        detail: `${filteredActive.length} active and ${filteredArchived.length} archived threads returned.`
      },
      {
        name: "unknown_provider_samples",
        ok: sampledProviders.every((entry) => Boolean(entry.provider)),
        detail: sampledProviders.length > 0
          ? `${sampledProviders.filter((entry) => entry.provider).length}/${sampledProviders.length} thread/read samples resolved a provider.`
          : "No thread/list rows needed provider fallback sampling."
      }
    ],
    data: {
      configuredProvider: snapshot.modelProvider ?? "built-in default",
      effectiveProvider: provider,
      activeCount: active.length,
      archivedCount: archived.length,
      activeProviders: countProviders(active),
      archivedProviders: countProviders(archived),
      filteredActiveCount: filteredActive.length,
      filteredArchivedCount: filteredArchived.length,
      unexpectedFilteredThreadIds: unexpected.map((thread) => thread.threadId),
      providerFallbackSamples: sampledProviders
    }
  }, startedAt);
}
