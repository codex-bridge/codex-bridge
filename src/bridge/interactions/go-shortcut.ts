import { logger } from "../../logging/logger.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { actionRow, helpAction, userTextAction } from "../messages/actions.js";
import { createMessage } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";
import type { BridgeMessageOperations } from "../messages/operations.js";
import type { LastAssistantMessage } from "../runtime-state.js";
import { canDeliverSession } from "../notifications/delivery-target.js";

export type GoShortcutServiceDependencies = {
  store: Pick<BridgeStore, "listPendingDecisions" | "getAwaitingInputDecisionForSession" | "getActiveSession" |
    "getSessionLease" | "getSessionBindingById">;
  messageOperations: Pick<BridgeMessageOperations, "sendMessageSpec">;
  lastAssistantMessageByThread: Pick<Map<string, LastAssistantMessage>, "delete">;
  getSessionDirectory: (session: SessionRecord) => string;
  getMcpSummary?: (threadId: string) => string | null;
  beforeActions?: (session: SessionRecord, sourceId: string, canSend: () => Promise<boolean>) => Promise<unknown>;
  getActiveTurnId?: (threadId: string) => string | undefined;
  delayMs?: number;
};

type ActionsContext = { turnId?: string; canSend?: () => boolean | Promise<boolean> };
type ActionsRequest = {
  session: SessionRecord;
  sourceId: string;
  context: ActionsContext;
  current: () => boolean;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  started: boolean;
  completion: Promise<void>;
  settle: () => void;
};

export class GoShortcutService {
  private readonly pending = new Map<string, ActionsRequest>();
  private readonly generations = new Map<string, object>();
  private readonly tasks = new Set<Promise<void>>();

  constructor(private readonly deps: GoShortcutServiceDependencies) {}

  /** Capture at notification receipt, before slow work can delay cancellation. */
  capture(threadId: string): () => boolean {
    let generation = this.generations.get(threadId);
    if (!generation) {
      generation = {};
      this.generations.set(threadId, generation);
      if (this.generations.size > 2048) this.invalidate(this.generations.keys().next().value!);
    }
    return () => this.generations.get(threadId) === generation;
  }

  schedule(session: SessionRecord, context: ActionsContext = {}): Promise<void> {
    return this.request(session, session.telegramChatId, context, false);
  }

  flush(session: SessionRecord): Promise<void> {
    return this.request(session, session.telegramChatId, {}, true);
  }

  async sendAfterTranscript(session: SessionRecord, chatId: string, canSend?: () => Promise<boolean>): Promise<void> {
    const current = this.capture(session.codexThreadId);
    const active = await this.deps.store.getActiveSession(chatId);
    if (!current() || active?.id !== session.id) return;
    await this.request(session, chatId, { canSend: async () => current() && (!canSend || await canSend()) }, true);
  }

  /** Lifecycle cleanup cancels a request without revoking newer receipt guards. */
  cancel(threadId: string): void {
    const request = this.pending.get(threadId);
    if (!request) return;
    this.pending.delete(threadId);
    if (request.timer) clearTimeout(request.timer);
    request.controller.abort();
    request.settle();
  }

  /** Arrival of new work also revokes guards captured before a request existed. */
  invalidate(threadId: string): void {
    this.generations.delete(threadId);
    this.cancel(threadId);
  }

