import { BridgeStore } from "../../store/index.js";
import type { MessageSpec } from "../messages/types.js";
import { createMessage } from "../messages/factory.js";
import { sessionAction } from "../messages/actions.js";
import type { SessionOwnershipService } from "./ownership.js";

export type SessionViewDependencies = {
  store: BridgeStore;
  sessionOwnershipService: Pick<SessionOwnershipService, "getSessionStatePrompt">;
};

/** Compatibility for old Refresh callbacks: show state, never acquire or read history. */
export class SessionViewService {
  constructor(private readonly deps: SessionViewDependencies) {}

  async refreshSessionView(sourceId: string, sessionId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) return createMessage({ kind: "error", scope: "global",
      body: [{ type: "text", text: "This session is no longer available." }], actions: [sessionAction()] });
    const selected = await this.deps.store.getActiveSession(sourceId);
    return this.deps.sessionOwnershipService.getSessionStatePrompt(session, sourceId,
      selected && selected.id !== sessionId ? "This is an older session entry. Your current selection was kept." : undefined);
  }
}
