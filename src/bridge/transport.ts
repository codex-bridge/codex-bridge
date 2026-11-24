import type { MessageSpec } from "./messages/types.js";
import type { ProgressPhaseKind } from "../shared/types.js";

/** Only separately authored, minimal notices may escape an unavailable thread. */
export type UnavailableThreadNotice =
  | { kind: "management"; text: string }
  | { kind: "action-required" };

export type BridgeMessageOptions = {
  /** Recheck revocable delivery authorization immediately before each send. */
  canSend?: () => Promise<boolean>;
  deliverySignal?: AbortSignal;
  /** Background writes yield instead of holding a chronological lock for quota. */
  onRateDeferred?: () => void;
  disable_notification?: boolean;
  formattedText?: string;
  messageSpec?: MessageSpec;
  purpose?: string;
  unavailableThreadNotice?: UnavailableThreadNotice;
  textFormat?: "plain" | "html";
};

export type BridgeSentMessage = {
  message_id: string;
};

export type MessageRefreshPolicy = { typingEnabled: boolean; workingIntervalMs: number } & (
  | { progressMode: "summary"; hiddenPhaseKinds?: readonly ProgressPhaseKind[] }
  | { progressMode?: "live"; progressIntervalMs: number }
);

export interface BridgeMessageTransport {
  readonly name: string;
  /** Native structured transports receive whole specs, without chat-platform splitting. */
  readonly wholeMessageSpecs?: boolean;
  readonly refreshPolicy?: MessageRefreshPolicy;
  /** Cancellable background admission, before taking chronological/transport locks. */
  waitForBackgroundRefresh?(sourceId: string, sessionId: string, signal: AbortSignal): Promise<boolean>;
  canHandle(chatId: string): boolean;
  sendMessageSpec?(
    chatId: string,
    messageSpec: MessageSpec,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null>;
  sendMessage(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null>;
  editMessageSpec?(
    chatId: string,
    messageId: string,
    messageSpec: MessageSpec,
    options?: BridgeMessageOptions
  ): Promise<boolean>;
  editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<boolean>;
  deleteMessage(chatId: string, messageId: string): Promise<boolean>;
  clearMessageActions(
    chatId: string,
    messageId: string,
    text?: string,
    contentBlocks?: unknown[]
  ): Promise<boolean>;
  sendTyping(chatId: string, options?: Pick<BridgeMessageOptions, "canSend">): Promise<void>;
  /** Refresh an existing conversation anchor; never create a missing one. */
  updateConversationSession?(chatId: string, messageSpec: MessageSpec): Promise<void>;
}
