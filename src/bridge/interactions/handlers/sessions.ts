import type {
  BridgeSessionMenuPort,
  BridgeSessionMutationPort
} from "../../contracts.js";
import type { MessageSpec } from "../../messages/types.js";
import type { SessionInteractionAction } from "../action.js";
import type { InteractionContext, InteractionDelivery } from "../types.js";
import { sessionActionResultDelivery, sessionSelectorDelivery } from "../session-delivery.js";

export async function handleOpenSessionsAction(
  service: Pick<BridgeSessionMenuPort, "renderSessionMenu">,
  context: InteractionContext
): Promise<InteractionDelivery> {
  return {
    mode: "send",
    target: "conversation",
    message: await service.renderSessionMenu(context.conversationId, 0, { refresh: true, includeUnknownThreads: true })
  };
}

export async function handleSessionAction(
  service: BridgeSessionMenuPort & BridgeSessionMutationPort,
  context: InteractionContext,
  action: SessionInteractionAction
): Promise<InteractionDelivery> {
  const chatId = context.conversationId;
  let message: MessageSpec;
  switch (action.type) {
    case "session.handoff":
      message = await service.requestSessionHandoff(chatId, action.sessionId, action.expectedLeaseVersion);
      break;
    case "session.archive":
      message = await service.archiveSession(chatId, action.sessionId, action.expectedLeaseVersion);
      break;
    case "session.delete.request":
      message = await service.requestDeleteSession(chatId, action.sessionId, action.expectedLeaseVersion);
      break;
    case "session.delete.confirm":
      message = await service.deleteSession(chatId, action.sessionId, action.expectedLeaseVersion);
      break;
    case "session.release":
      message = action.owner === "bridge"
        ? await service.releaseBridgeSessionLock(chatId, action.sessionId, action.expectedLeaseVersion)
        : await service.releaseCodexSession(chatId, action.sessionId, action.expectedLeaseVersion);
      break;
    case "session.directory.open":
    case "session.directory.page":
      return sessionSelectorDelivery(await service.renderSessionSectionMenu(chatId, action.directoryHash, action.page));
    case "session.create":
      message = await service.requestCreateSessionFromDirectorySelector(chatId, action.directoryHash);
      break;
    case "session.menu.refresh":
      return sessionSelectorDelivery(await service.renderSessionMenu(chatId, 0, { refresh: true, includeUnknownThreads: true }));
    case "session.archived.open":
      return sessionSelectorDelivery(await service.renderArchivedSessionMenu(chatId, 0));
    case "session.archived.page":
      return sessionSelectorDelivery(await service.renderArchivedSessionMenu(chatId, action.page));
    case "session.unarchive":
      message = await service.unarchiveSession(chatId, action.sessionId);
      break;
    case "session.menu.page":
      return sessionSelectorDelivery(await service.renderSessionMenu(chatId, action.page, { refresh: false, reuseSnapshot: true }));
  }
  return sessionActionResultDelivery(context, message);
}
