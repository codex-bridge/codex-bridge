import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import type { BridgeMessageOptions, BridgeSentMessage } from "../bridge/transport.js";
import { logger } from "../logging/logger.js";

export type SlackDeliveryTarget = { channelId: string; threadTs: string | null };
type SlackContent = { text: string; blocks?: KnownBlock[] };
type SlackResponse = { channel?: string; ts?: string; message?: { thread_ts?: string } };

function slackErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = error.data as { error?: unknown } | null | undefined;
  return typeof data === "object" && data !== null && typeof data.error === "string"
    ? data.error : null;
}

/** Fail closed for conversation content. Preflight is not atomic with Slack writes. */
export class SlackThreadDelivery {
  constructor(private readonly client: WebClient) {}

  async send(chatId: string, target: SlackDeliveryTarget, content: SlackContent,
    options?: BridgeMessageOptions): Promise<BridgeSentMessage | null> {
    if (target.threadTs) {
      const available = await this.parentAvailability(chatId, target);
      if (available !== "available") {
        if (available === "missing") await this.sendNotice(chatId, target, options);
        return null;
      }
    }
    try {
      const response = await this.client.chat.postMessage({ channel: target.channelId,
        thread_ts: target.threadTs ?? undefined, ...content });
      if (await this.verifyDestination(chatId, target, response, options)) {
        return response.ts ? { message_id: response.ts } : null;
      }
      return null;
    } catch (error) {
      this.logFailure("slack.message.send_failed", chatId, target, error);
      // A definite Slack rejection is safe to degrade; timeouts/unknown outcomes are not.
      if (target.threadTs && slackErrorCode(error) === "thread_not_found") {
        await this.sendNotice(chatId, target, options);
      }
      return null;
    }
  }

  async edit(chatId: string, target: SlackDeliveryTarget, messageId: string, content: SlackContent,
    options?: BridgeMessageOptions): Promise<boolean> {
    // Parent-card edits intentionally target the existing root anchor, never a new one.
    const destination = messageId === target.threadTs ? { ...target, threadTs: null } : target;
    if (target.threadTs && await this.parentAvailability(chatId, target) !== "available") return false;
    // chat.update does not promise thread_ts in its response. Its immutable ts addresses
    // the message already verified on send; do not interpret absent metadata as root.
    await this.client.chat.update({ channel: destination.channelId, ts: messageId, ...content });
    logger.info("slack.message.edit", { chatId, ...destination, messageId, purpose: options?.purpose ?? null });
    return true;
  }

  private async parentAvailability(chatId: string, target: SlackDeliveryTarget): Promise<"available" | "missing" | "unknown"> {
    try {
      // history works with the bot history scopes on public/private channels and DMs.
      const response = await this.client.conversations.history({ channel: target.channelId,
        oldest: target.threadTs!, latest: target.threadTs!, inclusive: true, limit: 1 });
      if (response.ok !== true || !Array.isArray(response.messages)) {
        logger.warn("slack.thread.parent_unverified", { chatId, ...target });
        return "unknown";
      }
      const found = response.messages.find((message) => message.ts === target.threadTs);
      if (found && found.subtype !== "tombstone") return "available";
      logger.info("slack.thread.parent_unavailable", { chatId, ...target });
      return "missing";
    } catch (error) {
      this.logFailure("slack.thread.parent_unverified", chatId, target, error);
      return "unknown";
    }
  }

  private async verifyDestination(chatId: string, target: SlackDeliveryTarget, response: SlackResponse,
    options?: BridgeMessageOptions): Promise<boolean> {
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
      await this.sendNotice(chatId, target, options);
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
      await this.verifyDestination(chatId, { ...target, threadTs: null }, response,
        { purpose: "unavailable-thread-notice" });
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
