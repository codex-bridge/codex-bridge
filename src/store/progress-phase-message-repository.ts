import crypto from "node:crypto";

import Database from "better-sqlite3";

import type {
  ProgressPhaseKind,
  ProgressPhaseAggregate,
  ProgressPhaseDeliveryState,
  ProgressFailureReason,
  ProgressPhaseMessageRecord,
  ProgressPhaseState
} from "../shared/types.js";

type ProgressPhaseMessageRow = {
  id: string;
  session_id: string;
  codex_thread_id: string;
  turn_id: string;
  phase_seq: number;
  phase_kind: ProgressPhaseKind;
  source_id: string;
  platform_message_id: string;
  directory: string;
  text: string;
  aggregate_json: string;
  update_count: number;
  state: ProgressPhaseState;
  failure_reason: ProgressFailureReason | null;
  delivery_state: ProgressPhaseDeliveryState;
  correction_message_id: string | null;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
};

function now(): number {
  return Date.now();
}

function emptyAggregate(): ProgressPhaseAggregate {
  return { eventCount: 0, operations: [], files: {}, fileEdits: [], run: { updates: 0, succeeded: 0, failed: 0 }, explored: {} };
}

function parseAggregate(value: string): ProgressPhaseAggregate {
  try {
    const parsed = JSON.parse(value) as Partial<ProgressPhaseAggregate>;
    return {
      eventCount: typeof parsed.eventCount === "number" ? parsed.eventCount : 0,
      operations: parseOperations(parsed.operations),
      files: parsed.files && typeof parsed.files === "object" ? parsed.files : {},
      ...(Array.isArray(parsed.fileEdits) ? { fileEdits: parsed.fileEdits } : {}),
      run: {
        updates: typeof parsed.run?.updates === "number" ? parsed.run.updates : 0,
        succeeded: typeof parsed.run?.succeeded === "number" ? parsed.run.succeeded : 0,
        failed: typeof parsed.run?.failed === "number" ? parsed.run.failed : 0
      },
      explored: parsed.explored && typeof parsed.explored === "object" ? parsed.explored : {}
    };
  } catch {
    return emptyAggregate();
  }
}

function parseOperations(value: unknown): ProgressPhaseAggregate["operations"] {
  if (Array.isArray(value)) {
    return value.filter((operation): operation is { name: string; count: number } =>
      Boolean(operation) && typeof operation.name === "string" && typeof operation.count === "number"
    );
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, count]) =>
    typeof count === "number" ? [{ name, count }] : []
  );
}

function asRecord(row: ProgressPhaseMessageRow): ProgressPhaseMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    codexThreadId: row.codex_thread_id,
    turnId: row.turn_id,
    phaseSeq: row.phase_seq,
    phaseKind: row.phase_kind,
    sourceId: row.source_id,
    platformMessageId: row.platform_message_id,
    directory: row.directory,
    text: row.text,
    aggregate: parseAggregate(row.aggregate_json),
    updateCount: row.update_count,
    state: row.state,
    failureReason: row.failure_reason,
    deliveryState: row.delivery_state ?? "synced",
    correctionMessageId: row.correction_message_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  };
}

export class ProgressPhaseMessageRepository {
  constructor(private readonly sqlite: InstanceType<typeof Database>) {}

