import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import type { BridgeMessageOptions, BridgeSentMessage } from "../bridge/transport.js";
import { logger } from "../logging/logger.js";
import { readSlackSurface } from "./surfaces.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import { slackApiCall } from "./api-call.js";

export type SlackDeliveryTarget = { channelId: string; threadTs: string | null };
export type SlackThreadRecoveryResult = SlackDeliveryTarget | "pending" | null;
type SlackRecoveryHooks = {
  recover: (chatId: string, target: SlackDeliveryTarget, sessionId?: string | null) => Promise<SlackThreadRecoveryResult>;
  sent: (chatId: string, target: SlackDeliveryTarget, messageId: string) => void;
  replaced: (chatId: string, originalId: string, newId: string) => void;
  reserveReplacement: (chatId: string, messageId: string) => boolean;
  rejectReplacement: (chatId: string, messageId: string) => void;
};
type SlackContent = { text: string; blocks?: KnownBlock[] };
type SlackResponse = { channel?: string; ts?: string; message?: { thread_ts?: string } };
type SlackMessageAvailability = {
  state: "available" | "missing" | "unknown";
  surface?: MessageSpec["surface"];
  error?: unknown;
};

function slackErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = error.data as { error?: unknown } | null | undefined;
  return typeof data === "object" && data !== null && typeof data.error === "string"
    ? data.error : null;
}

/** Fail closed for conversation content. Preflight is not atomic with Slack writes. */
export class SlackThreadDelivery {
  constructor(private readonly client: WebClient, private readonly recovery?: SlackRecoveryHooks) {}

  async send(chatId: string, target: SlackDeliveryTarget, content: SlackContent,
    options?: BridgeMessageOptions, allowRecovery = true, replacementId?: string): Promise<BridgeSentMessage | null> {
    if (target.threadTs) {
      const available = await this.messageAvailability(chatId, target, target.threadTs);
      if (available.state !== "available") {
        if (replacementId) this.recovery?.rejectReplacement(chatId, replacementId);
        if (available.state === "missing") {
          const next = allowRecovery ? await this.recovery?.recover(chatId, target, options?.messageSpec?.session?.id) : null;
          if (next === "pending") return null;
          if (next) return this.send(chatId, next, content, options, false, replacementId);
          await this.sendNotice(chatId, target, options);
        }
        return null;
      }
    }
    try {
      const response = await slackApiCall(() => this.client.chat.postMessage({ channel: target.channelId,
        thread_ts: target.threadTs ?? undefined, ...content }));
      const verified = await this.verifyDestination(chatId, target, response, options);
      if (verified === true) {
        if (response.ts) this.recovery?.sent(chatId, target, response.ts);
        return response.ts ? { message_id: response.ts } : null;
      }
      if (verified === "missing") {
        const next = allowRecovery ? await this.recovery?.recover(chatId, target, options?.messageSpec?.session?.id) : null;
        if (next === "pending") return null;
        if (next) return this.send(chatId, next, content, options, false, replacementId);
        await this.sendNotice(chatId, target, options);
      }
      return null;
    } catch (error) {
      this.logFailure("slack.message.send_failed", chatId, target, error);
      const code = slackErrorCode(error);
      if (replacementId && code && !["internal_error", "fatal_error", "request_timeout", "service_unavailable"].includes(code)) {
        this.recovery?.rejectReplacement(chatId, replacementId);
      }
      if (replacementId && (error as { code?: string } | null)?.code === "slack_webapi_rate_limited_error") {
        this.recovery?.rejectReplacement(chatId, replacementId);
      }
      // A definite Slack rejection is safe to degrade; timeouts/unknown outcomes are not.
      if (target.threadTs && slackErrorCode(error) === "thread_not_found") {
        const next = allowRecovery ? await this.recovery?.recover(chatId, target, options?.messageSpec?.session?.id) : null;
        if (next === "pending") return null;
        if (next) return this.send(chatId, next, content, options, false, replacementId);
        await this.sendNotice(chatId, target, options);
      }
      return null;
    }
  }

  async edit(chatId: string, target: SlackDeliveryTarget, messageId: string, content: SlackContent,
    options?: BridgeMessageOptions, replace = false): Promise<boolean> {
    if (replace) return this.replace(chatId, target, messageId, content, options);
    // Parent-card edits intentionally target the existing root anchor, never a new one.
    const destination = messageId === target.threadTs ? { ...target, threadTs: null } : target;
    const incomingSurface = readSlackSurface(content.blocks);
    // A selector click can arrive after its root message became a status card.
    // Reuse the parent preflight; root selectors check their own exact message.
    const checkedMessageId = target.threadTs ?? (incomingSurface === "session-selector" ? messageId : null);
    if (checkedMessageId) {
      const available = await this.messageAvailability(chatId, target, checkedMessageId);
      if (available.state === "unknown") throw available.error ?? new Error("Slack message availability is unknown.");
      if (available.state !== "available") {
        // A status-only refresh never creates an entry point by itself.
        if (incomingSurface === "session-status") return false;
        const next = await this.recovery?.recover(chatId, target, options?.messageSpec?.session?.id);
        if (!next || next === "pending") return false;
        return this.replace(chatId, next, messageId, content, options);
      }
      if (messageId === checkedMessageId && available.surface === "session-status" && incomingSurface !== "session-status") {
        logger.info("slack.message.surface_edit_skipped", { chatId, messageId, incomingSurface: incomingSurface ?? null });
        return false;
      }
    }
    // chat.update does not promise thread_ts in its response. Its immutable ts addresses
    // the message already verified on send; do not interpret absent metadata as root.
    await slackApiCall(() => this.client.chat.update({ channel: destination.channelId, ts: messageId, ...content }));
    logger.info("slack.message.edit", { chatId, ...destination, messageId, purpose: options?.purpose ?? null });
    return true;
  }

