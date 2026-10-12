import type { CodexAppServerClient } from "../../codex/client.js";
import type { CodexThreadMetadataCache } from "../../codex/thread-metadata-cache.js";
import { formatSessionMarker } from "../../shared/session-tag.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { archiveAction, deleteAction, helpAction, messageAction, sessionAction } from "../messages/actions.js";
import { createMessage } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";
import { SessionOwnershipService } from "./ownership.js";

type SlackChat = { threadTs: string | null } | null;

export type SessionInteractionDependencies = {
  store: BridgeStore;
  codexClient: Pick<CodexAppServerClient, "setThreadName">;
  threadMetadataCache: Pick<CodexThreadMetadataCache, "setName">;
  sessionOwnershipService: Pick<SessionOwnershipService, "getSessionOwnershipPrompt">;
  sessionMenuSnapshots: { clear: () => void };
  getSessionDirectory: (session: SessionRecord) => string;
  parseSlackChatId: (chatId: string) => SlackChat;
  getSessionArchiveCallback: (chatId: string, sessionId: string) => Promise<string | null>;
  getSessionDeleteCallback: (chatId: string, sessionId: string) => Promise<string | null>;
  getSessionReleaseBridgeCallback: (chatId: string, sessionId: string) => Promise<string | null>;
  sessionHandoffCallback: (sessionId: string, leaseVersion: number) => string;
  createCommandResultSpec: (kind: MessageSpec["kind"], body: string, actions?: MessageSpec["actions"]) => MessageSpec;
  createSessionCommandResultSpec: (session: SessionRecord, kind: MessageSpec["kind"], body: string, actions?: MessageSpec["actions"]) => MessageSpec;
};

export class SessionInteractionService {
  constructor(private readonly deps: SessionInteractionDependencies) {}

  async renderCurrentSessionMenuSection(chatId: string): Promise<{ messageSpec: MessageSpec } | null> {
    const session = await this.deps.store.getActiveSession(chatId);
    if (!session) return null;

    const lease = this.deps.store.getSessionLease(session.id);
    const binding = this.deps.store.getSessionBinding(session.id, chatId);
    const owner = lease?.ownerBindingId ? this.deps.store.getSessionBindingById(lease.ownerBindingId) : null;
    const createSpec = (actions: MessageSpec["actions"]): MessageSpec => createMessage({
      kind: "menu",
      session: { id: session.codexThreadId, directory: this.deps.getSessionDirectory(session) },
      body: [
        { type: "field", label: "Session ID", value: session.codexThreadId },
        { type: "field", label: "Thread", value: this.deps.parseSlackChatId(chatId)?.threadTs ?? "n/a" },
        { type: "field", label: "Binding", value: lease?.state === "external_unknown" ? "In use outside Bridge"
          : binding && owner?.id === binding.id ? "Bound here"
          : binding && lease?.pendingBindingId === binding.id ? "Waiting for handoff"
          : owner ? "In use in another conversation" : "Not bound" }
      ],
      actions
    });

    if (lease?.state === "external_unknown") return { messageSpec: createSpec([helpAction()]) };

    const isOwner = Boolean(binding && owner && binding.id === owner.id);
    if (isOwner && lease) {
      const archiveCallback = await this.deps.getSessionArchiveCallback(chatId, session.id);
      const deleteCallback = await this.deps.getSessionDeleteCallback(chatId, session.id);
      const releaseCallback = await this.deps.getSessionReleaseBridgeCallback(chatId, session.id);
      return {
        messageSpec: createSpec([
          ...(releaseCallback ? [messageAction("release", "Release to Codex", releaseCallback, "Current session")] : []),
          ...(archiveCallback ? [archiveAction(archiveCallback, "Current session")] : []),
          ...(deleteCallback ? [deleteAction(deleteCallback, "Current session")] : [])
        ])
      };
    }

    if (lease && owner) {
      return {
        messageSpec: createSpec([
          messageAction("handoff", "Use this session next", this.deps.sessionHandoffCallback(session.id, lease.version), "Current session")
        ])
      };
    }
    return { messageSpec: createSpec([]) };
  }

  async renameActiveSection(chatId: string, nameInput: string): Promise<MessageSpec> {
    const activeSession = await this.deps.store.getActiveSession(chatId);
    if (!activeSession) {
      return this.deps.createCommandResultSpec(
        "error",
        "No active section to rename.\nUse /sessions to choose a section first.",
        [sessionAction()]
      );
    }
    return this.renameSession(chatId, activeSession.id, nameInput);
  }

  async renameSession(chatId: string, sessionId: string, nameInput: string, expectedLeaseVersion?: number): Promise<MessageSpec> {
    const activeSession = await this.deps.store.getSessionById(sessionId);
    if (!activeSession) {
      return this.deps.createCommandResultSpec("error", "This session is no longer available.", [sessionAction()]);
    }
    const lease = this.deps.store.getSessionLease(activeSession.id);
    if (expectedLeaseVersion !== undefined && lease?.version !== expectedLeaseVersion) {
      return this.deps.createSessionCommandResultSpec(activeSession, "error", "This rename action is stale. Refresh the session state first.");
    }
    const ownershipPrompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(activeSession, chatId);
    if (ownershipPrompt) return ownershipPrompt;

    const name = nameInput.trim().replace(/\s+/g, " ");
    if (!name) {
      return this.deps.createSessionCommandResultSpec(activeSession, "error", "Section name is required.\nUsage: /section_rename <name>");
    }
    if (name.length > 48) {
      return this.deps.createSessionCommandResultSpec(activeSession, "error", "Section name is too long. Use 48 characters or fewer.");
    }
    await this.deps.codexClient.setThreadName(activeSession.codexThreadId, name);
    await this.deps.store.updateSessionDisplayName(activeSession.id, name);
    this.deps.threadMetadataCache.setName(activeSession.codexThreadId, name);
    this.deps.sessionMenuSnapshots.clear();
    return this.deps.createSessionCommandResultSpec(
      activeSession,
      "system",
      `Section renamed.\n${formatSessionMarker(this.deps.getSessionDirectory(activeSession))} · ${name}`
    );
  }
}
