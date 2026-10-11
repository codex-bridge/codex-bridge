import Database from "better-sqlite3";

import type { TurnRouteRecord, TurnRouteState } from "../shared/types.js";

type TurnRouteRow = {
  turn_id: string;
  session_id: string;
  codex_thread_id: string;
  binding_id: string | null;
  source_id: string;
  state: TurnRouteState;
  created_at: number;
  updated_at: number;
};

function now(): number {
  return Date.now();
}

function asRecord(row: TurnRouteRow): TurnRouteRecord {
  return {
    turnId: row.turn_id,
    sessionId: row.session_id,
    codexThreadId: row.codex_thread_id,
    bindingId: row.binding_id,
    sourceId: row.source_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class TurnRouteRepository {
  constructor(private readonly sqlite: InstanceType<typeof Database>) {}

  record(input: Omit<TurnRouteRecord, "createdAt" | "updatedAt" | "state"> & { state?: TurnRouteState }): TurnRouteRecord {
    const timestamp = now();
    const write = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE turn_routes
        SET state = 'interrupted', updated_at = ?
        WHERE codex_thread_id = ? AND state = 'active' AND turn_id != ?
      `).run(timestamp, input.codexThreadId, input.turnId);
      this.sqlite.prepare(`
        INSERT INTO turn_routes (
          turn_id, session_id, codex_thread_id, binding_id, source_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          session_id = excluded.session_id,
          codex_thread_id = excluded.codex_thread_id,
          binding_id = excluded.binding_id,
          source_id = excluded.source_id,
          state = excluded.state,
          updated_at = excluded.updated_at
      `).run(
        input.turnId,
        input.sessionId,
        input.codexThreadId,
        input.bindingId,
        input.sourceId,
        input.state ?? "active",
        timestamp,
        timestamp
      );
    });
    write.immediate();
    const row = this.sqlite.prepare(`SELECT * FROM turn_routes WHERE turn_id = ?`).get(input.turnId) as TurnRouteRow | undefined;
    if (!row) throw new Error(`Unable to persist turn route: ${input.turnId}`);
    return asRecord(row);
  }

  getActiveByThread(codexThreadId: string): TurnRouteRecord | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM turn_routes
      WHERE codex_thread_id = ? AND state = 'active'
      ORDER BY updated_at DESC, turn_id DESC
      LIMIT 1
    `).get(codexThreadId) as TurnRouteRow | undefined;
    return row ? asRecord(row) : null;
  }

  listActive(): TurnRouteRecord[] {
    return (this.sqlite.prepare(`
      SELECT * FROM turn_routes
      WHERE state = 'active'
      ORDER BY updated_at ASC, turn_id ASC
    `).all() as TurnRouteRow[]).map(asRecord);
  }

  get(turnId: string): TurnRouteRecord | null {
    const row = this.sqlite.prepare(`SELECT * FROM turn_routes WHERE turn_id = ?`).get(turnId) as TurnRouteRow | undefined;
    return row ? asRecord(row) : null;
  }

  complete(turnId: string, state: Extract<TurnRouteState, "completed" | "failed" | "interrupted">): TurnRouteRecord | null {
    this.sqlite.prepare(`
      UPDATE turn_routes SET state = ?, updated_at = ?
      WHERE turn_id = ? AND state = 'active'
    `).run(state, now(), turnId);
    return this.get(turnId);
  }
}