  private async replace(chatId: string, target: SlackDeliveryTarget, messageId: string,
    content: SlackContent, options?: BridgeMessageOptions): Promise<boolean> {
    if (!this.recovery?.reserveReplacement(chatId, messageId)) {
      logger.warn("slack.message.replacement_unconfirmed", { chatId, messageId });
      return false;
    }
    const sent = await this.send(chatId, target, content, options, false, messageId);
    if (!sent) return false;
    this.recovery?.replaced(chatId, messageId, String(sent.message_id));
    return true;
  }

  private async messageAvailability(chatId: string, target: SlackDeliveryTarget, messageId: string): Promise<SlackMessageAvailability> {
    try {
      // history works with the bot history scopes on public/private channels and DMs.
      const response = await this.client.conversations.history({ channel: target.channelId,
        oldest: messageId, latest: messageId, inclusive: true, limit: 1 });
      if (response.ok !== true || !Array.isArray(response.messages)) {
        logger.warn("slack.thread.parent_unverified", { chatId, ...target });
        return { state: "unknown" };
      }
      const found = response.messages.find((message) => message.ts === messageId);
      if (found && found.subtype !== "tombstone") return { state: "available", surface: readSlackSurface(found.blocks) };
      logger.info("slack.thread.parent_unavailable", { chatId, ...target,
        historyLimited: (response as { is_limited?: unknown }).is_limited === true,
        tombstone: found?.subtype === "tombstone" });
      return { state: "missing" };
    } catch (error) {
      this.logFailure("slack.thread.parent_unverified", chatId, target, error);
      return { state: "unknown", error };
    }
  }

  private async verifyDestination(chatId: string, target: SlackDeliveryTarget, response: SlackResponse,
    options?: BridgeMessageOptions): Promise<boolean | "missing"> {
    const actualThreadTs = response.message ? response.message.thread_ts ?? null : undefined;
    // Explicit root sends retain their existing contract. Thread sends require positive evidence.
    const verified = Boolean(response.ts) && (target.threadTs === null
      ? (!response.channel || response.channel === target.channelId) && !actualThreadTs
      : response.channel === target.channelId && actualThreadTs === target.threadTs);
    logger.info("slack.message.send", { chatId, channelId: target.channelId,
      messageId: response.ts ?? null, purpose: options?.purpose ?? null,
      threadTs: target.threadTs, actualChannelId: response.channel ?? null,
      actualThreadTs: actualThreadTs ?? null, destinationVerified: verified,
      responseDestinationKnown: response.message !== undefined });
    if (verified) return true;
    logger.warn("slack.message.destination_mismatch", { chatId, ...target, messageId: response.ts ?? null });
    if (!response.ts) return false;
    try {
      const deleted = await this.client.chat.delete({ channel: response.channel ?? target.channelId, ts: response.ts });
      if (deleted.ok !== true) throw new Error("Slack did not confirm message retraction.");
      logger.info("slack.message.misroute_retracted", { chatId, messageId: response.ts });
    } catch (error) {
      this.logFailure("slack.message.misroute_retract_failed", chatId, target, error, response.ts);
      return false;
    }
    // Unknown responses cannot prove a safe fallback destination/outcome.
    if (target.threadTs && actualThreadTs === null && response.channel === target.channelId) {
      return "missing";
    }
    return false;
  }

  private async sendNotice(chatId: string, target: SlackDeliveryTarget, options?: BridgeMessageOptions): Promise<void> {
    const notice = options?.unavailableThreadNotice;
    if (!notice) {
      logger.info("slack.message.thread_only_skipped", { chatId, ...target, purpose: options?.purpose ?? null });
      return;
    }
    const body = notice.kind === "management" ? notice.text
      : "A session needs approval or input. Rebind it in an available conversation to review the request.";
    const text = `System\nOriginal Slack thread ${target.threadTs} is unavailable.\n${body}`;
    try {
      const response = await this.client.chat.postMessage({ channel: target.channelId, text,
        // Plain text only: never carry original content, inferred actions or callback payloads.
        blocks: [{ type: "section", text: { type: "plain_text", text: Array.from(text).slice(0, 2900).join("") } }] });
      await this.verifyDestination(chatId, { ...target, threadTs: null }, response, { purpose: "unavailable-thread-notice" });
    } catch (error) {
      this.logFailure("slack.message.root_notice_failed", chatId, target, error);
    }
    // A notice is not the original message; callers must not attach its ID to session content.
  }

  private logFailure(event: string, chatId: string, target: SlackDeliveryTarget, error: unknown, messageId?: string): void {
    logger.warn(event, { chatId, ...target, ...(messageId ? { messageId } : {}),
      error: error instanceof Error ? error.message : String(error) });
  }
}
