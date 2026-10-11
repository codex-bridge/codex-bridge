import type {
  BridgeSessionMenuPort,
  BridgeSessionMutationPort
} from "../../contracts.js";
import type { MessageSpec } from "../../messages/types.js";
import type { SessionInteractionAction } from "../action.js";
import type { InteractionContext, InteractionDelivery } from "../types.js";

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
      message = await service.renderSessionSectionMenu(chatId, action.directoryHash, action.page);
      break;
    case "session.create":
      message = await service.requestCreateSessionFromDirectorySelector(chatId, action.directoryHash);
      break;
    case "session.menu.refresh":
      message = await service.renderSessionMenu(chatId, 0, { refresh: true, includeUnknownThreads: true });
      break;
    case "session.archived.open":
      message = await service.renderArchivedSessionMenu(chatId, 0);
      break;
    case "session.archived.page":
      message = await service.renderArchivedSessionMenu(chatId, action.page);
      break;
    case "session.unarchive":
      message = await service.unarchiveSession(chatId, action.sessionId);
      break;
    case "session.menu.page":
      message = await service.renderSessionMenu(chatId, action.page, { refresh: false, reuseSnapshot: true });
      break;
  }
  return { mode: "edit", target: "surface", message };
}
