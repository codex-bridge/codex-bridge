import crypto from "node:crypto";

import Database from "better-sqlite3";

import { parseSourceAddress } from "../shared/source-address.js";
import { recordSessionSelection } from "./session-selection.js";
import type {
  SessionBindingRecord,
  SessionLeaseRecord,
  SessionLeaseState
} from "../shared/types.js";

type BindingRow = {
  id: string;
  session_id: string;
  platform: SessionBindingRecord["platform"];
  bot_key: string;
  source_id: string;
  channel_id: string | null;
  thread_id: string | null;
  created_at: number;
  updated_at: number;
};

type LeaseRow = {
  session_id: string;
  state: SessionLeaseState;
  owner_binding_id: string | null;
  pending_binding_id: string | null;
  owner_turn_id: string | null;
  version: number;
  updated_at: number;
};

export interface SessionOwnershipResult {
  owned: boolean;
  binding: SessionBindingRecord;
  lease: SessionLeaseRecord;
  reason: "claimed" | "already_owned" | "owned_by_other" | "unavailable";
}

export type SessionHandoffResult = Omit<SessionOwnershipResult, "reason"> & {
  reason: SessionOwnershipResult["reason"] | "stale";
  pending: boolean;
  previousOwnerSourceId: string | null;
  replacedSourceId: string | null;
};

export type SessionHandoffCancellation = {
  cancelled: boolean;
  lease: SessionLeaseRecord | null;
  reason: "cancelled" | "not_pending" | "stale";
};

export type SessionReleaseResult = {
  released: boolean;
  lease: SessionLeaseRecord;
  reason: "released" | "not_owner" | "busy" | "unavailable" | "stale";
};

export type SessionReleaseTransitionResult = {
  started: boolean;
  lease: SessionLeaseRecord;
  reason: "started" | "not_owner" | "busy" | "unavailable" | "stale";
};

