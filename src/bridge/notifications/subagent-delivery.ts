import { createMessage } from "../messages/factory.js";
import { SubagentTracker, type SubagentDelivery } from "./subagent-tracker.js";
import type { MessageSpec } from "../messages/types.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";

export type SubagentDeliveryDependencies = {
  store: BridgeStore;
  subagents: SubagentTracker;
  notificationQueue: KeyedQueue;
  getSessionDirectory: (session: SessionRecord) => string;
  sendSpecAndGetLastMessage: (chatId: string, messageSpec: MessageSpec) => Promise<{ messageId: string; text: string } | null>;
  editMessageSpec: (chatId: string, messageId: string, messageSpec: MessageSpec) => Promise<boolean>;
};

type SummaryMessage = {
  messageId: string;
  text: string;
};

export class SubagentDeliveryService {
  private generation = 0;
  private readonly pendingSummaries = new Map<string, { delivery: SubagentDelivery; completion: Promise<void> }>();
  private readonly progressAt = new Map<string, number>();
  private readonly summaries = new Map<string, SummaryMessage>();
  private readonly finalizedParents = new Set<string>();

  constructor(private readonly deps: SubagentDeliveryDependencies) {}

  shouldSkipCalledProgress(session: SessionRecord, now: number): boolean {
    if (!this.deps.subagents.hasRunningChildren(session.id)) return false;
    const last = this.progressAt.get(session.telegramChatId) ?? 0;
    if (now - last < 1_000) return true;
    this.progressAt.set(session.telegramChatId, now);
    if (this.progressAt.size > 256) {
      this.progressAt.delete(this.progressAt.keys().next().value!);
    }
    return false;
  }

  queueSubagentDelivery(delivery: SubagentDelivery): Promise<void> {
    const key = this.summaryKey(delivery.route);
    if (this.finalizedParents.has(key)) return Promise.resolve();
    const pending = this.pendingSummaries.get(key);
    if (pending) {
      pending.delivery = delivery;
      return pending.completion;
    }
    const slot = { delivery, completion: Promise.resolve() };
    this.pendingSummaries.set(key, slot);
    const generation = this.generation;
    slot.completion = this.deps.notificationQueue.run(delivery.route.parentThreadId, async () => {
      if (this.pendingSummaries.get(key) === slot) this.pendingSummaries.delete(key);
      if (generation === this.generation) await this.sendSubagentDelivery(slot.delivery);
    });
    return slot.completion;
  }

  reset(): void {
    this.generation += 1;
    this.pendingSummaries.clear();
    this.summaries.clear();
    this.finalizedParents.clear();
    this.progressAt.clear();
  }

  async sendSubagentDelivery({ route, summary: observedSummary }: SubagentDelivery): Promise<void> {
    const session = await this.deps.store.getSessionById(route.sessionId);
    if (!session) return;
    await this.upsertSummary(session, route, observedSummary ?? this.deps.subagents.summary(route));
  }

  async finalizeParentTurn(input: {
    sessionId: string;
    parentThreadId: string;
    parentTurnId: string;
    terminal: "completed" | "failed" | "interrupted";
  }): Promise<void> {
    await this.deps.notificationQueue.run(
      input.parentThreadId,
      () => this.finalizeParentTurnNow(input)
    );
  }

  private async finalizeParentTurnNow(input: {
    sessionId: string;
    parentThreadId: string;
    parentTurnId: string;
    terminal: "completed" | "failed" | "interrupted";
  }): Promise<void> {
    const key = this.summaryKey(input);
    if (this.finalizedParents.has(key)) return;
    const summary = this.summaries.get(key);
    this.finalizedParents.add(key);
    if (this.finalizedParents.size > 256) this.finalizedParents.delete(this.finalizedParents.values().next().value!);
    if (!summary) return;
    const session = await this.deps.store.getSessionById(input.sessionId);
    if (!session) return;
    const summaryText = this.deps.subagents.summaryForParent(input.parentThreadId, input.parentTurnId);
    try {
      await this.deps.editMessageSpec(
        session.telegramChatId,
        summary.messageId,
        this.createSummarySpec(session, summaryText, input.terminal)
      );
      this.summaries.set(key, { ...summary, text: this.summaryText(session, summaryText, input.terminal) });
    } catch {
      // The parent is terminal even when its platform card was removed externally.
    }
  }

  private async upsertSummary(
    session: SessionRecord,
    route: SubagentDelivery["route"],
    summaryText: string
  ): Promise<void> {
    const key = this.summaryKey(route);
    if (this.finalizedParents.has(key)) return;
    const summary = this.summaries.get(key);
    const text = this.summaryText(session, summaryText);
    if (summary?.text === text) return;
    const messageSpec = this.createSummarySpec(session, summaryText);
    if (summary) {
      try {
        await this.deps.editMessageSpec(session.telegramChatId, summary.messageId, messageSpec);
        this.summaries.set(key, { ...summary, text });
        return;
      } catch {
        // Recreate a missing summary card without replaying child output.
      }
    }
    const sent = await this.deps.sendSpecAndGetLastMessage(session.telegramChatId, messageSpec);
    if (sent) this.summaries.set(key, { messageId: sent.messageId, text });
    if (this.summaries.size > 256) this.summaries.delete(this.summaries.keys().next().value!);
  }

  private createSummarySpec(
    session: SessionRecord,
    summaryText: string,
    terminal?: "completed" | "failed" | "interrupted"
  ): MessageSpec {
    const titleLabel = terminal === "completed" ? "Subagents Completed"
      : terminal === "failed" ? "Subagents Failed"
        : terminal === "interrupted" ? "Subagents Interrupted"
          : "Subagents";
    return createMessage({
      kind: terminal === "failed" ? "failed" : "subagent",
      titleLabel,
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [
        { type: "text", text: summaryText },
        ...(terminal ? [{ type: "text" as const, text: `Parent turn: ${terminal}.` }] : [])
      ]
    });
  }

  private summaryKey(input: Pick<SubagentDelivery["route"], "sessionId" | "parentThreadId" | "parentTurnId">): string {
    return `${input.sessionId}:${input.parentThreadId}:${input.parentTurnId}`;
  }

  private summaryText(
    session: SessionRecord,
    summaryText: string,
    terminal?: "completed" | "failed" | "interrupted"
  ): string {
    return [
      `Subagents · ${this.deps.getSessionDirectory(session)}`,
      summaryText,
      ...(terminal ? [`Parent turn: ${terminal}.`] : [])
    ].join("\n");
  }
}
