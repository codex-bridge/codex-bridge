import type { KnownBlock } from "@slack/types";

import type { BridgeSlackSessionWorkflowPort } from "../../bridge/contracts.js";
import { SessionActivationError } from "../../bridge/sessions/ownership.js";
import {
  archiveAction,
  deleteAction,
  helpAction,
  messageAction,
  sessionAction
} from "../../bridge/messages/actions.js";
import { createMessage, messageContextForSession } from "../../bridge/messages/factory.js";
import type { InteractionContext } from "../../bridge/interactions/types.js";
import type { ActionSpec } from "../../bridge/messages/types.js";
import { sessionActionResultDelivery } from "../../bridge/interactions/session-delivery.js";
import { logger } from "../../logging/logger.js";
import { isLockedSlackThread, isSlackThreadChatId } from "../routing.js";
import type { SlackMessageTransport } from "../transport.js";
import { isSlackThreadParent } from "./context.js";
import { deliverSlackInteraction } from "./responder.js";

type SessionWorkflowAction =
  | { type: "session.create-current" }
  | { type: "session.select"; sessionId: string; legacySection: boolean }
  | { type: "session.refresh"; sessionId: string; expectedLeaseVersion?: number };

export function parseSessionWorkflowAction(value: string): SessionWorkflowAction | null {
  if (value === "quick:session_new") return { type: "session.create-current" };
  if (value.startsWith("section:")) {
    return { type: "session.select", sessionId: value.slice("section:".length), legacySection: true };
  }
  if (value.startsWith("session:")) {
    return { type: "session.select", sessionId: value.slice("session:".length), legacySection: false };
  }
  if (value.startsWith("session-refresh:")) {
    const [, sessionId = "", versionText] = value.split(":");
    const version = versionText === undefined ? undefined : Number(versionText);
    return {
      type: "session.refresh",
      sessionId,
      expectedLeaseVersion: Number.isFinite(version) ? version : undefined
    };
  }
  return null;
}

async function renderSelectedSessionActions(
  service: BridgeSlackSessionWorkflowPort,
  chatId: string,
  session: Awaited<ReturnType<BridgeSlackSessionWorkflowPort["getActiveSession"]>>
): Promise<ActionSpec[]> {
  if (!session) return [];
  const archiveCallback = session ? await service.getSessionArchiveCallback(chatId, session.id) : null;
  const deleteCallback = session ? await service.getSessionDeleteCallback(chatId, session.id) : null;
  const releaseCallback = session ? await service.getSessionReleaseBridgeCallback(chatId, session.id) : null;
  const actions: ActionSpec[] = [helpAction(), sessionAction()];
  if (archiveCallback || deleteCallback) {
    if (archiveCallback) actions.push(archiveAction(archiveCallback, "Current session"));
    if (deleteCallback) actions.push(deleteAction(deleteCallback, "Current session"));
  }
  if (releaseCallback) actions.push(messageAction("release", "Release to Codex", releaseCallback, "Current session"));
  return actions;
}

export async function handleSlackSessionWorkflow(input: {
  action: string;
  context: InteractionContext;
  messageBlocks: KnownBlock[] | null;
  messageText: string | null;
  service: BridgeSlackSessionWorkflowPort;
  transport: SlackMessageTransport;
}): Promise<boolean> {
  const action = parseSessionWorkflowAction(input.action);
  if (!action) return false;

  const { context, service, transport } = input;
  const chatId = context.conversationId;

  if (action.type === "session.create-current") {
    if (await isLockedSlackThread(service, chatId)) {
      await transport.sendMessageSpec(chatId, createMessage({
        kind: "system",
        titleLabel: "Codex",
        ...messageContextForSession(await service.getActiveSessionContext(chatId)),
        body: [{ type: "text", text: "This thread is already bound to a session." }],
        actions: [helpAction(), sessionAction()]
      }));
      return true;
    }
    await deliverSlackInteraction(transport, context, sessionActionResultDelivery(context,
      await service.requestCreateSessionForCurrentDirectory(chatId)));
    return true;
  }

  if (action.type === "session.select") {
    let activation: Awaited<ReturnType<BridgeSlackSessionWorkflowPort["activateSessionFromSelector"]>>;
    try {
      activation = action.legacySection
        ? await service.activateSectionFromSelector(chatId, action.sessionId)
        : await service.activateSessionFromSelector(chatId, action.sessionId);
    } catch (error) {
      if (!(error instanceof SessionActivationError)) throw error;
      await deliverSlackInteraction(transport, context, sessionActionResultDelivery(context, error.messageSpec));
      return true;
    }
    const { session, recentMessages } = activation;
    // The state-change hook already refreshed this anchor with current binding data.
    // Do not overwrite it with a receipt or an older delayed activation result.
    if (!isSlackThreadParent(context)) {
      const selectionActions = isSlackThreadChatId(context.surfaceId)
        ? await renderSelectedSessionActions(service, chatId, session)
        : [];
      await deliverSlackInteraction(transport, context, sessionActionResultDelivery(context,
        await service.renderSelectedSessionSpec(session, selectionActions)));
    }
    await service.postSessionSwitchTranscript(chatId, session, recentMessages, {
      ...(action.legacySection ? { heading: "Switched to section" } : {})
    });
    return true;
  }

  const startedAt = Date.now();
  logger.info("slack.session.refresh_action_received", {
    conversationId: chatId,
    surfaceId: context.surfaceId,
    sessionId: action.sessionId,
    messageTs: context.sourceMessageId ?? null,
    expectedLeaseVersion: action.expectedLeaseVersion ?? null
  });
  let refreshed;
  try { refreshed = await service.refreshSessionView(chatId, action.sessionId, action.expectedLeaseVersion); }
  catch (error) {
    if (!(error instanceof SessionActivationError)) throw error;
    await deliverSlackInteraction(transport, context, sessionActionResultDelivery(context, error.messageSpec));
    return true;
  }
  if (context.sourceMessageId) {
    await transport.clearMessageActions(
      context.surfaceId,
      context.sourceMessageId,
      input.messageText ?? undefined,
      input.messageBlocks ?? undefined
    );
  }
  await service.removeSessionRefreshStatus(chatId, refreshed.session.id);
  await service.postSessionSwitchTranscript(chatId, refreshed.session, refreshed.recentMessages, {
    purpose: "session_refresh"
  });
  logger.info("slack.session.refresh_delivery_completed", {
    conversationId: chatId,
    surfaceId: context.surfaceId,
    sessionId: refreshed.session.id,
    messageTs: context.sourceMessageId ?? null,
    elapsedMs: Date.now() - startedAt
  });
  return true;
}
