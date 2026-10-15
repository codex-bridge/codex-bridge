import type { CodexTurnInputPart } from "../codex/client.js";
import type {
  DecisionAction,
  MessageRecord,
  SessionRecord
} from "../shared/types.js";
import type { IncomingAttachment } from "./input/payload.js";
import type { ActionSpec, MessageSpec, SessionContext } from "./messages/types.js";
import type { BridgeMessageTransport } from "./transport.js";

export type SessionTranscript = {
  session: SessionRecord;
  recentMessages: Array<Pick<MessageRecord, "role" | "text">>;
};

type TurnInput = {
  inputParts?: CodexTurnInputPart[];
  queue?: boolean;
  telegramChatId: string;
  telegramMessageId: string;
  text: string;
};

type TurnRouteResult = { routed: boolean; prompt?: MessageSpec };

type GoalStatus = "active" | "paused" | "complete";

export interface BridgeChatPort {
  ensureChatAllowed(chatId: string): Promise<void>;
  getActiveSession(chatId: string): Promise<SessionRecord | null>;
  getActiveSessionContext(chatId: string): Promise<SessionContext | undefined>;
  getHelpMenuActions(chatId: string): Promise<ActionSpec[]>;
  isRuntimeConnected(): boolean;
}

export interface BridgeInputPort {
  handleIncomingUserPayload(input: {
    attachments: IncomingAttachment[];
    queue?: boolean;
    telegramChatId: string;
    telegramMessageId: string;
    text: string;
  }): Promise<TurnRouteResult>;
  handleIncomingUserText(input: TurnInput): Promise<TurnRouteResult>;
}

export interface BridgeSessionMenuPort {
  renderSessionMenu(
    chatId: string,
    page?: number,
    options?: { refresh?: boolean; includeUnknownThreads?: boolean; reuseSnapshot?: boolean }
  ): Promise<MessageSpec>;
  renderArchivedSessionMenu(chatId: string, page?: number): Promise<MessageSpec>;
  renderSessionSectionMenu(chatId: string, directoryHash: string, page?: number): Promise<MessageSpec>;
  requestCreateSessionForCurrentDirectory(chatId: string): Promise<MessageSpec>;
  requestCreateSessionFromDirectorySelector(chatId: string, directoryHash: string): Promise<MessageSpec>;
  unarchiveSession(chatId: string, sessionId: string): Promise<MessageSpec>;
}

