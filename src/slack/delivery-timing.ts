import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { logger } from "../logging/logger.js";

type ApiTiming = { method: string; elapsedMs: number; outcome: "returned" | "threw"; errorCode?: string };
type TimingContext = { active: boolean; apiCalls: ApiTiming[]; retryWaitMs: number };
const contexts = new AsyncLocalStorage<TimingContext>();

export type SlackDeliveryOperation = "send" | "edit" | "delete" | "clear_actions";

const milliseconds = (value: number): number => Math.round(value * 100) / 100;

function errorCode(error: unknown): string | undefined {
  const value = error as { code?: unknown; data?: { error?: unknown } } | null;
  const code = value?.data?.error ?? value?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(code) ? code : undefined;
}

export async function timeSlackDelivery<T>(input: {
  chatId: string; operation: SlackDeliveryOperation; queuedAt: number; queued: boolean;
  messageKind?: string; messageLabel?: string;
}, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  const context: TimingContext = { active: true, apiCalls: [], retryWaitMs: 0 };
  let outcome = "threw";
  try {
    const result = await contexts.run(context, operation);
    outcome = result === null || result === false ? "unconfirmed" : "returned";
    return result;
  } finally {
    const finishedAt = performance.now();
    context.active = false;
    // Diagnostics must not turn a confirmed write into a failed operation.
    try {
      logger.info("slack.delivery.timing", {
        deliveryId: randomUUID(), chatId: input.chatId, operation: input.operation, queued: input.queued,
        messageKind: input.messageKind ?? null, messageLabel: input.messageLabel ?? null, outcome,
        queueWaitMs: milliseconds(startedAt - input.queuedAt), operationMs: milliseconds(finishedAt - startedAt),
        totalMs: milliseconds(finishedAt - input.queuedAt), apiCalls: context.apiCalls,
        retryWaitMs: milliseconds(context.retryWaitMs)
      });
    } catch { /* Logging is best-effort and must preserve the delivery outcome. */ }
  }
}

/** SDK-call wall time includes any internal SDK scheduling, not just network time. */
export async function timeSlackApi<T>(method: string, operation: () => Promise<T>): Promise<T> {
  const context = contexts.getStore();
  if (!context?.active) return operation();
  const startedAt = performance.now();
  let failure: unknown, outcome: ApiTiming["outcome"] = "returned";
  try {
    return await operation();
  } catch (error) {
    failure = error;
    outcome = "threw";
    throw error;
  } finally {
    const code = errorCode(failure);
    if (context.active) context.apiCalls.push({ method, elapsedMs: milliseconds(performance.now() - startedAt),
      outcome, ...(code ? { errorCode: code } : {}) });
  }
}

export async function timeSlackRetryWait(operation: () => Promise<void>): Promise<void> {
  const context = contexts.getStore(), startedAt = performance.now();
  try { await operation(); }
  finally { if (context?.active) context.retryWaitMs += performance.now() - startedAt; }
}
