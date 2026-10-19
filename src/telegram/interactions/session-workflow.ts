import type { InteractionContext } from "../../bridge/interactions/types.js";
import type { BridgeTelegramSessionWorkflowPort } from "../../bridge/contracts.js";
import { SessionActivationError } from "../../bridge/sessions/ownership.js";
import { logger } from "../../logging/logger.js";
import type { TelegramInteractionResponder } from "./responder.js";

function parseVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const version = Number(value);
  return Number.isFinite(version) ? version : undefined;
}

export async function handleTelegramSessionWorkflow(input: {
  action: string;
  acknowledge: (text?: string) => Promise<void>;
  context: InteractionContext;
  responder: TelegramInteractionResponder;
  service: BridgeTelegramSessionWorkflowPort;
}): Promise<boolean> {
  const { action, context, responder, service } = input;
  const chatId = context.conversationId;

  if (action.startsWith("section:") || action.startsWith("session:")) {
    const legacySection = action.startsWith("section:");
    const sessionId = action.slice(legacySection ? "section:".length : "session:".length);
    await input.acknowledge(legacySection ? "Switching section..." : "Session switched.");
    try {
      const activation = legacySection
        ? await service.activateSection(chatId, sessionId)
        : await service.activateSession(chatId, sessionId);
      await service.postSessionSwitchTranscript(
        chatId,
        activation.session,
        activation.recentMessages,
        {
          ...(legacySection ? { heading: "Switched to section" } : {})
        }
      );
    } catch (error) {
      if (!(error instanceof SessionActivationError)) throw error;
      await responder.edit(error.messageSpec);
    }
    return true;
  }

  if (!action.startsWith("session-refresh:")) return false;

  const startedAt = Date.now();
  const [, sessionId = "", versionText] = action.split(":");
  const expectedLeaseVersion = parseVersion(versionText);
  logger.info("telegram.session.refresh_action_received", {
    chatId,
    sessionId,
    messageId: context.sourceMessageId ?? null,
    expectedLeaseVersion: expectedLeaseVersion ?? null
  });
  await input.acknowledge("Refreshing...");
  let refreshed;
  try { refreshed = await service.refreshSessionView(chatId, sessionId, expectedLeaseVersion); }
  catch (error) {
    if (!(error instanceof SessionActivationError)) throw error;
    await responder.edit(error.messageSpec);
    return true;
  }
  await responder.clearActions();
  logger.info("telegram.session.refresh_original_actions_cleared", {
    chatId,
    sessionId: refreshed.session.id,
    messageId: context.sourceMessageId ?? null
  });
  await service.removeSessionRefreshStatus(chatId, refreshed.session.id);
  await service.postSessionSwitchTranscript(chatId, refreshed.session, refreshed.recentMessages, {
    purpose: "session_refresh"
  });
  logger.info("telegram.session.refresh_delivery_completed", {
    chatId,
    sessionId: refreshed.session.id,
    messageId: context.sourceMessageId ?? null,
    elapsedMs: Date.now() - startedAt
  });
  return true;
}