export interface BridgeSessionMutationPort {
  requestSessionHandoff(chatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec>;
  archiveSession(chatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec>;
  requestDeleteSession(chatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec>;
  deleteSession(chatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec>;
  releaseBridgeSessionLock(chatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec>;
  releaseCodexSession(chatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<MessageSpec>;
}

export interface BridgeSessionSelectionPort {
  activateSection(chatId: string, sessionId: string): Promise<SessionTranscript>;
  activateSession(chatId: string, sessionId: string): Promise<SessionTranscript>;
  activateSectionFromSelector(chatId: string, sessionId: string): Promise<SessionTranscript>;
  activateSessionFromSelector(chatId: string, sessionId: string): Promise<SessionTranscript>;
  getSessionArchiveCallback(chatId: string, sessionId: string): Promise<string | null>;
  getSessionDeleteCallback(chatId: string, sessionId: string): Promise<string | null>;
  getSessionReleaseBridgeCallback(chatId: string, sessionId: string): Promise<string | null>;
  renderSelectedSessionSpec(session: SessionRecord, actions?: MessageSpec["actions"]): Promise<MessageSpec>;
  refreshSessionView(chatId: string, sessionId: string, expectedLeaseVersion?: number): Promise<SessionTranscript>;
  postSessionSwitchTranscript(
    chatId: string,
    session: SessionRecord,
    recentMessages?: Array<Pick<MessageRecord, "role" | "text">>,
    options?: {
      heading?: string;
      purpose?: "session_switch" | "session_refresh";
    }
  ): Promise<void>;
  postSessionRefreshStatus(chatId: string, session: SessionRecord): Promise<void>;
  removeSessionRefreshStatus(chatId: string, sessionId: string): Promise<void>;
  renameActiveSectionMessage(chatId: string, nameInput: string): Promise<MessageSpec>;
}

export interface BridgeGoalPort {
  renderActiveGoal(chatId: string): Promise<MessageSpec>;
  renderSelectedGoal(chatId: string, sessionId: string): Promise<MessageSpec>;
  setActiveGoalObjective(chatId: string, objective: string): Promise<MessageSpec>;
  updateActiveGoalStatus(chatId: string, status: GoalStatus): Promise<MessageSpec>;
  updateGoalStatus(chatId: string, sessionId: string, status: GoalStatus): Promise<MessageSpec>;
  clearActiveGoal(chatId: string): Promise<MessageSpec>;
  clearGoal(chatId: string, sessionId: string): Promise<MessageSpec>;
  requestClearActiveGoal(chatId: string): Promise<MessageSpec>;
  requestClearGoal(chatId: string, sessionId: string): Promise<MessageSpec>;
  renderGoalsMenu(chatId: string, page?: number): Promise<MessageSpec>;
}

export interface BridgeRuntimePort {
  connectBotRuntimeMessage(chatId: string): Promise<MessageSpec>;
  disconnectBotRuntimeMessage(chatId: string): Promise<MessageSpec>;
  restartServiceMessage(chatId: string): Promise<MessageSpec>;
}

export interface BridgeTurnControlPort {
  stopActiveSessionMessage(chatId: string): Promise<MessageSpec>;
  compactActiveSessionMessage(chatId: string): Promise<MessageSpec>;
  statusActiveSessionMessage(chatId: string, full?: boolean): Promise<MessageSpec>;
  cancelQueuedSubmission(chatId: string, submissionId: string): Promise<MessageSpec>;
}

export interface BridgeDecisionPort {
  handleDecision(
    decisionId: string,
    action: DecisionAction,
    sourceId?: string
  ): Promise<{ ok: boolean; message: string }>;
  handleBatchDecision(
    sessionId: string,
    action: Extract<DecisionAction, "accept" | "decline" | "cancel">,
    sourceId?: string,
    expectedLeaseVersion?: number
  ): Promise<{ ok: boolean; message: string }>;
}

export interface BridgeMessagePort {
  registerMessageTransport(transport: BridgeMessageTransport): void;
  envelopeChatMessage(chatId: string, text: string): Promise<string>;
}

export type BridgeCoreInteractionPort =
  & BridgeChatPort
  & BridgeSessionMenuPort
  & BridgeSessionMutationPort
  & BridgeGoalPort
  & BridgeRuntimePort
  & BridgeTurnControlPort
  & BridgeDecisionPort;

export type BridgeSlackMessagePort =
  & BridgeChatPort
  & BridgeInputPort
  & BridgeSessionMenuPort
  & BridgeGoalPort
  & BridgeRuntimePort
  & BridgeTurnControlPort
  & Pick<BridgeSessionSelectionPort, "renameActiveSectionMessage">;

export type BridgeSlackSessionWorkflowPort =
  & BridgeChatPort
  & Pick<BridgeSessionMenuPort, "requestCreateSessionForCurrentDirectory">
  & BridgeSessionSelectionPort;

export type BridgeSlackTurnWorkflowPort =
  & BridgeChatPort
  & BridgeInputPort
  & BridgeMessagePort;

export type BridgeSlackInteractionPort =
  & BridgeCoreInteractionPort
  & BridgeSlackSessionWorkflowPort
  & BridgeSlackTurnWorkflowPort;

export type BridgeTelegramTurnWorkflowPort =
  & BridgeChatPort
  & BridgeInputPort
  & Pick<BridgeSessionMenuPort, "requestCreateSessionForCurrentDirectory">;

export type BridgeTelegramSessionWorkflowPort =
  & BridgeSessionSelectionPort;

export type BridgeTelegramInteractionPort =
  & BridgeCoreInteractionPort
  & BridgeTelegramTurnWorkflowPort
  & BridgeTelegramSessionWorkflowPort;

export type BridgeTelegramBotPort =
  & BridgeTelegramInteractionPort
  & Pick<BridgeSessionSelectionPort, "renameActiveSectionMessage">;

export type BridgeSlackBotPort =
  & BridgeMessagePort
  & BridgeSlackMessagePort
  & BridgeSlackInteractionPort;
