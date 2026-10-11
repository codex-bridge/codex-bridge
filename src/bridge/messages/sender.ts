import { logger } from "../../logging/logger.js";
import { renderSlackMessageSpecChunks } from "../../slack/message-renderer.js";
import { splitTelegramText } from "../../telegram/text.js";
import { renderTelegramMessageSpecChunks } from "../../telegram/message-renderer.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";
import type {
  BridgeMessageOptions,
  BridgeMessageTransport,
  BridgeSentMessage
} from "../transport.js";
import type { MessageSpec } from "./types.js";
import { renderLegacyMessage } from "./legacy-adapter.js";
import type { TelegramTextChunk } from "../../telegram/text.js";

export type MessageDeliveryServiceDeps = {
  maxLength: number;
  queue: KeyedQueue;
  getEnvelopeTitle: (chatId: string) => Promise<string>;
};

export type ConcurrentTextBatchItem = {
  text: string;
  options?: BridgeMessageOptions;
};

type PreparedBatchChunk = {
  text: string;
  options?: BridgeMessageOptions;
};

type StructuredSpecChunk = {
  spec: MessageSpec;
  renderedText?: string;
};

export class MessageDeliveryService {
  private readonly transports: BridgeMessageTransport[] = [];

  constructor(private readonly deps: MessageDeliveryServiceDeps) {}

  registerTransport(transport: BridgeMessageTransport): void {
    const existingIndex = this.transports.findIndex((item) => item.name === transport.name);
    if (existingIndex >= 0) {
      this.transports.splice(existingIndex, 1, transport);
      return;
    }
    this.transports.push(transport);
  }

  requireTransport(chatId: string): BridgeMessageTransport {
    const transport = this.transports.find((candidate) => candidate.canHandle(chatId));
    if (!transport) {
      throw new Error(`No message transport can handle chat ${chatId}.`);
    }
    return transport;
  }

  async envelopeText(chatId: string, text: string): Promise<string> {
    const normalized = text.trim();
    if (!normalized || this.hasMessageTitle(normalized)) {
      return text;
    }
    return `${await this.deps.getEnvelopeTitle(chatId)}\n${text}`;
  }

  async sendSpec(
    chatId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ): Promise<BridgeSentMessage | null> {
    return this.sendMessage(chatId, renderLegacyMessage(messageSpec), {
      ...options,
      messageSpec
    });
  }

  async sendLongSpec(
    chatId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ): Promise<void> {
    await this.sendLongText(chatId, renderLegacyMessage(messageSpec), {
      ...options,
      messageSpec
    });
  }

  async sendSpecAndGetLastMessage(
    chatId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ): Promise<{ messageId: string; text: string } | null> {
    return this.sendLongTextAndGetLastMessage(chatId, renderLegacyMessage(messageSpec), {
      ...options,
      messageSpec
    });
  }

  async editSpec(
    chatId: string,
    messageId: string,
    messageSpec: MessageSpec,
    options?: Omit<BridgeMessageOptions, "messageSpec">
  ): Promise<boolean> {
    const transport = this.requireTransport(chatId);
    if (transport.editMessageSpec) {
      return transport.editMessageSpec(chatId, messageId, messageSpec, {
        ...options,
        messageSpec
      });
    }
    // COMPATIBILITY(MESSAGE_FACTORY): non-native transports still need rendered text beside a spec.
    return transport.editMessageText(chatId, messageId, renderLegacyMessage(messageSpec), {
      ...options,
      messageSpec
    });
  }

