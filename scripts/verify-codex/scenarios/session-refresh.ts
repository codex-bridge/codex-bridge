import { probeSessionDiscoverability } from "../../../src/bridge/sessions/discovery-probe.js";
import type { BridgeStore } from "../../../src/store/index.js";
import { createVerificationReport } from "../report.js";
import type { InventoryClient, VerificationOptions, VerificationReport } from "../types.js";

type SessionRefreshState = "active" | "archived" | "readable_unlisted" | "missing" | "indeterminate";

export async function verifySessionRefresh(
  client: InventoryClient,
  options: VerificationOptions,
  store: Pick<BridgeStore, "listKnownSessions">
): Promise<VerificationReport> {
  if (!options.sourceId) throw new Error("--source is required for the session-refresh scenario.");
  const startedAt = Date.now();
  const knownSessions = await store.listKnownSessions(options.sourceId, { includeArchived: true });
  const activeThreads = await client.listThreadsForCwd();
  const archivedThreads = await client.listArchivedThreadsForCwd();
  const activeIds = new Set(activeThreads.map((thread) => thread.threadId));
  const archivedIds = new Set(archivedThreads.map((thread) => thread.threadId));
  const states = await Promise.all(knownSessions.map(async (session) => {
    const dbState = session.codexArchivedAt === null ? "active" : "archived";
    if (activeIds.has(session.codexThreadId)) {
      return { threadId: session.codexThreadId, dbState, state: "active" as const };
    }
    if (archivedIds.has(session.codexThreadId)) {
      return { threadId: session.codexThreadId, dbState, state: "archived" as const };
    }
    const probe = await probeSessionDiscoverability(client.readThreadStatus.bind(client), session);
    return {
      threadId: session.codexThreadId,
      dbState,
      state: probe.state === "readable" ? "readable_unlisted" : probe.state,
      ...(probe.state === "readable" ? {} : { error: probe.error })
    };
  }));
  const count = (state: SessionRefreshState) => states.filter((entry) => entry.state === state).length;
  const stateMismatches = states.filter((entry) =>
    (entry.state === "active" && entry.dbState !== "active") ||
    (entry.state === "archived" && entry.dbState !== "archived")
  );
  const missing = states.filter((entry) => entry.state === "missing");
  const indeterminate = states.filter((entry) => entry.state === "indeterminate");

  return createVerificationReport({
    scenario: "session-refresh",
    cwd: options.cwd,
    checks: [
      { name: "inventory", ok: true, detail: `${activeThreads.length} active and ${archivedThreads.length} archived threads returned.` },
      { name: "state_reconciliation", ok: stateMismatches.length === 0, detail: stateMismatches.length === 0 ? "Known session states match Codex inventory." : `${stateMismatches.length} known sessions need state reconciliation.` },
      { name: "unlisted_sessions", ok: missing.length === 0 && indeterminate.length === 0, detail: `${count("readable_unlisted")} readable but unlisted; ${missing.length} confirmed missing; ${indeterminate.length} indeterminate.` }
    ],
    data: {
      source: options.sourceId,
      knownSessions: knownSessions.length,
      active: count("active"),
      archived: count("archived"),
      readableUnlisted: count("readable_unlisted"),
      missing: missing.map((entry) => entry.threadId),
      indeterminate: indeterminate.map((entry) => ({ threadId: entry.threadId, error: entry.error })),
      stateMismatches: stateMismatches.map((entry) => entry.threadId)
    }
  }, startedAt);
}