  cancelAll(): void {
    for (const thread of this.pending.keys()) this.cancel(thread);
    this.generations.clear();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending.values()].map(request => request.completion));
    await Promise.allSettled(this.tasks);
  }

  async waitForIdle(threadId: string, signal: AbortSignal): Promise<boolean> {
    while (!signal.aborted) {
      const request = this.pending.get(threadId);
      if (!request) return true;
      let abort!: () => void;
      const cancelled = new Promise<void>(resolve => { abort = resolve; signal.addEventListener("abort", abort, { once: true }); });
      try { await Promise.race([request.completion, cancelled]); }
      finally { signal.removeEventListener("abort", abort); }
    }
    return false;
  }

  private request(session: SessionRecord, sourceId: string, context: ActionsContext, immediate: boolean): Promise<void> {
    const thread = session.codexThreadId;
    const existing = this.pending.get(thread);
    if (existing && existing.session.id === session.id && existing.sourceId === sourceId &&
      (!existing.context.turnId || !context.turnId || existing.context.turnId === context.turnId)) {
      // Merge overlapping history/completion requests; keep the latest caller's guard.
      existing.context = { ...context, turnId: context.turnId ?? existing.context.turnId };
      return existing.completion;
    }
    if (existing) this.cancel(thread);
    let settle!: () => void;
    const completion = new Promise<void>(resolve => { settle = resolve; });
    const request: ActionsRequest = { session, sourceId, context, current: this.capture(thread),
      controller: new AbortController(), started: false, completion, settle };
    this.pending.set(thread, request);
    if (immediate) this.start(request);
    else request.timer = setTimeout(() => this.start(request), this.deps.delayMs ?? 0);
    logger.info("bridge.go_shortcut.scheduled", { sessionId: session.id, threadId: thread, sourceId,
      delayMs: immediate ? 0 : this.deps.delayMs ?? 0 });
    return completion;
  }

  private start(request: ActionsRequest): void {
    if (request.started || request.controller.signal.aborted) return;
    request.started = true;
    const thread = request.session.codexThreadId;
    const task = this.maybeSend(request).catch(error => {
      if (!request.controller.signal.aborted) logger.warn("bridge.go_shortcut.failed", {
        sessionId: request.session.id, threadId: thread,
        error: error instanceof Error ? error.message : String(error)
      });
    }).finally(() => {
      if (this.pending.get(thread) === request) {
        this.pending.delete(thread);
        this.deps.lastAssistantMessageByThread.delete(thread);
      }
      request.settle();
      this.tasks.delete(task);
    });
    this.tasks.add(task);
  }

  private async maybeSend(request: ActionsRequest): Promise<void> {
    const { session, sourceId: chatId, controller } = request;
    const eligible = async () => {
      if (controller.signal.aborted || !request.current() ||
        request.context.canSend && !await request.context.canSend()) return false;
      if (this.deps.getActiveTurnId?.(session.codexThreadId)) return false;
      if (!await canDeliverSession(this.deps.store, session, chatId)) return false;
      const lease = this.deps.store.getSessionLease(session.id);
      // Keep existing unbound/external recovery controls, but do not announce
      // Actions to an old entry after a confirmed Bridge ownership transfer.
      if (lease?.ownerBindingId && this.deps.store.getSessionBindingById(lease.ownerBindingId)?.sourceId !== chatId) return false;
      const pendingDecisions = await this.deps.store.listPendingDecisions(session.id);
      const awaitingInput = await this.deps.store.getAwaitingInputDecisionForSession(session.id);
      return pendingDecisions.length === 0 && !awaitingInput && !controller.signal.aborted && request.current() &&
        !this.deps.getActiveTurnId?.(session.codexThreadId);
    };
    if (!await eligible()) return;
    await this.deps.beforeActions?.(session, chatId, eligible);
    if (!await eligible()) return;

    const mcpSummary = this.deps.getMcpSummary?.(session.codexThreadId);
    const messageSpec: MessageSpec = createMessage({
      kind: "actions",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      ...(mcpSummary ? { body: [{ type: "text" as const, text: mcpSummary }] } : {}),
      actions: actionRow(
        userTextAction("go", "Go", "quick:go", "go"),
        userTextAction("next", "Next", "quick:next", "next"),
        helpAction()
      )
    });
    await this.deps.messageOperations.sendMessageSpec(chatId, messageSpec, {
      disable_notification: true, canSend: eligible, deliverySignal: controller.signal
    });
  }
}