  async sendLongText(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<void> {
    const transport = this.requireTransport(chatId);
    const specChunks = this.getStructuredSpecChunks(transport, options);
    if (specChunks) {
      await this.sendStructuredSpecChunks(chatId, transport, specChunks, options);
      return;
    }
    const titledText = await this.prepareText(chatId, text, options);
    await this.deps.queue.run(chatId, async () => {
      const chunks = this.split(titledText);
      for (const chunk of chunks) {
        const sent = await this.sendDirect(chatId, chunk, this.optionsForChunks(options, chunks.length));
        if (!sent) return;
      }
    });
  }

  async sendLongTextAndGetLastMessage(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<{ messageId: string; text: string } | null> {
    const transport = this.requireTransport(chatId);
    const specChunks = this.getStructuredSpecChunks(transport, options);
    if (specChunks) {
      const lastSent = await this.sendStructuredSpecChunks(chatId, transport, specChunks, options);
      return lastSent
        ? { messageId: lastSent.message.message_id, text: lastSent.renderedText ?? text }
        : null;
    }
    const titledText = await this.prepareText(chatId, text, options);
    return this.deps.queue.run(chatId, async () => {
      let lastSent: { messageId: string; text: string } | null = null;
      const chunks = this.split(titledText);
      for (const chunk of chunks) {
        const sent = await this.sendDirect(chatId, chunk, this.optionsForChunks(options, chunks.length));
        if (!sent) return lastSent;
        lastSent = { messageId: sent.message_id, text: chunk };
      }
      return lastSent;
    });
  }

  async sendTextChunksAndGetLastMessage(
    chatId: string,
    chunks: TelegramTextChunk[],
    options?: Pick<BridgeMessageOptions, "purpose">
  ): Promise<{ messageId: string; text: string } | null> {
    return this.deps.queue.run(chatId, async () => {
      let lastSent: { messageId: string; text: string } | null = null;
      for (const chunk of chunks) {
        const sent = await this.sendDirect(chatId, chunk.plain, {
          purpose: options?.purpose,
          textFormat: chunk.html ? "html" : "plain",
          formattedText: chunk.html
        });
        if (!sent) return lastSent;
        lastSent = { messageId: sent.message_id, text: chunk.plain };
      }
      return lastSent;
    });
  }

  async sendConcurrentTextBatch(
    chatId: string,
    messages: ConcurrentTextBatchItem[],
    options?: { launchIntervalMs?: number; maxInFlight?: number }
  ): Promise<void> {
    if (messages.length === 0) return;
    const prepared = await Promise.all(messages.map(async (message): Promise<PreparedBatchChunk[]> => {
      const transport = this.requireTransport(chatId);
      const specChunks = this.getStructuredSpecChunks(transport, message.options);
      if (specChunks) {
        return specChunks.map((chunk) => ({
          text: chunk.renderedText ?? message.text,
          options: { ...message.options, messageSpec: chunk.spec }
        }));
      }
      return [{
        text: await this.prepareText(chatId, message.text, message.options),
        options: message.options
      }];
    }));
    const launchIntervalMs = Math.max(100, options?.launchIntervalMs ?? 450);
    const maxInFlight = Math.max(1, Math.floor(options?.maxInFlight ?? 2));

    await this.deps.queue.run(chatId, () => new Promise<void>((resolve) => {
      let active = 0;
      let nextIndex = 0;
      let finished = false;

      const finishIfDone = () => {
        if (!finished && nextIndex >= prepared.length && active === 0) {
          finished = true;
          resolve();
        }
      };

      const launch = () => {
        if (finished) return;
        if (nextIndex < prepared.length && active < maxInFlight) {
          const message = prepared[nextIndex];
          if (!message) return;
          nextIndex += 1;
          active += 1;
          void this.sendPreparedBatchItem(chatId, message)
            .catch((error) => {
              logger.warn("bridge.message.concurrent_send_failed", {
                chatId,
                error: error instanceof Error ? error.message : String(error)
              });
            })
            .finally(() => {
              active -= 1;
              finishIfDone();
            });
        }

        if (nextIndex < prepared.length) {
          setTimeout(launch, launchIntervalMs);
        } else {
          finishIfDone();
        }
      };

      launch();
    }));
  }

  private async sendPreparedBatchItem(chatId: string, chunks: PreparedBatchChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const sent = await this.sendDirect(chatId, chunk.text, chunk.options);
      if (!sent) return;
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null> {
    const transport = this.requireTransport(chatId);
    const specChunks = this.getStructuredSpecChunks(transport, options);
    if (specChunks) {
      return (await this.sendStructuredSpecChunks(chatId, transport, specChunks, options))?.message ?? null;
    }
    const titledText = await this.prepareText(chatId, text, options);
    return this.deps.queue.run(chatId, () => this.sendDirect(chatId, titledText, options));
  }

  split(text: string): string[] {
    return splitTelegramText(text, this.deps.maxLength);
  }

  private async prepareText(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<string> {
    return options?.messageSpec ? text : this.envelopeText(chatId, text);
  }

  private getStructuredSpecChunks(
    transport: BridgeMessageTransport,
    options?: BridgeMessageOptions
  ): StructuredSpecChunk[] | null {
    if (!transport.sendMessageSpec || !options?.messageSpec) {
      return null;
    }
    if (transport.wholeMessageSpecs) return [{ spec: options.messageSpec }];
    if (transport.name === "telegram") {
      return renderTelegramMessageSpecChunks(options.messageSpec, this.deps.maxLength)
        .map((chunk) => ({ spec: chunk.spec, renderedText: chunk.markdown }));
    }
    if (transport.name === "slack") {
      return renderSlackMessageSpecChunks(options.messageSpec).map((spec) => ({ spec }));
    }
    return null;
  }

  private async sendStructuredSpecChunks(
    chatId: string,
    transport: BridgeMessageTransport,
    chunks: StructuredSpecChunk[],
    options?: BridgeMessageOptions
  ): Promise<{ message: BridgeSentMessage; renderedText?: string } | null> {
    return this.deps.queue.run(chatId, async () => {
      let lastSent: { message: BridgeSentMessage; renderedText?: string } | null = null;
      for (const chunk of chunks) {
        if (!transport.sendMessageSpec) break;
        const message = await transport.sendMessageSpec(chatId, chunk.spec, {
          ...options,
          messageSpec: chunk.spec
        });
        if (!message) return lastSent;
        lastSent = {
          message,
          ...(chunk.renderedText ? { renderedText: chunk.renderedText } : {})
        };
      }
      return lastSent;
    });
  }

  private optionsForChunks(
    options: BridgeMessageOptions | undefined,
    chunkCount: number
  ): BridgeMessageOptions | undefined {
    // COMPATIBILITY(MESSAGE_FACTORY): non-native third-party or test transports still need text-only split fallback.
    if (!options || chunkCount === 1 || !options.messageSpec) {
      return options;
    }
    const withoutSpec = { ...options };
    delete withoutSpec.messageSpec;
    return withoutSpec;
  }

  private async sendDirect(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null> {
    const transport = this.requireTransport(chatId);
    if (options?.messageSpec && transport.sendMessageSpec) {
      return transport.sendMessageSpec(chatId, options.messageSpec, options);
    }
    const { textFormat = "plain", formattedText, purpose, ...transportOptions } = options ?? {};
    const hasActions = Boolean(options?.messageSpec?.actions.length);
    const sendPlainChunks = async (): Promise<BridgeSentMessage | null> => {
      if (hasActions) return null;
      let lastSent: BridgeSentMessage | null = null;
      const chunks = this.split(text);
      logger.warn("bridge.telegram.send_split_fallback", {
        chatId,
        textLength: text.length,
        chunkCount: chunks.length
      });
      for (const chunk of chunks) {
        lastSent = await transport.sendMessage(chatId, chunk, transportOptions);
      }
      return lastSent;
    };

    try {
      return await transport.sendMessage(chatId, text, {
        ...transportOptions,
        purpose,
        textFormat,
        formattedText
      });
    } catch (error) {
      if (textFormat === "html") {
        logger.warn("bridge.telegram.html_send_failed", {
          chatId,
          textLength: text.length,
          hasActions,
          error: error instanceof Error ? error.message : String(error)
        });
        try {
          return await transport.sendMessage(chatId, text, transportOptions);
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          if (fallbackMessage.includes("message is too long") || text.length > this.deps.maxLength) {
            try {
              return await sendPlainChunks();
            } catch (splitError) {
              logger.error("bridge.telegram.split_fallback_failed", {
                chatId,
                textLength: text.length,
                error: splitError instanceof Error ? splitError.message : String(splitError)
              });
            }
          }
          logger.error("bridge.telegram.plain_fallback_send_failed", {
            chatId,
            textLength: text.length,
            hasActions,
            error: fallbackMessage
          });
          return null;
        }
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("message is too long") || text.length > this.deps.maxLength) {
        try {
          return await sendPlainChunks();
        } catch (splitError) {
          logger.error("bridge.telegram.split_fallback_failed", {
            chatId,
            textLength: text.length,
            error: splitError instanceof Error ? splitError.message : String(splitError)
          });
        }
      }
      logger.error("bridge.telegram.send_failed", {
        chatId,
        textLength: text.length,
        hasActions,
        error: message
      });
      return null;
    }
  }

  private hasMessageTitle(text: string): boolean {
    const firstLine = text.trim().split(/\n/, 1)[0]?.trim() ?? "";
    if (!firstLine) return false;
    const boldTitle = firstLine.match(/^\*\*([^*\n]+)\*\*$/)?.[1]?.trim() ?? "";
    const title = boldTitle || firstLine;
    if (
      title === "Codex" ||
      title.startsWith("Codex · ") ||
      title === "Help" ||
      title === "Current session" ||
      title === "Sessions" ||
      title.startsWith("Sections · ")
    ) {
      return true;
    }
    if (title === "Codex account" || title.startsWith("Codex account · ")) {
      return true;
    }
    return /^(Actions|Called|Codex error|Codex stream error|Compact completed|Compact started|Decision|Decisions|Edited|Explored|Failed|MCP result|Progress|Queue|Run|Subagent|System|User|Working)(?: · .+)?$/.test(title);
  }
}
