import { CodexAppServerClient } from "../../codex/client.js";
import { logger } from "../../logging/logger.js";
import type { DecisionRecord, SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { createMessage, messageContextForSession } from "../messages/factory.js";
import { helpAction } from "../messages/actions.js";
import type { CodexTurnInputPart } from "../../codex/client.js";
import type { MessageSpec } from "../messages/types.js";
import { SessionActivationError, SessionOwnershipService } from "../sessions/ownership.js";
import { validateDecisionInput } from "../decisions/formatters.js";

export type IncomingTextInput = {
  inputParts?: CodexTurnInputPart[];
  queue?: boolean;
  telegramChatId: string;
  telegramMessageId: string;
  text: string;
};

export type IncomingPreflightResult =
  | { kind: "ready"; session: SessionRecord }
  | { kind: "response"; response: { routed: boolean; prompt?: MessageSpec } };

export type IncomingPreflightDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  sessionOwnershipService: SessionOwnershipService;
  ensureChatAllowed: (chatId: string) => Promise<void>;
  isRuntimeConnected: () => boolean;
  getActiveSession: (chatId: string) => Promise<SessionRecord | null>;
  recoverSlackDmActiveSession: (chatId: string) => Promise<SessionRecord | null>;
  getSessionDirectory: (session: SessionRecord) => string;
  createIncomingPromptSpec: (kind: MessageSpec["kind"], text: string, session: SessionRecord | null) => MessageSpec;
  createMcpInputPromptSpec: (session: SessionRecord, decision: DecisionRecord, errorMessage?: string) => MessageSpec;
  sendLongSpec: (chatId: string, messageSpec: MessageSpec) => Promise<void>;
  syncBatchDecisionMessageForSessionId: (sessionId: string) => Promise<void>;
  renderSessionMenu: (chatId: string, page: number, options: { refresh: boolean }) => Promise<MessageSpec>;
};

export class IncomingPreflightService {
  constructor(private readonly deps: IncomingPreflightDependencies) {}

  async run(input: IncomingTextInput): Promise<IncomingPreflightResult> {
    await this.deps.ensureChatAllowed(input.telegramChatId);

    if (!this.deps.isRuntimeConnected()) {
      const selected = await this.deps.getActiveSession(input.telegramChatId);
      return {
        kind: "response",
        response: {
          routed: false,
          prompt: this.deps.createIncomingPromptSpec("error", "Codex runtime is disconnected.\nUse /bot_connect to reconnect.", selected)
        }
      };
    }

    let activeSession =
      (await this.deps.getActiveSession(input.telegramChatId)) ??
      (await this.deps.recoverSlackDmActiveSession(input.telegramChatId));
    if (activeSession) {
      const selectedId = activeSession.id;
      try {
        const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(activeSession, input.telegramChatId, {
          assertCurrent: async () => {
            if ((await this.deps.getActiveSession(input.telegramChatId))?.id !== selectedId) {
              throw new SessionActivationError(this.deps.createIncomingPromptSpec("system",
                "The session selection changed. Send your message again in the selected session.", activeSession));
            }
          }
        });
        if (ownershipPrompt) return { kind: "response", response: { routed: false, prompt: ownershipPrompt } };
      } catch (error) {
        if (!(error instanceof SessionActivationError)) throw error;
        return { kind: "response", response: { routed: false, prompt: error.messageSpec } };
      }
    }

    const pendingElicitation = await this.deps.store.getAwaitingInputDecisionForChat(input.telegramChatId);
    if (pendingElicitation) {
      const currentSession = await this.deps.getActiveSession(input.telegramChatId);
      if (!currentSession || currentSession.id !== pendingElicitation.sessionId) {
        const original = await this.deps.store.getSessionById(pendingElicitation.sessionId);
        await this.deps.store.resolveDecision(pendingElicitation.id, "stale");
        const text = "The MCP form is no longer tied to the active session. Switch back to that session and try again.";
        return {
          kind: "response",
          response: {
            routed: false,
            prompt: createMessage({
              kind: "mcp",
              ...messageContextForSession(original ? {
                id: original.id, directory: this.deps.getSessionDirectory(original)
              } : null),
              titleLabel: "MCP Input Required",
              body: [{ type: "text", text }],
              actions: [helpAction()]
            })
          }
        };
      }

      try {
        const content = validateDecisionInput(pendingElicitation, JSON.parse(input.text));

        await this.deps.codexClient.resolveApproval(
          pendingElicitation.approvalId,
          "accept",
          "mcpServer/elicitation/request",
          content
        );
        await this.deps.store.resolveDecision(pendingElicitation.id, "approved");
        await this.deps.syncBatchDecisionMessageForSessionId(pendingElicitation.sessionId);
        logger.info("bridge.elicitation.submitted", {
          chatId: input.telegramChatId,
          decisionId: pendingElicitation.id,
          fields: Object.keys(content)
        });
        const submittedSpec = createMessage({
          kind: "mcp",
          session: {
            id: currentSession.id,
            directory: this.deps.getSessionDirectory(currentSession)
          },
          body: [{ type: "text", text: "Submitted the MCP response." }],
          actions: [helpAction()]
        });
        await this.deps.sendLongSpec(input.telegramChatId, submittedSpec);
        return { kind: "response", response: { routed: true } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          kind: "response",
          response: {
            routed: false,
            prompt: this.deps.createMcpInputPromptSpec(currentSession, pendingElicitation, message)
          }
        };
      }
    }

    activeSession =
      (await this.deps.getActiveSession(input.telegramChatId)) ??
      (await this.deps.recoverSlackDmActiveSession(input.telegramChatId));
    if (!activeSession) {
      logger.warn("bridge.message.no_active_session", {
        chatId: input.telegramChatId,
        text: input.text
      });
      const menu = await this.deps.renderSessionMenu(input.telegramChatId, 0, { refresh: false });
      return { kind: "response", response: { routed: false, prompt: menu } };
    }

    return { kind: "ready", session: activeSession };
  }
}
