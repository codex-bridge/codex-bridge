import type { SessionRecord, TurnRouteRecord } from "../../shared/types.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";

export type WorkflowAppend = <T>(session: SessionRecord, operation: () => Promise<T>,
  context?: { turnId?: string; sourceId?: string }) => Promise<T>;

/** Progress updates, boundaries and final-delivery retries share one queue per turn.
 * Only new chronological messages call append; fixed panels and existing items do not.
 */
export class WorkflowSequence {
  private readonly queue = new KeyedQueue();

  constructor(private readonly getActiveRoute: (threadId: string) => TurnRouteRecord | null,
    private readonly closePhase: (threadId: string, turnId: string) => Promise<void>) {}

  run<T>(key: string, operation: () => Promise<T>): Promise<T> { return this.queue.run(key, operation); }

  readonly append: WorkflowAppend = async (session, operation, context) => {
    const route = this.getActiveRoute(session.codexThreadId);
    const sourceId = context?.sourceId ?? session.telegramChatId;
    if (!route || route.sessionId !== session.id || route.sourceId !== sourceId ||
      context?.turnId !== undefined && context.turnId !== route.turnId) return operation();
    return this.run(`${route.codexThreadId}:${route.turnId}`, async () => {
      // The captured route identifies the sequence even if ownership moves while queued.
      await this.closePhase(route.codexThreadId, route.turnId);
      return operation();
    });
  };

  async drain(): Promise<void> { await this.queue.drain(); }
}
