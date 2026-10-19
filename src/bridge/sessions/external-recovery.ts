import type { CodexAppServerClient } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { createMessage } from "../messages/factory.js";
import { refreshAction } from "../messages/actions.js";
import { createSessionActionCallback } from "./action-callbacks.js";
import { SessionActivationError } from "./ownership.js";

/** A successful resume, not a read-only status, proves that the writer is available. */
export class ExternalSessionRecoveryService {
  private readonly probes = new Map<string, { version: number; result: Promise<number | null> }>();

  constructor(private readonly deps: {
    store: BridgeStore;
    codexClient: Pick<CodexAppServerClient, "readThreadStatus" | "resumeThread">;
    isRuntimeConnected: () => boolean;
    canReadThreadStatus: () => boolean;
    isBusy: (session: SessionRecord) => boolean;
    getSessionDirectory: (session: SessionRecord) => string;
    isActiveWriterConflictError: (error: unknown) => boolean;
  }) {}

  recover(session: SessionRecord): Promise<number | null> {
    const lease = this.deps.store.getSessionLease(session.id);
    if (lease?.state !== "external_unknown" || this.deps.isBusy(session) ||
        this.deps.store.hasPendingSessionWork(session.id)) return Promise.resolve(null);
    const pending = this.probes.get(session.id);
    if (pending) {
      // A newer lease must not start a second writer probe while the old RPC is in flight.
      return pending.version === lease.version ? pending.result : pending.result.then(() => null);
    }
    const result = this.probe(session, lease.version).finally(() => { this.probes.delete(session.id); });
    this.probes.set(session.id, { version: lease.version, result });
    return result;
  }

  private async probe(session: SessionRecord, version: number): Promise<number | null> {
    const directory = this.deps.getSessionDirectory(session);
    const isCurrent = () => this.deps.store.getSessionLease(session.id)?.version === version &&
      !this.deps.isBusy(session) && !this.deps.store.hasPendingSessionWork(session.id);
    try {
      if (!this.deps.isRuntimeConnected()) throw new Error("Codex runtime is disconnected.");
      if (!this.deps.canReadThreadStatus()) throw new Error("Codex thread status is unavailable.");
      const status = await this.deps.codexClient.readThreadStatus(session.codexThreadId, directory,
        { readOnly: true, timeoutMs: 5_000 });
      logger.info("bridge.session.external_probe", { sessionId: session.id, threadId: session.codexThreadId,
        activity: status.activity, activityType: status.activityType ?? null });
      if (!isCurrent() || status.activity !== "idle") return null;
      await this.deps.codexClient.resumeThread(session.codexThreadId, directory, () => {
        if (!isCurrent()) throw new Error("Session ownership changed during recovery.");
      }, 5_000);
      if (!isCurrent()) return null;
      const cleared = this.deps.store.clearSessionExternalUnknown(session.id, version);
      logger.info("bridge.session.external_lease_reconciled", { sessionId: session.id,
        threadId: session.codexThreadId, cleared, leaseVersion: version });
      return cleared ? version + 1 : null;
    } catch (error) {
      if (!isCurrent()) return null;
      const activeWriter = this.deps.isActiveWriterConflictError(error);
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("bridge.session.external_recovery_failed", { sessionId: session.id,
        threadId: session.codexThreadId, activeWriter, error: reason });
      if (activeWriter) return null;
      const failure = new SessionActivationError(createMessage({ kind: "error",
        session: { id: session.id, directory },
        body: [{ type: "text", text: `Session recovery failed: ${reason}` }],
        actions: [refreshAction(createSessionActionCallback("refresh", session.id, version))]
      }));
      failure.message = `Session recovery failed: ${reason}`;
      throw failure;
    }
  }
}
