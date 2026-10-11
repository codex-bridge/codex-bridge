import crypto from "node:crypto";

import Database from "better-sqlite3";
import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { decisionsTable } from "./schema.js";
import type { DecisionRecord } from "../shared/types.js";

function now(): number {
  return Date.now();
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

const MAX_RESOLVED_DECISIONS_PER_SESSION = 50;
const RESOLVED_DECISION_STATES = [
  "approved",
  "approvedForSession",
  "rejected",
  "cancelled",
  "stale"
] as const;

function asDecisionRecord(row: {
  id: string;
  sessionId: string;
  telegramChatId: string;
  approvalId: string;
  kind: string | null;
  title: string;
  summary: string | null;
  requiresUserInput: number;
  state: string;
  telegramMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}): DecisionRecord {
  return {
    ...row,
    requiresUserInput: Boolean(row.requiresUserInput),
    state: row.state as DecisionRecord["state"]
  };
}

export class DecisionRepository {
  constructor(
    private readonly sqlite: InstanceType<typeof Database>,
    private readonly db: ReturnType<typeof drizzle>
  ) {}

  async createOrReplacePending(input: {
    sessionId: string;
    telegramChatId: string;
    approvalId: string;
    kind: string | null;
    title: string;
    summary: string | null;
    requiresUserInput: boolean;
  }): Promise<DecisionRecord> {
    const existing = await this.db
      .select()
      .from(decisionsTable)
      .where(eq(decisionsTable.approvalId, input.approvalId))
      .get();

    if (existing) {
      await this.db
        .update(decisionsTable)
        .set({
          sessionId: input.sessionId,
          telegramChatId: input.telegramChatId,
          kind: input.kind,
          title: input.title,
          summary: input.summary,
          requiresUserInput: input.requiresUserInput ? 1 : 0,
          state: "pending",
          updatedAt: now()
        })
        .where(eq(decisionsTable.id, existing.id))
        .run();
      return (await this.get(existing.id)) as DecisionRecord;
    }

    const record = {
      id: createId("decision"),
      sessionId: input.sessionId,
      telegramChatId: input.telegramChatId,
      approvalId: input.approvalId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      requiresUserInput: input.requiresUserInput ? 1 : 0,
      state: "pending",
      telegramMessageId: null,
      createdAt: now(),
      updatedAt: now()
    };

    await this.db.insert(decisionsTable).values(record).run();
    await this.pruneResolvedForSession(input.sessionId);
    return (await this.get(record.id)) as DecisionRecord;
  }

  async listPending(sessionId: string): Promise<DecisionRecord[]> {
    return this.db
      .select()
      .from(decisionsTable)
      .where(and(eq(decisionsTable.sessionId, sessionId), eq(decisionsTable.state, "pending")))
      .orderBy(desc(decisionsTable.createdAt))
      .all()
      .map(asDecisionRecord);
  }

  async listOpen(sessionId: string): Promise<DecisionRecord[]> {
    return this.db.select().from(decisionsTable)
      .where(and(eq(decisionsTable.sessionId, sessionId), inArray(decisionsTable.state, ["pending", "awaitingInput"])))
      .orderBy(desc(decisionsTable.createdAt)).all().map(asDecisionRecord);
  }

  async getAwaitingInputForChat(telegramChatId: string): Promise<DecisionRecord | null> {
    const row = await this.db
      .select()
      .from(decisionsTable)
      .where(
        and(
          eq(decisionsTable.telegramChatId, telegramChatId),
          eq(decisionsTable.state, "awaitingInput")
        )
      )
      .orderBy(desc(decisionsTable.createdAt))
      .limit(1)
      .get();
    return row ? asDecisionRecord(row) : null;
  }

  async getAwaitingInputForSession(sessionId: string): Promise<DecisionRecord | null> {
    const row = await this.db
      .select()
      .from(decisionsTable)
      .where(
        and(
          eq(decisionsTable.sessionId, sessionId),
          eq(decisionsTable.state, "awaitingInput")
        )
      )
      .orderBy(desc(decisionsTable.createdAt))
      .limit(1)
      .get();
    return row ? asDecisionRecord(row) : null;
  }

  async get(decisionId: string): Promise<DecisionRecord | null> {
    const row = await this.db
      .select()
      .from(decisionsTable)
      .where(eq(decisionsTable.id, decisionId))
      .get();
    return row ? asDecisionRecord(row) : null;
  }

  async getByApprovalId(approvalId: string): Promise<DecisionRecord | null> {
    const row = await this.db
      .select()
      .from(decisionsTable)
      .where(eq(decisionsTable.approvalId, approvalId))
      .get();
    return row ? asDecisionRecord(row) : null;
  }

  async attachMessage(decisionId: string, telegramMessageId: string): Promise<void> {
    await this.db
      .update(decisionsTable)
      .set({ telegramMessageId, updatedAt: now() })
      .where(eq(decisionsTable.id, decisionId))
      .run();
  }

  async updateMessageTarget(
    decisionId: string,
    telegramChatId: string,
    telegramMessageId: string
  ): Promise<void> {
    await this.db
      .update(decisionsTable)
      .set({ telegramChatId, telegramMessageId, updatedAt: now() })
      .where(eq(decisionsTable.id, decisionId))
      .run();
  }

  async resolve(
    decisionId: string,
    state: DecisionRecord["state"]
  ): Promise<DecisionRecord | null> {
    const decision = await this.get(decisionId);
    if (!decision) return null;

    await this.db
      .update(decisionsTable)
      .set({ state, updatedAt: now() })
      .where(eq(decisionsTable.id, decisionId))
      .run();

    await this.pruneResolvedForSession(decision.sessionId);
    return this.get(decisionId);
  }

  private async pruneResolvedForSession(sessionId: string): Promise<void> {
    const rows = this.sqlite
      .prepare(`
        SELECT id
        FROM decisions
        WHERE session_id = ?
          AND state IN (${RESOLVED_DECISION_STATES.map(() => "?").join(", ")})
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      `)
      .all(
        sessionId,
        ...RESOLVED_DECISION_STATES,
        MAX_RESOLVED_DECISIONS_PER_SESSION
      ) as Array<{ id: string }>;

    for (const row of rows) {
      await this.db.delete(decisionsTable).where(eq(decisionsTable.id, row.id)).run();
    }
  }
}
