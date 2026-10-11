import type { BridgeMessageOptions } from "../transport.js";
import type { MessageDeliveryService } from "./sender.js";
import type { MessageSpec } from "./types.js";
import type { SessionTranscriptHistoryBlock } from "../sessions/transcript.js";
import type { TelegramTextChunk } from "../../telegram/text.js";

export const HISTORY_DELIVERY_LAUNCH_INTERVAL_MS = 250;
export const HISTORY_DELIVERY_MAX_IN_FLIGHT = 2;

export type HistoryDeliveryDependencies = {
  sender: Pick<
    MessageDeliveryService,
    "sendConcurrentTextBatch" | "sendLongSpec" | "sendLongText"
  >;
  formatCodexTelegramHtml: (text: string) => TelegramTextChunk[] | null;
  sendTelegramTextChunksAndGetLastMessage: (
    chatId: string,
    chunks: TelegramTextChunk[],
    options?: Pick<BridgeMessageOptions, "purpose">
  ) => Promise<{ messageId: string; text: string } | null>;
};

export class HistoryDeliveryService {
  constructor(private readonly deps: HistoryDeliveryDependencies) {}

  async sendHistoryBlocks(
    chatId: string,
    blocks: SessionTranscriptHistoryBlock[],
    purpose: string
  ): Promise<void> {
    if (!chatId.startsWith("slack:")) {
      for (const block of blocks) {
        await this.sendHistoryBlock(block.text, block.assistant, chatId, purpose, block.messageSpec);
      }
      return;
    }

    const total = blocks.length;
    await this.deps.sender.sendConcurrentTextBatch(
      chatId,
      blocks.map((block, index) => ({
        text: `${block.text.trimEnd()}\n\n_(${String(index + 1).padStart(2, "0")}/${String(total).padStart(2, "0")})_`,
        options: {
          purpose,
          textFormat: "html" as const,
          ...(block.messageSpec ? { messageSpec: this.addHistorySequence(block.messageSpec, index, total) } : {})
        }
      })),
      {
        launchIntervalMs: HISTORY_DELIVERY_LAUNCH_INTERVAL_MS,
        maxInFlight: HISTORY_DELIVERY_MAX_IN_FLIGHT
      }
    );
  }

  private async sendHistoryBlock(
    text: string,
    assistant: boolean,
    chatId: string,
    purpose: string,
    messageSpec: MessageSpec | null
  ): Promise<void> {
    if (!assistant) {
      if (messageSpec) {
        await this.deps.sender.sendLongSpec(chatId, messageSpec, { purpose });
      } else {
        await this.deps.sender.sendLongText(chatId, text, { purpose, textFormat: "html" });
      }
      return;
    }
    if (messageSpec) {
      await this.deps.sender.sendLongSpec(chatId, messageSpec, { purpose });
      return;
    }

    const formattedChunks = this.deps.formatCodexTelegramHtml(text);
    if (formattedChunks) {
      await this.deps.sendTelegramTextChunksAndGetLastMessage(chatId, formattedChunks, { purpose });
    } else {
      await this.deps.sender.sendLongText(chatId, text, { purpose, textFormat: "html" });
    }
  }

  private addHistorySequence(spec: MessageSpec, index: number, total: number): MessageSpec {
    return {
      ...spec,
      body: [
        ...spec.body,
        { type: "text", text: `(${String(index + 1).padStart(2, "0")}/${String(total).padStart(2, "0")})` }
      ]
    };
  }
}