function now(): number {
  return Date.now();
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function asBindingRecord(row: BindingRow): SessionBindingRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    platform: row.platform,
    botKey: row.bot_key,
    sourceId: row.source_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function asLeaseRecord(row: LeaseRow): SessionLeaseRecord {
  return {
    sessionId: row.session_id,
    state: row.state,
    ownerBindingId: row.owner_binding_id,
    pendingBindingId: row.pending_binding_id,
    ownerTurnId: row.owner_turn_id,
    version: row.version,
    updatedAt: row.updated_at
  };
}

export class SessionBindingRepository {
  constructor(private readonly sqlite: InstanceType<typeof Database>) {}

  ensureBinding(sessionId: string, sourceId: string): SessionBindingRecord {
    const existing = this.sqlite.prepare(`
      SELECT * FROM session_bindings WHERE session_id = ? AND source_id = ?
    `).get(sessionId, sourceId) as BindingRow | undefined;
    if (existing) return asBindingRecord(existing);

    const source = parseSourceAddress(sourceId);
    const timestamp = now();
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO session_bindings (
        id, session_id, platform, bot_key, source_id, channel_id, thread_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId("binding"),
      sessionId,
      source.platform,
      source.botKey,
      sourceId,
      source.channelId,
      source.threadId,
      timestamp,
      timestamp
    );
    const row = this.sqlite.prepare(`
      SELECT * FROM session_bindings WHERE session_id = ? AND source_id = ?
    `).get(sessionId, sourceId) as BindingRow | undefined;
    if (!row) throw new Error(`Unable to create session binding: ${sessionId}/${sourceId}`);
    return asBindingRecord(row);
  }

  getBinding(sessionId: string, sourceId: string): SessionBindingRecord | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM session_bindings WHERE session_id = ? AND source_id = ?
    `).get(sessionId, sourceId) as BindingRow | undefined;
    return row ? asBindingRecord(row) : null;
  }

  getBindingById(bindingId: string): SessionBindingRecord | null {
    const row = this.sqlite.prepare(`SELECT * FROM session_bindings WHERE id = ?`).get(bindingId) as BindingRow | undefined;
    return row ? asBindingRecord(row) : null;
  }

  listBindings(sessionId: string): SessionBindingRecord[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM session_bindings WHERE session_id = ? ORDER BY updated_at DESC, id
    `).all(sessionId) as BindingRow[];
    return rows.map(asBindingRecord);
  }

  getLease(sessionId: string): SessionLeaseRecord | null {
    const row = this.sqlite.prepare(`SELECT * FROM session_leases WHERE session_id = ?`).get(sessionId) as LeaseRow | undefined;
    return row ? asLeaseRecord(row) : null;
  }

  ensureLease(sessionId: string): SessionLeaseRecord {
    const timestamp = now();
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO session_leases (
        session_id, state, owner_binding_id, pending_binding_id, owner_turn_id, version, updated_at
      ) VALUES (?, 'unbound', NULL, NULL, NULL, 0, ?)
    `).run(sessionId, timestamp);
    const lease = this.getLease(sessionId);
    if (!lease) throw new Error(`Unable to create session lease: ${sessionId}`);
    return lease;
  }

  claim(sessionId: string, sourceId: string): SessionOwnershipResult {
    const claim = this.sqlite.transaction(() => {
      const binding = this.ensureBinding(sessionId, sourceId);
      const lease = this.ensureLease(sessionId);
      if (lease.state === "active" && lease.ownerBindingId === binding.id) {
        return { owned: true, binding, lease, reason: "already_owned" } satisfies SessionOwnershipResult;
      }
      if (lease.state !== "unbound") {
        return {
          owned: false,
          binding,
          lease,
          reason: lease.state === "active" ? "owned_by_other" : "unavailable"
        } satisfies SessionOwnershipResult;
      }

      const timestamp = now();
      const result = this.sqlite.prepare(`
        UPDATE session_leases
        SET state = 'active', owner_binding_id = ?, pending_binding_id = NULL,
          owner_turn_id = NULL, version = version + 1, updated_at = ?
        WHERE session_id = ? AND state = 'unbound' AND version = ?
      `).run(binding.id, timestamp, sessionId, lease.version);
      if (result.changes !== 1) {
        const current = this.getLease(sessionId);
        if (!current) throw new Error(`Session lease disappeared: ${sessionId}`);
        return {
          owned: false,
          binding,
          lease: current,
          reason: current.state === "active" ? "owned_by_other" : "unavailable"
        } satisfies SessionOwnershipResult;
      }
      const claimedLease = this.getLease(sessionId);
      if (!claimedLease) throw new Error(`Session lease disappeared after claim: ${sessionId}`);
      return { owned: true, binding, lease: claimedLease, reason: "claimed" } satisfies SessionOwnershipResult;
    }).immediate();
    if (claim.owned) {
      this.sqlite.prepare(`UPDATE sessions SET telegram_chat_id = ?, updated_at = ? WHERE id = ?`)
        .run(sourceId, now(), sessionId);
    }
    return claim;
  }

  /** Persisted blockers are checked inside the ownership transaction, not across awaits. */
  hasPendingWork(sessionId: string): boolean {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM decisions WHERE session_id = ? AND state IN ('pending', 'awaitingInput') LIMIT 1
    `).get(sessionId)) || Boolean(this.sqlite.prepare(`
      SELECT 1 FROM queued_submissions q JOIN sessions s ON s.codex_thread_id = q.codex_thread_id
      WHERE s.id = ? AND q.state IN ('submitting', 'queued', 'unknown') LIMIT 1
    `).get(sessionId)) || Boolean(this.sqlite.prepare(`
      SELECT 1 FROM turn_routes r JOIN sessions s ON s.codex_thread_id = r.codex_thread_id
      WHERE s.id = ? AND r.state = 'active' LIMIT 1
    `).get(sessionId));
  }

  requestHandoff(sessionId: string, sourceId: string, transferNow: boolean, expectedVersion?: number, select = false): SessionHandoffResult {
    const result = this.sqlite.transaction(() => {
      const outcome = this.requestHandoffCurrent(sessionId, sourceId, transferNow, expectedVersion);
      if (select && (outcome.owned || outcome.pending)) recordSessionSelection(this.sqlite, sourceId, sessionId);
      return outcome;
    }).immediate();
    if (result.owned) {
      this.sqlite.prepare(`UPDATE sessions SET telegram_chat_id = ?, updated_at = ? WHERE id = ?`)
        .run(sourceId, now(), sessionId);
    }
    return result;
  }

  private requestHandoffCurrent(sessionId: string, sourceId: string, transferNow: boolean, expectedVersion?: number): SessionHandoffResult {
    const binding = this.ensureBinding(sessionId, sourceId);
    const lease = this.ensureLease(sessionId);
    const previousOwnerSourceId = lease.ownerBindingId ? this.getBindingById(lease.ownerBindingId)?.sourceId ?? null : null;
    const pendingSourceId = lease.pendingBindingId ? this.getBindingById(lease.pendingBindingId)?.sourceId ?? null : null;
    const unchanged = { previousOwnerSourceId, replacedSourceId: null };
    if (expectedVersion !== undefined && lease.version !== expectedVersion) {
      return { owned: false, binding, lease, reason: "stale", pending: false, ...unchanged } satisfies SessionHandoffResult;
    }
    if ((lease.state === "active" || lease.state === "handoff_pending") && lease.ownerBindingId === binding.id) {
      return { owned: true, binding, lease, reason: "already_owned", pending: false, ...unchanged } satisfies SessionHandoffResult;
    }
    transferNow = transferNow && !lease.ownerTurnId && !this.hasPendingWork(sessionId);
    if (lease.state === "unbound") {
      // An unbound session with accepted work cannot safely acquire a new owner.
      if (!transferNow) return { owned: false, binding, lease, reason: "unavailable", pending: false, ...unchanged } satisfies SessionHandoffResult;
      const timestamp = now();
      this.sqlite.prepare(`
        UPDATE session_leases
        SET state = 'active', owner_binding_id = ?, pending_binding_id = NULL,
          owner_turn_id = NULL, version = version + 1, updated_at = ?
        WHERE session_id = ? AND state = 'unbound' AND version = ?
      `).run(binding.id, timestamp, sessionId, lease.version);
      const claimedLease = this.getLease(sessionId);
      if (!claimedLease) throw new Error(`Session lease disappeared after handoff: ${sessionId}`);
      return { owned: true, binding, lease: claimedLease, reason: "claimed", pending: false, ...unchanged } satisfies SessionHandoffResult;
    }
    if (lease.state !== "active" && lease.state !== "handoff_pending") {
      return { owned: false, binding, lease, reason: "unavailable", pending: false, ...unchanged } satisfies SessionHandoffResult;
    }

    const timestamp = now();
    if (transferNow) {
      this.sqlite.prepare(`
        UPDATE session_leases
        SET state = 'active', owner_binding_id = ?, pending_binding_id = NULL,
          owner_turn_id = NULL, version = version + 1, updated_at = ?
        WHERE session_id = ? AND owner_binding_id IS NOT NULL
      `).run(binding.id, timestamp, sessionId);
    } else {
      this.sqlite.prepare(`
        UPDATE session_leases
        SET state = 'handoff_pending', pending_binding_id = ?, version = version + 1, updated_at = ?
        WHERE session_id = ? AND owner_binding_id IS NOT NULL
      `).run(binding.id, timestamp, sessionId);
    }
    const updatedLease = this.getLease(sessionId);
    if (!updatedLease) throw new Error(`Session lease disappeared after handoff request: ${sessionId}`);
    return {
      owned: transferNow,
      binding,
      lease: updatedLease,
      reason: transferNow ? "claimed" : "owned_by_other",
      pending: !transferNow,
      previousOwnerSourceId,
      replacedSourceId: pendingSourceId && pendingSourceId !== sourceId ? pendingSourceId : null
    } satisfies SessionHandoffResult;
  }

  cancelHandoff(sessionId: string, sourceId: string, expectedVersion?: number): SessionHandoffCancellation {
    return this.sqlite.transaction(() => {
      const lease = this.getLease(sessionId);
      if (expectedVersion !== undefined && lease?.version !== expectedVersion) return { cancelled: false, lease, reason: "stale" } as const;
      const binding = this.getBinding(sessionId, sourceId);
      if (!lease || lease.state !== "handoff_pending" || !binding || lease.pendingBindingId !== binding.id) {
        return { cancelled: false, lease, reason: "not_pending" } as const;
      }
      this.sqlite.prepare(`UPDATE session_leases SET state = 'active', pending_binding_id = NULL,
        version = version + 1, updated_at = ? WHERE session_id = ? AND version = ?
      `).run(now(), sessionId, lease.version);
      return { cancelled: true, lease: this.getLease(sessionId), reason: "cancelled" } as const;
    }).immediate();
  }

  markExternalUnknown(sessionId: string): SessionLeaseRecord {
    this.ensureLease(sessionId);
    this.sqlite.prepare(`
      UPDATE session_leases
      SET state = 'external_unknown', owner_binding_id = NULL, pending_binding_id = NULL,
        owner_turn_id = NULL, version = version + 1, updated_at = ?
      WHERE session_id = ?
    `).run(now(), sessionId);
    const updated = this.getLease(sessionId);
    if (!updated) throw new Error(`Session lease disappeared after external lock update: ${sessionId}`);
    return updated;
  }

  clearExternalUnknown(sessionId: string): boolean {
    const result = this.sqlite.prepare(`
      UPDATE session_leases
      SET state = 'unbound', owner_binding_id = NULL, pending_binding_id = NULL,
        owner_turn_id = NULL, version = version + 1, updated_at = ?
      WHERE session_id = ? AND state = 'external_unknown'
    `).run(now(), sessionId);
    return result.changes === 1;
  }

  releaseBridgeLock(sessionId: string, sourceId: string, expectedVersion?: number): SessionReleaseResult {
    return this.sqlite.transaction(() => {
      const binding = this.getBinding(sessionId, sourceId);
      const lease = this.ensureLease(sessionId);
      if (expectedVersion !== undefined && lease.version !== expectedVersion) {
        return { released: false, lease, reason: "stale" } as const;
      }
      if (lease.state !== "active" && lease.state !== "handoff_pending") {
        return { released: false, lease, reason: "unavailable" } as const;
      }
      if (!binding || lease.ownerBindingId !== binding.id) {
        return { released: false, lease, reason: "not_owner" } as const;
      }
      if (lease.pendingBindingId || lease.ownerTurnId || this.hasPendingWork(sessionId)) {
        return { released: false, lease, reason: "busy" } as const;
      }
      this.sqlite.prepare(`
        UPDATE session_leases
        SET state = 'unbound', owner_binding_id = NULL, pending_binding_id = NULL,
          owner_turn_id = NULL, version = version + 1, updated_at = ?
        WHERE session_id = ? AND owner_binding_id = ? AND version = ?
      `).run(now(), sessionId, binding.id, lease.version);
      const updated = this.getLease(sessionId);
      if (!updated) throw new Error(`Session lease disappeared after release: ${sessionId}`);
      return {
        released: updated.state === "unbound" && updated.ownerBindingId === null,
        lease: updated,
        reason: updated.state === "unbound" ? "released" : "busy"
      } as const;
    }).immediate();
  }

  beginBridgeRelease(sessionId: string, sourceId: string, expectedVersion?: number): SessionReleaseTransitionResult {
    return this.sqlite.transaction(() => {
      const binding = this.getBinding(sessionId, sourceId);
      const lease = this.ensureLease(sessionId);
      if (expectedVersion !== undefined && lease.version !== expectedVersion) {
        return { started: false, lease, reason: "stale" } as const;
      }
      if (lease.state !== "active" && lease.state !== "handoff_pending") {
        return { started: false, lease, reason: "unavailable" } as const;
      }
      if (!binding || lease.ownerBindingId !== binding.id) {
        return { started: false, lease, reason: "not_owner" } as const;
      }
      if (lease.pendingBindingId || lease.ownerTurnId || this.hasPendingWork(sessionId)) {
        return { started: false, lease, reason: "busy" } as const;
      }
      const result = this.sqlite.prepare(`
        UPDATE session_leases
        SET state = 'releasing', version = version + 1, updated_at = ?
        WHERE session_id = ? AND owner_binding_id = ? AND version = ?
      `).run(now(), sessionId, binding.id, lease.version);
      const updated = this.getLease(sessionId);
      if (!updated) throw new Error(`Session lease disappeared while starting release: ${sessionId}`);
      return result.changes === 1
        ? { started: true, lease: updated, reason: "started" } as const
        : { started: false, lease: updated, reason: "busy" } as const;
    }).immediate();
  }

  finishBridgeRelease(sessionId: string, expectedVersion: number, released: boolean): SessionLeaseRecord | null {
    return this.sqlite.transaction(() => {
      const lease = this.getLease(sessionId);
      if (!lease || lease.state !== "releasing" || !lease.ownerBindingId || lease.version !== expectedVersion) {
        return null;
      }
      const result = this.sqlite.prepare(`
        UPDATE session_leases
        SET state = ?, owner_binding_id = ?, pending_binding_id = NULL, owner_turn_id = NULL,
          version = version + 1, updated_at = ?
        WHERE session_id = ? AND state = 'releasing' AND owner_binding_id = ? AND version = ?
      `).run(released ? "unbound" : "active", released ? null : lease.ownerBindingId, now(),
        sessionId, lease.ownerBindingId, lease.version);
      return result.changes === 1 ? this.getLease(sessionId) : null;
    }).immediate();
  }

  releaseStaleBridgeLock(sessionId: string, expectedVersion: number): boolean {
    // A pending application is not an expired lock; never silently discard it.
    if (this.getLease(sessionId)?.state === "handoff_pending" || this.hasPendingWork(sessionId)) return false;
    const result = this.sqlite.prepare(`
      UPDATE session_leases
      SET state = 'unbound', owner_binding_id = NULL, pending_binding_id = NULL,
        owner_turn_id = NULL, version = version + 1, updated_at = ?
      WHERE session_id = ?
        AND state IN ('active', 'handoff_pending')
        AND owner_turn_id IS NULL
        AND version = ?
    `).run(now(), sessionId, expectedVersion);
    return result.changes === 1;
  }

  releaseBridgeLocksAfterAuthChange(): number {
    const result = this.sqlite.prepare(`
      UPDATE session_leases
      SET state = 'unbound', owner_binding_id = NULL, pending_binding_id = NULL,
        owner_turn_id = NULL, version = version + 1, updated_at = ?
      WHERE state IN ('active', 'handoff_pending')
    `).run(now());
    return result.changes;
  }

  beginCodexRelease(sessionId: string, expectedVersion?: number): SessionLeaseRecord | null {
    const lease = this.ensureLease(sessionId);
    if (lease.state !== "external_unknown" || (expectedVersion !== undefined && lease.version !== expectedVersion)) {
      return null;
    }
    this.sqlite.prepare(`
      UPDATE session_leases
      SET state = 'releasing', version = version + 1, updated_at = ?
      WHERE session_id = ? AND state = 'external_unknown' AND version = ?
    `).run(now(), sessionId, lease.version);
    return this.getLease(sessionId);
  }

  finishCodexRelease(sessionId: string, recovered: boolean): SessionLeaseRecord | null {
    const lease = this.getLease(sessionId);
    if (!lease || lease.state !== "releasing") return lease;
    this.sqlite.prepare(`
      UPDATE session_leases
      SET state = ?, owner_binding_id = NULL, pending_binding_id = NULL, owner_turn_id = NULL,
        version = version + 1, updated_at = ?
      WHERE session_id = ? AND state = 'releasing'
    `).run(recovered ? "unbound" : "external_unknown", now(), sessionId);
    return this.getLease(sessionId);
  }

  promotePending(sessionId: string, expectedTurnId?: string | null): SessionLeaseRecord | null {
    const result = this.sqlite.transaction(() => {
      const lease = this.getLease(sessionId);
      if (!lease || lease.state !== "handoff_pending" || !lease.pendingBindingId) return null;
      if (expectedTurnId !== undefined && lease.ownerTurnId !== expectedTurnId) return null;
      if (lease.ownerTurnId || this.hasPendingWork(sessionId)) return null;
      const binding = this.getBindingById(lease.pendingBindingId);
      if (!binding) return null;
      const selection = this.sqlite.prepare("SELECT active_session_id FROM chats WHERE telegram_chat_id = ?")
        .get(binding.sourceId) as { active_session_id: string | null } | undefined;
      if (selection?.active_session_id && selection.active_session_id !== sessionId) {
        this.cancelHandoff(sessionId, binding.sourceId, lease.version);
        return null;
      }
      this.sqlite.prepare(`
        UPDATE session_leases
        SET state = 'active', owner_binding_id = ?, pending_binding_id = NULL, owner_turn_id = NULL,
          version = version + 1, updated_at = ?
        WHERE session_id = ? AND state = 'handoff_pending' AND pending_binding_id = ?
      `).run(binding.id, now(), sessionId, binding.id);
      return this.getLease(sessionId);
    }).immediate();
    if (result) {
      const binding = result.ownerBindingId ? this.getBindingById(result.ownerBindingId) : null;
      if (binding) {
        this.sqlite.prepare(`UPDATE sessions SET telegram_chat_id = ?, updated_at = ? WHERE id = ?`)
          .run(binding.sourceId, now(), sessionId);
      }
    }
    return result;
  }

  setOwnerTurn(sessionId: string, sourceId: string, turnId: string): boolean {
    const binding = this.getBinding(sessionId, sourceId);
    if (!binding) return false;
    const result = this.sqlite.prepare(`
      UPDATE session_leases
      SET owner_turn_id = ?, version = version + 1, updated_at = ?
      WHERE session_id = ? AND state = 'active' AND owner_binding_id = ?
    `).run(turnId, now(), sessionId, binding.id);
    return result.changes === 1;
  }

  clearOwnerTurn(sessionId: string, turnId: string): boolean {
    const result = this.sqlite.prepare(`
      UPDATE session_leases
      SET owner_turn_id = NULL, version = version + 1, updated_at = ?
      WHERE session_id = ? AND owner_turn_id = ?
    `).run(now(), sessionId, turnId);
    return result.changes === 1;
  }
}
