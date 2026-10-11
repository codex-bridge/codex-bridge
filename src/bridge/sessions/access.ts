import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";

export class SessionAccessError extends Error {
  constructor(readonly reason: "unavailable" | "not_owner" | "stale") {
    super(reason === "stale" ? "Session ownership changed. Refresh and try again."
      : reason === "not_owner" ? "Acquire this session before reading its conversation."
      : "Session is unavailable.");
  }
}

export type OwnedSessionAccess = {
  session: SessionRecord;
  leaseVersion: number;
  assertCurrent: () => void;
};

/** Checks existing ownership only; never registers, claims, selects or resumes. */
export class SessionAccessService {
  constructor(private readonly store: Pick<BridgeStore,
    "getSessionByThreadId" | "getSessionBinding" | "getSessionLease">) {}

  async requireOwned(threadId: string, sourceId: string, expectedVersion: number | undefined,
    assertRequestCurrent: () => void): Promise<OwnedSessionAccess> {
    assertRequestCurrent();
    const session = await this.store.getSessionByThreadId(threadId);
    assertRequestCurrent();
    if (!session || session.codexArchivedAt !== null) throw new SessionAccessError("unavailable");

    const check = (version: number | undefined): number => {
      assertRequestCurrent();
      const lease = this.store.getSessionLease(session.id);
      if (!lease || lease.state === "unbound") throw new SessionAccessError("not_owner");
      if (lease.state !== "active" && lease.state !== "handoff_pending") {
        throw new SessionAccessError("unavailable");
      }
      if (version !== undefined && lease.version !== version) throw new SessionAccessError("stale");
      const binding = this.store.getSessionBinding(session.id, sourceId);
      if (!binding || lease.ownerBindingId !== binding.id) throw new SessionAccessError("not_owner");
      return lease.version;
    };
    const leaseVersion = check(expectedVersion);
    return { session, leaseVersion, assertCurrent: () => { check(leaseVersion); } };
  }
}