  getActiveByTurn(codexThreadId: string, turnId: string): ProgressPhaseMessageRecord | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM progress_phase_messages
      WHERE codex_thread_id = ? AND turn_id = ? AND state = 'active'
      ORDER BY updated_at DESC, phase_seq DESC
      LIMIT 1
    `).get(codexThreadId, turnId) as ProgressPhaseMessageRow | undefined;
    return row ? asRecord(row) : null;
  }

  listActive(): ProgressPhaseMessageRecord[] {
    return (this.sqlite.prepare(`
      SELECT * FROM progress_phase_messages
      WHERE state = 'active'
      ORDER BY updated_at ASC, phase_seq ASC
    `).all() as ProgressPhaseMessageRow[]).map(asRecord);
  }

  getByFileEdit(codexThreadId: string, turnId: string, itemId: string): ProgressPhaseMessageRecord | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM progress_phase_messages
      WHERE codex_thread_id = ? AND turn_id = ? AND phase_kind = 'edited'
        AND EXISTS (
          SELECT 1 FROM json_each(aggregate_json, '$.fileEdits')
          WHERE json_extract(value, '$.itemId') = ?
        )
      ORDER BY phase_seq ASC LIMIT 1
    `).get(codexThreadId, turnId, itemId) as ProgressPhaseMessageRow | undefined;
    return row ? asRecord(row) : null;
  }

  updateFinalAggregate(id: string, aggregate: ProgressPhaseAggregate): ProgressPhaseMessageRecord | null {
    this.sqlite.prepare(`
      UPDATE progress_phase_messages
      SET aggregate_json = ?,
        delivery_state = CASE WHEN delivery_state = 'unavailable' THEN delivery_state ELSE 'pending_finalization' END,
        updated_at = ?
      WHERE id = ? AND state != 'active'
    `).run(JSON.stringify(aggregate), now(), id);
    return this.get(id);
  }

  create(input: {
    sessionId: string;
    codexThreadId: string;
    turnId: string;
    phaseKind: ProgressPhaseKind;
    sourceId: string;
    platformMessageId: string;
    directory: string;
    text: string;
    aggregate?: ProgressPhaseAggregate;
  }): ProgressPhaseMessageRecord {
    const createdAt = now();
    const record = this.sqlite.transaction(() => {
      const active = this.getActiveByTurn(input.codexThreadId, input.turnId);
      if (active) {
        throw new Error(`Cannot create a progress phase while ${active.id} is still active`);
      }
      const latest = this.sqlite.prepare(`
        SELECT MAX(phase_seq) AS phase_seq
        FROM progress_phase_messages
        WHERE codex_thread_id = ? AND turn_id = ?
      `).get(input.codexThreadId, input.turnId) as { phase_seq: number | null };
      const phaseSeq = (latest.phase_seq ?? 0) + 1;
      const id = `ppm_${crypto.randomUUID()}`;
      this.sqlite.prepare(`
        INSERT INTO progress_phase_messages (
          id, session_id, codex_thread_id, turn_id, phase_seq, phase_kind,
          source_id, platform_message_id, directory, text, aggregate_json, update_count, state,
          failure_reason, delivery_state, correction_message_id,
          started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 'synced', NULL, ?, NULL, ?)
      `).run(
        id,
        input.sessionId,
        input.codexThreadId,
        input.turnId,
        phaseSeq,
        input.phaseKind,
        input.sourceId,
        input.platformMessageId,
        input.directory,
        input.text,
        JSON.stringify(input.aggregate ?? emptyAggregate()),
        1,
        createdAt,
        createdAt
      );
      return this.get(id);
    })();
    if (!record) throw new Error("Unable to create progress phase message record");
    return record;
  }

  updateActive(id: string, input: {
    text: string;
    directory: string;
    sourceId: string;
    aggregate?: ProgressPhaseAggregate;
  }): ProgressPhaseMessageRecord | null {
    const updatedAt = now();
    this.sqlite.prepare(`
      UPDATE progress_phase_messages
      SET text = ?, directory = ?, source_id = ?, aggregate_json = COALESCE(?, aggregate_json), update_count = update_count + 1, updated_at = ?
      WHERE id = ? AND state = 'active'
    `).run(
      input.text,
      input.directory,
      input.sourceId,
      input.aggregate ? JSON.stringify(input.aggregate) : null,
      updatedAt,
      id
    );
    return this.get(id);
  }

  recordSuccessfulRunContentUpdate(id: string): ProgressPhaseMessageRecord | null {
    return this.sqlite.transaction(() => {
      const record = this.get(id);
      if (!record || record.state !== "active" || record.phaseKind !== "run") return null;
      record.aggregate.run.updates += 1;
      this.sqlite.prepare(`
        UPDATE progress_phase_messages SET aggregate_json = ?, updated_at = ?
        WHERE id = ? AND state = 'active' AND phase_kind = 'run'
      `).run(JSON.stringify(record.aggregate), now(), id);
      return this.get(id);
    })();
  }

  finalize(input: {
    id: string;
    state: Exclude<ProgressPhaseState, "active">;
    failureReason?: ProgressFailureReason | null;
    deliveryState?: ProgressPhaseDeliveryState;
  }): ProgressPhaseMessageRecord | null {
    const finishedAt = now();
    this.sqlite.prepare(`
      UPDATE progress_phase_messages
      SET state = ?, failure_reason = COALESCE(?, failure_reason),
        delivery_state = COALESCE(?, delivery_state), finished_at = ?, updated_at = ?
      WHERE id = ? AND state = 'active'
    `).run(input.state, input.failureReason ?? null, input.deliveryState ?? null, finishedAt, finishedAt, input.id);
    return this.get(input.id);
  }

  finalizeActiveByTurn(
    codexThreadId: string,
    turnId: string,
    state: Exclude<ProgressPhaseState, "active">
  ): ProgressPhaseMessageRecord | null {
    const active = this.getActiveByTurn(codexThreadId, turnId);
    return active ? this.finalize({ id: active.id, state }) : null;
  }

  getLatestByTurn(codexThreadId: string, turnId: string): ProgressPhaseMessageRecord | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM progress_phase_messages
      WHERE codex_thread_id = ? AND turn_id = ?
      ORDER BY phase_seq DESC
      LIMIT 1
    `).get(codexThreadId, turnId) as ProgressPhaseMessageRow | undefined;
    return row ? asRecord(row) : null;
  }

  markDeliveryState(input: {
    id: string;
    deliveryState: ProgressPhaseDeliveryState;
    correctionMessageId?: string | null;
  }): ProgressPhaseMessageRecord | null {
    this.sqlite.prepare(`
      UPDATE progress_phase_messages
      SET delivery_state = ?,
        correction_message_id = CASE WHEN ? THEN ? ELSE correction_message_id END,
        updated_at = ?
      WHERE id = ?
    `).run(input.deliveryState, input.correctionMessageId !== undefined ? 1 : 0,
      input.correctionMessageId ?? null, now(), input.id);
    return this.get(input.id);
  }

  updateFinalState(input: {
    id: string;
    state: Exclude<ProgressPhaseState, "active">;
    failureReason?: ProgressFailureReason | null;
  }): ProgressPhaseMessageRecord | null {
    this.sqlite.prepare(`
      UPDATE progress_phase_messages
      SET state = ?, failure_reason = COALESCE(?, failure_reason),
        delivery_state = CASE WHEN delivery_state = 'unavailable' THEN delivery_state ELSE 'pending_finalization' END,
        updated_at = ?
      WHERE id = ? AND state != 'active'
    `).run(input.state, input.failureReason ?? null, now(), input.id);
    return this.get(input.id);
  }

  listPendingFinalDelivery(): ProgressPhaseMessageRecord[] {
    return (this.sqlite.prepare(`
      SELECT * FROM progress_phase_messages
      WHERE state != 'active' AND (
        delivery_state IN ('pending_finalization', 'correction_sent')
        OR (delivery_state = 'synced' AND correction_message_id IS NOT NULL)
      )
      ORDER BY updated_at ASC, phase_seq ASC
    `).all() as ProgressPhaseMessageRow[]).map(asRecord);
  }

  get(id: string): ProgressPhaseMessageRecord | null {
    const row = this.sqlite.prepare(`SELECT * FROM progress_phase_messages WHERE id = ?`).get(id) as ProgressPhaseMessageRow | undefined;
    return row ? asRecord(row) : null;
  }
}
