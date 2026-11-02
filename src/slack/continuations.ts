import { randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { KeyedQueue } from "../shared/keyed-queue.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import type { SlackContinuationRepository, SlackEndpoint } from "../store/slack-continuation-repository.js";
import { logger } from "../logging/logger.js";
import { buildSlackChatId, parseSlackChatId } from "./transport.js";
import { renderSlackMessageSpec } from "./message-renderer.js";
import type { SlackDeliveryTarget, SlackThreadRecoveryResult } from "./thread-delivery.js";
import { slackApiCall } from "./api-call.js";

const RECOVERY_EVENT = "bridge_thread_continuation";

export function withCurrentSlackThread(spec: MessageSpec, threadTs: string | null): MessageSpec {
  if (spec.surface !== "session-status") return spec;
  return { ...spec, body: spec.body.map((part) => part.type === "field" && part.label === "Thread"
    ? { ...part, value: threadTs ?? part.value } : part) };
}

/** One owner for Slack's replaceable entry points and stable message handles. */
export class SlackContinuations {
  private readonly queue = new KeyedQueue();
  private readonly cooldowns = new Map<string, number>();

  constructor(private readonly deps: {
    client: WebClient;
    store: SlackContinuationRepository;
    rootSpec: (sourceId: string, threadTs: string | null, sessionId: string) => Promise<MessageSpec | null>;
    callbackSecret?: string | null;
    botUserId: () => string | null;
    onReady?: (sourceId: string) => Promise<void>;
  }) {}

  resolveSource(sourceId: string): string {
    return this.deps.store.resolveSource(sourceId);
  }

  target(sourceId: string): SlackDeliveryTarget {
    const logical = this.resolveSource(sourceId);
    const ref = parseSlackChatId(logical);
    if (!ref) throw new Error("Invalid Slack continuation source.");
    return { channelId: ref.channelId, threadTs: this.deps.store.get(logical)?.threadTs ?? ref.threadTs };
  }

  isCurrentSurface(physicalSourceId: string): boolean {
    const ref = parseSlackChatId(physicalSourceId);
    return !ref?.threadTs || this.target(physicalSourceId).threadTs === ref.threadTs;
  }

  message(sourceId: string, messageId: string): { messageId: string; replace: boolean } {
    const logical = this.resolveSource(sourceId);
    const ref = parseSlackChatId(logical)!;
    const target = this.target(logical);
    const rootSource = buildSlackChatId({ ...ref, threadTs: messageId });
    if (this.resolveSource(rootSource) === logical) return { messageId: target.threadTs!, replace: false };
    const saved = this.deps.store.getMessage(logical, messageId);
    return { messageId: saved?.messageId ?? messageId,
      replace: (saved?.threadTs ?? ref.threadTs) !== target.threadTs };
  }

  remember(sourceId: string, target: SlackDeliveryTarget, messageId: string): void {
    if (target.threadTs) this.deps.store.putMessage(this.resolveSource(sourceId), messageId, target.threadTs, messageId);
  }

  replaced(sourceId: string, originalId: string, newId: string): void {
    const logical = this.resolveSource(sourceId);
    const sent = this.deps.store.getMessage(logical, newId);
    if (!sent) throw new Error("Slack replacement message was not recorded.");
    this.deps.store.replaceMessage(logical, originalId, sent.threadTs, sent.messageId);
  }

  reserveReplacement(sourceId: string, messageId: string): boolean {
    return this.deps.store.reserveReplacement(this.resolveSource(sourceId), messageId);
  }

  rejectReplacement(sourceId: string, messageId: string): void {
    this.deps.store.rejectReplacement(this.resolveSource(sourceId), messageId);
  }

  recover(sourceId: string, failedTarget: SlackDeliveryTarget, sessionId?: string | null): Promise<SlackThreadRecoveryResult> {
    const logical = this.resolveSource(sourceId);
    return this.queue.run(logical, async () => {
      const ref = parseSlackChatId(logical);
      if (!ref?.threadTs || !failedTarget.threadTs || !sessionId) return null;
      const existing = this.deps.store.get(logical);
      // Recheck eligibility after waiting: a handoff or selection may have changed.
      const spec = await this.deps.rootSpec(logical, null, sessionId);
      if (!spec) return null;
      if (existing?.state === "ready" && existing.threadTs !== failedTarget.threadTs) return this.target(logical);
      if (Date.now() < (this.cooldowns.get(ref.channelId) ?? 0)) return "pending";
      try {
        if (existing?.state === "pending") return await this.reconcile(existing, sessionId);
        const pending = this.deps.store.begin(logical, failedTarget.threadTs, randomUUID());
        if (pending.state !== "pending") return this.target(logical);
        let response;
        try {
          response = await slackApiCall(() => this.deps.client.chat.postMessage({ channel: ref.channelId,
            text: spec.title, blocks: renderSlackMessageSpec(logical, spec, this.deps.callbackSecret ?? null),
            metadata: { event_type: RECOVERY_EVENT, event_payload: { operation_id: pending.operationId } } }));
        } catch (error) {
          // Only an explicit rejected write is safe to retry. Server/transport failures
          // may have created the root; keep the pending operation for reconciliation.
          const data = (error ?? {}) as { data?: { ok?: boolean; error?: string }; code?: string; retryAfter?: number };
          if (data.code === "slack_webapi_rate_limited_error" ||
              (data.data?.ok === false && !["internal_error", "fatal_error", "request_timeout", "service_unavailable"]
                .includes(data.data.error ?? ""))) {
            this.deps.store.rejected(logical, pending.operationId);
          }
          if (data.retryAfter) this.cooldowns.set(ref.channelId, Date.now() + data.retryAfter * 1000);
          throw error;
        }
        if (response.ok !== true || !response.ts || !response.message || response.channel !== ref.channelId ||
            (response.message?.thread_ts && response.message.thread_ts !== response.ts)) {
          throw new Error("Slack did not confirm the continuation root destination.");
        }
        return await this.finish(pending, response.ts, sessionId);
      } catch (error) {
        logger.warn("slack.continuation.pending", { sourceId: logical,
          error: error instanceof Error ? error.message : String(error) });
        return "pending";
      }
    });
  }

  private async finish(pending: SlackEndpoint, threadTs: string, sessionId: string): Promise<SlackDeliveryTarget> {
    const ref = parseSlackChatId(pending.sourceId)!;
    this.deps.store.complete(pending.sourceId, pending.operationId, threadTs, buildSlackChatId({ ...ref, threadTs }));
    logger.info("slack.continuation.ready", { sourceId: pending.sourceId, threadTs });
    // The root already exists. A status refresh failure must not create another one.
    try {
      const spec = await this.deps.rootSpec(pending.sourceId, threadTs, sessionId);
      if (spec) await this.deps.client.chat.update({ channel: ref.channelId, ts: threadTs,
        text: spec.title, blocks: renderSlackMessageSpec(pending.sourceId, spec, this.deps.callbackSecret ?? null) });
    } catch (error) {
      logger.warn("slack.continuation.status_update_failed", { sourceId: pending.sourceId, error: String(error) });
    }
    // Run after the triggering transport operation releases its conversation queue.
    setImmediate(() => {
      void this.deps.onReady?.(pending.sourceId).catch((error) => {
        logger.warn("slack.continuation.refresh_failed", { sourceId: pending.sourceId, error: String(error) });
      });
    });
    return { channelId: ref.channelId, threadTs };
  }

  private async reconcile(pending: SlackEndpoint, sessionId: string): Promise<SlackThreadRecoveryResult> {
    const ref = parseSlackChatId(pending.sourceId)!;
    const botUserId = this.deps.botUserId();
    if (!botUserId) return "pending";
    let cursor: string | undefined;
    // Search only the creation window. An incomplete/empty search is never proof
    // that an uncertain write failed; it never authorizes a second root creation.
    for (let page = 0; page < 4; page++) {
      const result = await this.deps.client.conversations.history({ channel: ref.channelId,
        oldest: String(pending.startedAt / 1000 - 2), limit: 100, include_all_metadata: true, cursor });
      if (result.ok !== true) return "pending";
      const matches = result.messages?.filter((message) => message.user === botUserId && message.ts &&
        (!message.thread_ts || message.thread_ts === message.ts) &&
        message.metadata?.event_type === RECOVERY_EVENT &&
        (message.metadata.event_payload as Record<string, unknown> | undefined)?.operation_id === pending.operationId) ?? [];
      if (matches.length === 1) return this.finish(pending, matches[0]!.ts!, sessionId);
      if (matches.length > 1) return "pending";
      cursor = result.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return "pending";
  }
}
