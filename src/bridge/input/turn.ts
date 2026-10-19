import crypto from "node:crypto";
import { CodexAppServerClient } from "../../codex/client.js";
import type { SessionRecord } from "../../shared/types.js";
import { BridgeStore } from "../../store/index.js";
import { KeyedQueue } from "../../shared/keyed-queue.js";
import { logger } from "../../logging/logger.js";
import { createMessage } from "../messages/factory.js";
import { helpAction, messageAction, refreshAction, sessionAction } from "../messages/actions.js";
import type { MessageSpec } from "../messages/types.js";
import { SessionOwnershipService } from "../sessions/ownership.js";
import type { SessionProviderMismatch } from "../sessions/provider-state.js";
import type { IncomingTextInput } from "./preflight.js";
import type { CodexTurnInputPart } from "../../codex/client.js";
import type { CodexConfigSnapshot } from "../../codex/config-snapshot.js";
import type { StatusRuntimeState } from "../status/runtime-state.js";

function formatConfigSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|invalid[_ -]?api[_ -]?key/i.test(message)) {
    return "Codex authentication failed (401 INVALID_API_KEY). Check the Codex API key, then try again.";
  }
  const missingEnvironmentVariable =
    /(?:missing|required)\s+(?:environment variable|env(?:ironment)?[_ -]?key)\s*[:=]?\s*[`'"]?([A-Z][A-Z0-9_]*)[`'"]?/i.exec(message)?.[1] ??
    /environment variable\s+[`'"]?([A-Z][A-Z0-9_]*)[`'"]?\s+(?:is\s+)?(?:missing|not set|unset)/i.exec(message)?.[1];
  if (missingEnvironmentVariable) {
    return `Codex effective configuration is missing environment variable ${missingEnvironmentVariable}. No message was sent to Codex. Set it, then try again.`;
  }
  if (/provider reconnect failed/i.test(message)) {
    return "Codex provider reconnect failed. Fix the provider configuration, then try again.";
  }
  return "Codex effective configuration could not be synchronized. No message was sent to Codex. Use Help for diagnostics.";
}

export type IncomingTurnDependencies = {
  store: BridgeStore;
  codexClient: CodexAppServerClient;
  turnRouteQueue: KeyedQueue;
  inFlightTurnIdByThread: Map<string, string>;
  statusRuntimeState: Pick<StatusRuntimeState, "resetEditThrottle" | "getLabel">;
  lastUserInputBySession: Map<string, string>;
  sessionOwnershipService: SessionOwnershipService;
  rememberNotificationSession: (session: SessionRecord) => void;
  getSessionDirectory: (session: SessionRecord) => string;
  isStaleActiveTurnError: (error: unknown) => boolean;
  isMissingRuntimeThreadError: (error: unknown) => boolean;
  isActiveWriterConflictError: (error: unknown) => boolean;
  findProviderMismatch: (session: SessionRecord, snapshot?: CodexConfigSnapshot) => Promise<SessionProviderMismatch | null>;
  sessionRefreshCallback: (sessionId: string, leaseVersion?: number) => string;
  createIncomingPromptSpec: (kind: MessageSpec["kind"], text: string, session: SessionRecord | null) => MessageSpec;
  createSessionActionSpec: (
    session: SessionRecord,
    kind: MessageSpec["kind"],
    body: string,
    actions: MessageSpec["actions"]
  ) => MessageSpec;
  sendLongSpec: (chatId: string, messageSpec: MessageSpec) => Promise<void>;
  setSessionStatus: (session: SessionRecord, label: string) => Promise<void>;
  runDispatch?: <T>(session: SessionRecord, operation: () => Promise<T>) => Promise<T>;
};

export class IncomingTurnService {
  constructor(private readonly deps: IncomingTurnDependencies) {}

  async route(queuedSession: SessionRecord, input: IncomingTextInput, options?: {
    assertCurrent: () => void;
    beforeSend: () => Promise<void>;
    rpcTimeoutMs?: number;
  }): Promise<{ routed: boolean; prompt?: MessageSpec }> {
    return this.deps.turnRouteQueue.run(queuedSession.codexThreadId, async () => {
      const operation = () => this.routeCurrent(queuedSession, input, options);
      return this.deps.runDispatch ? this.deps.runDispatch(queuedSession, operation) : operation();
    });
  }

  private async routeCurrent(queuedSession: SessionRecord, input: IncomingTextInput, options?: {
    assertCurrent: () => void;
    beforeSend: () => Promise<void>;
    rpcTimeoutMs?: number;
  }): Promise<{ routed: boolean; prompt?: MessageSpec }> {
      options?.assertCurrent();
      const routedSession: SessionRecord = queuedSession;
      this.deps.rememberNotificationSession(routedSession);
      if (await this.deps.store.hasTelegramMessage(routedSession.id, input.telegramMessageId)) {
        options?.assertCurrent();
        logger.info("bridge.message.duplicate_ignored", {
          chatId: input.telegramChatId,
          sessionId: routedSession.id,
          telegramMessageId: input.telegramMessageId
        });
        return { routed: true };
      }
      options?.assertCurrent();

      let turn: { turnId: string | null };
      let configSnapshot: CodexConfigSnapshot | undefined;
      let route: "start" | "steer" | "steer-fallback-start" = "start";
      const activeTurnId = this.deps.inFlightTurnIdByThread.get(routedSession.codexThreadId) ?? null;
      if (input.queue) {
        if (!activeTurnId) {
          return {
            routed: false,
            prompt: this.deps.createIncomingPromptSpec("queue", "Queue is only available while Codex is working. Send the message normally when the session is idle.", routedSession)
          };
        }
        const clientUserMessageId = `bridge-queue-${crypto.randomUUID()}`;
        const inputParts = input.inputParts?.length ? input.inputParts : [{ type: "text" as const, text: input.text }];
        const record = await this.deps.store.createQueuedSubmission({
          sessionId: routedSession.id, telegramChatId: input.telegramChatId,
          codexThreadId: routedSession.codexThreadId, codexQueueId: null,
          clientUserMessageId, sourceMessageId: input.telegramMessageId,
          summary: input.text.trim().replace(/\s+/g, " ").slice(0, 160) || "Attachment message",
          attachmentPaths: inputParts.filter((part): part is Exclude<CodexTurnInputPart, { type: "text" }> =>
            part.type !== "text").map((part) => part.path),
          state: "submitting"
        });
        await this.deps.store.addMessage({ sessionId: routedSession.id, role: "user", text: input.text,
          codexTurnId: null, telegramMessageId: input.telegramMessageId });
        try {
          const queued = await this.deps.codexClient.addQueuedSubmission(routedSession.codexThreadId, inputParts, clientUserMessageId);
          await this.deps.store.markQueuedSubmissionAccepted(record.id, queued.id);
        } catch {
          const found = (await this.deps.codexClient.listQueuedSubmissions(routedSession.codexThreadId).catch(() => []))
            .find((item) => item.clientUserMessageId === clientUserMessageId);
          if (found) await this.deps.store.markQueuedSubmissionAccepted(record.id, found.id);
          else await this.deps.store.updateQueuedSubmission(record.id, { state: "unknown" });
          if (!found) {
            const text = "Queue submission outcome is unknown. It will not be retried automatically.";
            await this.deps.sendLongSpec(input.telegramChatId, createMessage({
              kind: "error",
              session: { id: routedSession.id, directory: this.deps.getSessionDirectory(routedSession) },
              body: [{ type: "text", text }]
            }));
            return { routed: true };
          }
        }
        this.deps.rememberNotificationSession(routedSession);
        const queueText = `Queued\n${record.summary}`;
        const queueCallback = `queue:cancel:${record.id}`;
        await this.deps.sendLongSpec(input.telegramChatId, createMessage({
          kind: "queue",
          session: { id: routedSession.id, directory: this.deps.getSessionDirectory(routedSession) },
          body: [{ type: "text", text: queueText }],
          actions: [messageAction("cancel", "Cancel queued message", queueCallback)]
        }));
        this.deps.statusRuntimeState.resetEditThrottle(routedSession.id);
        await this.deps.setSessionStatus(routedSession, this.deps.statusRuntimeState.getLabel(routedSession.id) ?? "Working");
        return { routed: true };
      }
      if (!activeTurnId) {
        if (typeof this.deps.codexClient.readCodexConfigSnapshot === "function") {
          try {
            configSnapshot = await this.deps.codexClient.readCodexConfigSnapshot(
              this.deps.getSessionDirectory(routedSession)
            );
            const mismatch = await this.deps.findProviderMismatch(routedSession, configSnapshot);
            if (mismatch) {
              const text = [
                `This session uses provider ${mismatch.threadProvider}.`,
                `Codex config now uses ${mismatch.configProvider}.`,
                "No message was sent to Codex. Choose another session to continue."
              ].join("\n");
              return {
                routed: false,
                prompt: this.deps.createSessionActionSpec(
                  routedSession,
                  "error",
                  text,
                  [sessionAction(), helpAction()]
                )
              };
            }
          } catch (error) {
            logger.warn("bridge.message.config_sync_failed", {
              chatId: input.telegramChatId,
              sessionId: routedSession.id,
              threadId: routedSession.codexThreadId,
              error: error instanceof Error ? error.message : String(error)
            });
            return {
              routed: false,
              prompt: this.deps.createSessionActionSpec(
                routedSession,
                "error",
                formatConfigSyncError(error),
                [sessionAction(), helpAction()]
              )
            };
          }
        }
      }
      await options?.beforeSend();
      options?.assertCurrent();
      try {
        if (activeTurnId) {
          turn = await this.deps.codexClient.steerTurn(routedSession.codexThreadId, activeTurnId, input.text,
            input.inputParts, options?.assertCurrent, options?.rpcTimeoutMs);
          route = "steer";
        } else {
          turn = await this.deps.codexClient.sendTurn(
            routedSession.codexThreadId,
            input.text,
            this.deps.getSessionDirectory(routedSession),
            {
              inputParts: input.inputParts,
              configSnapshot,
              assertCurrent: options?.assertCurrent,
              timeoutMs: options?.rpcTimeoutMs
            }
          );
        }
      } catch (error) {
        if (activeTurnId && this.deps.isStaleActiveTurnError(error)) {
          await options?.beforeSend();
          options?.assertCurrent();
          this.deps.inFlightTurnIdByThread.delete(routedSession.codexThreadId);
          turn = await this.deps.codexClient.sendTurn(
            routedSession.codexThreadId,
            input.text,
            this.deps.getSessionDirectory(routedSession),
            { inputParts: input.inputParts, assertCurrent: options?.assertCurrent, timeoutMs: options?.rpcTimeoutMs }
          );
          route = "steer-fallback-start";
        } else if (this.deps.isMissingRuntimeThreadError(error)) {
          logger.warn("bridge.message.session_unavailable", {
            chatId: input.telegramChatId,
            sessionId: routedSession.id,
            threadId: routedSession.codexThreadId,
            error: error instanceof Error ? error.message : String(error)
          });
          return {
            routed: false,
            prompt: this.deps.createSessionActionSpec(
              routedSession,
              "error",
              "This Codex session could not be restored. No replacement session was created, so its history remains unchanged. Refresh the session or choose New session from the session menu.",
              [refreshAction(this.deps.sessionRefreshCallback(routedSession.id)), sessionAction(), helpAction()]
            )
          };
        } else if (this.deps.isActiveWriterConflictError(error)) {
          const lease = this.deps.store.markSessionExternalUnknown(routedSession.id);
          logger.warn("bridge.message.active_writer_conflict", {
            chatId: input.telegramChatId,
            sessionId: routedSession.id,
            threadId: routedSession.codexThreadId,
            error: error instanceof Error ? error.message : String(error)
          });
          const ownershipPrompt = options ? null : await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(routedSession, input.telegramChatId, { retryExternal: false });
          const fallbackText = "This session is occupied outside the Bridge. Wait for the external Codex operation to finish, then refresh.";
          const fallbackSpec = this.deps.createSessionActionSpec(routedSession, "error", fallbackText, [
            refreshAction(this.deps.sessionRefreshCallback(routedSession.id, lease.version))
          ]);
          return { routed: false, prompt: ownershipPrompt ?? fallbackSpec };
        } else {
          throw error;
        }
      }
      if (turn.turnId) {
        this.deps.inFlightTurnIdByThread.set(routedSession.codexThreadId, turn.turnId);
        const binding = this.deps.store.getSessionBinding(routedSession.id, input.telegramChatId);
        this.deps.store.recordTurnRoute({
          turnId: turn.turnId,
          sessionId: routedSession.id,
          codexThreadId: routedSession.codexThreadId,
          bindingId: binding?.id ?? null,
          sourceId: input.telegramChatId
        });
        if (!this.deps.store.setSessionOwnerTurn(routedSession.id, input.telegramChatId, turn.turnId)) {
          logger.warn("bridge.session.owner_turn_not_recorded", {
            chatId: input.telegramChatId,
            sessionId: routedSession.id,
            threadId: routedSession.codexThreadId,
            turnId: turn.turnId
          });
        }
      }
      this.deps.lastUserInputBySession.set(routedSession.id, input.text);
      logger.info("bridge.message.routed", {
        chatId: input.telegramChatId,
        sessionId: routedSession.id,
        threadId: routedSession.codexThreadId,
        turnId: turn.turnId,
        route
      });
      await this.deps.store.addMessage({
        sessionId: routedSession.id,
        role: "user",
        text: input.text,
        codexTurnId: turn.turnId,
        telegramMessageId: input.telegramMessageId
      });
      return { routed: true };
  }
}
