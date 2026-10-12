import type { SessionCatalog, SessionCatalogService } from "../bridge/sessions/catalog.js";
import type { SessionBindingEvent, SessionBindingService, SessionBindingResult } from "../bridge/sessions/binding.js";
import { SessionAccessError, type SessionAccessService } from "../bridge/sessions/access.js";
import type { SessionReader } from "../bridge/sessions/reader.js";
import { WEB_SOURCE_ID } from "../shared/source-address.js";
import type { BridgeStore, SessionHandoffCancellation } from "../store/index.js";
import type { IncomingTurnService } from "../bridge/input/turn.js";
import type { WebMessageTransport, WebMessageDelivery } from "./transport.js";
import type { WebDecisionService, WebDecisionInput, WebDecisionReceipt, WebDecisionSnapshot } from "./decisions.js";
import { presentWebMessage, type WebMessageSpec } from "./message-presentation.js";
import { WEB_MUTATION_RPC_TIMEOUT_MS } from "./protocol-limits.js";
import type { WebDirectoryRegistry } from "../bridge/sessions/directory-registry.js";
import type { WebDirectoryRegistration } from "../store/index.js";
import type { QueuedSubmissionRecord } from "../store/index.js";
import type { SessionInteractionService } from "../bridge/sessions/interaction.js";
import type { SessionMutationService } from "../bridge/sessions/mutation.js";
import type { SessionCreationService } from "../bridge/sessions/creation.js";
import type { CompactService } from "../bridge/sessions/compact-service.js";
import type { SessionStopService } from "../bridge/sessions/stop.js";
import type { StatusViewService } from "../bridge/status/view.js";
import type { QueuedSubmissionService } from "../bridge/input/queued-submission.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import type { CodexTurnInputPart } from "../codex/client.js";
import type { IncomingAttachment } from "../bridge/input/payload.js";
import { WebAttachmentStorage, type WebUploadFile } from "./attachments.js";

export type WebSessionHistory = {
  threadId: string;
  sessionId: string;
  leaseVersion: number;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
};

/** The final guard is internal, and must run immediately before HTTP delivery. */
export type WebSessionHistoryResult = { history: WebSessionHistory; assertCurrent: () => void };
export type WebTextInput = { threadId: string; leaseVersion?: number; requestId: string; text: string;
  attachments?: WebUploadFile[] };
export type WebSendResult = { accepted: boolean; requestId: string; prompt?: WebMessageSpec;
  /** Internal content guard for routing refusals; never serialized to HTTP. */
  assertCurrent?: () => void };
export type WebSessionCreateResult = { threadId: string; sessionId: string; leaseVersion: number };
export type WebSessionManageInput = { threadId: string; leaseVersion?: number } &
  ({ action: "rename"; name: string } | { action: "archive" | "restore" | "release" });
export type WebOperationResult = { ok: boolean; message: WebMessageSpec };
export type WebSessionTool = "help" | "status" | "compact" | "interrupt";
export type WebQueueEntry = Pick<QueuedSubmissionRecord, "id" | "summary" | "state" | "createdAt">;
export type WebQueueSnapshot = { threadId: string; sessionId: string; leaseVersion: number; running: boolean; entries: WebQueueEntry[] };

export class WebSendError extends Error {
  constructor(readonly reason: "waiting" | "disconnected") {
    super(reason === "waiting" ? "Process this session's pending approval or input before sending text."
      : "Codex runtime is disconnected.");
  }
}

/** Web has one stable source; browser window credentials never become source IDs. */
export interface WebBridgeApi {
  listCatalog(): Promise<SessionCatalog>;
  registerDirectory?: (path: string, assertCurrent: () => void) => Promise<WebDirectoryRegistration>;
  requestBinding?: (threadId: string, expectedVersion: number | undefined, assertCurrent: () => void) => Promise<SessionBindingResult>;
  cancelBinding?: (threadId: string, expectedVersion: number | undefined, assertCurrent: () => void) => Promise<SessionHandoffCancellation>;
  subscribeBinding?: (listener: (event: SessionBindingEvent) => void) => () => void;
  readHistory?: (threadId: string, expectedVersion: number | undefined, assertCurrent: () => void) => Promise<WebSessionHistoryResult>;
  sendText?: (input: WebTextInput, assertCurrent: () => void) => Promise<WebSendResult>;
  subscribeMessages?: (listener: (delivery: WebMessageDelivery) => void) => () => void;
  readDecisions?: (threadId: string, expectedVersion: number | undefined, assertCurrent: () => void) => Promise<{ snapshot: WebDecisionSnapshot; assertCurrent: () => void }>;
  actDecision?: (input: WebDecisionInput, assertCurrent: () => void) => Promise<WebDecisionReceipt>;
  createSession?: (directory: string, requestId: string, assertCurrent: () => void) => Promise<WebSessionCreateResult>;
  manageSession?: (input: WebSessionManageInput, assertCurrent: () => void) => Promise<WebOperationResult>;
  runSessionTool?: (threadId: string, leaseVersion: number | undefined, tool: WebSessionTool,
    full: boolean | undefined, assertCurrent: () => void) => Promise<WebOperationResult>;
  readQueue?: (threadId: string, leaseVersion: number | undefined, assertCurrent: () => void) => Promise<WebQueueSnapshot>;
  queueText?: (input: WebTextInput, assertCurrent: () => void) => Promise<WebSendResult>;
  cancelQueued?: (threadId: string, leaseVersion: number | undefined, queueId: string,
    assertCurrent: () => void) => Promise<WebOperationResult>;
}

type WebSessionOperations = {
  store: BridgeStore;
  access: SessionAccessService;
  binding: SessionBindingService;
  creation: Pick<SessionCreationService, "createSessionForDirectory">;
  interaction: Pick<SessionInteractionService, "renameSession">;
  mutation: Pick<SessionMutationService, "archiveSession" | "unarchiveSession" | "releaseBridgeSessionLock">;
  compact: Pick<CompactService, "compactSession">;
  stop: Pick<SessionStopService, "stopSession">;
  status: Pick<StatusViewService, "renderSession">;
  queued: Pick<QueuedSubmissionService, "cancelWithOutcome">;
  sender: Pick<IncomingTurnService, "route">;
  isRuntimeConnected: () => boolean;
  inFlightTurnIdByThread: Map<string, string>;
  help: (session: import("../shared/types.js").SessionRecord) => Promise<MessageSpec>;
};

export class LocalWebBridgeApi implements WebBridgeApi {
  constructor(private readonly catalog: SessionCatalogService,
    private readonly binding?: { store: BridgeStore; service: SessionBindingService },
    private readonly conversation?: { access: SessionAccessService; reader: Pick<SessionReader, "readSessionTranscript">;
      sender?: Pick<IncomingTurnService, "route">; transport?: WebMessageTransport;
      isRuntimeConnected?: () => boolean; store?: Pick<BridgeStore, "hasTelegramMessage" | "listOpenDecisions"> },
    private readonly decisions?: WebDecisionService,
    private readonly directories?: WebDirectoryRegistry,
    private readonly operations?: WebSessionOperations,
    private readonly attachments?: WebAttachmentStorage) {}

  listCatalog(): Promise<SessionCatalog> {
    return this.catalog.list();
  }

  registerDirectory(path: string, assertCurrent: () => void): Promise<WebDirectoryRegistration> {
    if (!this.directories) throw new Error("Web directory API is unavailable.");
    return this.directories.register(path, assertCurrent);
  }

  async requestBinding(threadId: string, expectedVersion: number | undefined, assertCurrent: () => void): Promise<SessionBindingResult> {
    if (!this.binding) throw new Error("Session binding API is unavailable.");
    // Verify current upstream metadata; the browser cannot supply a directory or source ID.
    const metadata = await this.catalog.registration(threadId);
    assertCurrent();
    if (!metadata) return { session: null, outcome: null };
    const sessionId = this.binding.store.registerCatalogSession(metadata, WEB_SOURCE_ID);
    return this.binding.service.request(WEB_SOURCE_ID, sessionId, expectedVersion, assertCurrent, { select: false });
  }

  async cancelBinding(threadId: string, expectedVersion: number | undefined, assertCurrent: () => void): Promise<SessionHandoffCancellation> {
    if (!this.binding) throw new Error("Session binding API is unavailable.");
    const session = await this.binding.store.getSessionByThreadId(threadId);
    assertCurrent();
    if (!session) return { cancelled: false, lease: null, reason: "not_pending" };
    return this.binding.service.cancel(WEB_SOURCE_ID, session.id, expectedVersion, assertCurrent);
  }

  async readHistory(threadId: string, expectedVersion: number | undefined, assertCurrent: () => void): Promise<WebSessionHistoryResult> {
    if (!this.conversation) throw new Error("Web conversation API is unavailable.");
    const access = await this.conversation.access.requireOwned(threadId, WEB_SOURCE_ID, expectedVersion, assertCurrent);
    access.assertCurrent();
    const transcript = await this.conversation.reader.readSessionTranscript(access.session);
    access.assertCurrent();
    // Resolve again in case the stored native thread mapping changed during the read.
    const current = await this.conversation.access.requireOwned(threadId, WEB_SOURCE_ID, access.leaseVersion, assertCurrent);
    access.assertCurrent();
    if (current.session.id !== access.session.id) throw new SessionAccessError("stale");
    const messages = transcript.recentMessages
      .filter((message): message is { role: "user" | "assistant"; text: string } =>
        message.role === "user" || message.role === "assistant")
      .slice(-5).map(({ role, text }) => ({ role, text }));
    return { history: { threadId, sessionId: access.session.id, leaseVersion: access.leaseVersion, messages },
      assertCurrent: access.assertCurrent };
  }

  subscribeBinding(listener: (event: SessionBindingEvent) => void): () => void {
    return this.binding?.service.subscribe((event) => {
      if (event.sourceId === WEB_SOURCE_ID) listener(event);
    }) ?? (() => {});
  }

  async sendText(input: WebTextInput, assertCurrent: () => void): Promise<WebSendResult> {
    if (!this.conversation?.sender || !this.conversation.store || !this.conversation.isRuntimeConnected) throw new Error("Web send API is unavailable.");
    const { access: accessService, sender, store, isRuntimeConnected } = this.conversation;
    const access = await accessService.requireOwned(input.threadId, WEB_SOURCE_ID, input.leaseVersion, assertCurrent);
    const beforeSend = async (): Promise<void> => {
      access.assertCurrent();
      if (!isRuntimeConnected()) throw new WebSendError("disconnected");
      const decisions = await store.listOpenDecisions(access.session.id);
      access.assertCurrent();
      if (decisions.length) throw new WebSendError("waiting");
    };
    await beforeSend();
    return this.sendInput(input, access, sender, store, beforeSend, false);
  }

  subscribeMessages(listener: (delivery: WebMessageDelivery) => void): () => void {
    return this.conversation?.transport?.subscribe(listener) ?? (() => {});
  }

  async readDecisions(threadId: string, expectedVersion: number | undefined, assertCurrent: () => void) {
    if (!this.decisions) throw new Error("Web decision API is unavailable.");
    return this.decisions.read(threadId, expectedVersion, assertCurrent);
  }

  async actDecision(input: WebDecisionInput, assertCurrent: () => void): Promise<WebDecisionReceipt> {
    if (!this.decisions) throw new Error("Web decision API is unavailable.");
    return this.decisions.act(input, assertCurrent);
  }

  async createSession(directory: string, _requestId: string, assertCurrent: () => void): Promise<WebSessionCreateResult> {
    if (!this.operations) throw new Error("Web session operations are unavailable.");
    const session = await this.operations.creation.createSessionForDirectory(WEB_SOURCE_ID, directory, assertCurrent);
    assertCurrent();
    const binding = await this.operations.binding.request(WEB_SOURCE_ID, session.id, undefined, assertCurrent, { select: false });
    if (!binding.outcome?.owned) throw new Error("The new session was created, but Web ownership could not be confirmed.");
    return { threadId: session.codexThreadId, sessionId: session.id, leaseVersion: binding.outcome.lease.version };
  }

  async manageSession(input: WebSessionManageInput, assertCurrent: () => void): Promise<WebOperationResult> {
    if (!this.operations) throw new Error("Web session operations are unavailable.");
    if (input.action === "restore") {
      const metadata = await this.catalog.archivedRegistration(input.threadId);
      assertCurrent();
      if (!metadata) throw new SessionAccessError("unavailable");
      const sessionId = this.operations.store.registerCatalogSession(metadata, WEB_SOURCE_ID);
      this.operations.store.ensureSessionBinding(sessionId, WEB_SOURCE_ID);
      const message = await this.operations.mutation.unarchiveSession(WEB_SOURCE_ID, sessionId);
      if (message.kind !== "error") await this.operations.binding.request(WEB_SOURCE_ID, sessionId, undefined, assertCurrent, { select: false });
      return this.operationResult(message);
    }
    const access = await this.operations.access.requireOwned(input.threadId, WEB_SOURCE_ID, input.leaseVersion, assertCurrent);
    const message = input.action === "release"
      ? await this.operations.mutation.releaseBridgeSessionLock(WEB_SOURCE_ID, access.session.id, access.leaseVersion)
      : await this.operations.binding.runDispatch(access.session, () => input.action === "rename"
        ? this.operations!.interaction.renameSession(WEB_SOURCE_ID, access.session.id, input.name, access.leaseVersion)
        : this.operations!.mutation.archiveSession(WEB_SOURCE_ID, access.session.id, access.leaseVersion));
    // A successful release intentionally invalidates this session access. Refusals
    // still require the original lease before their details may be returned.
    if (input.action === "release" && message.kind !== "error" && message.kind !== "failed" && message.kind !== "stream-error") {
      assertCurrent();
    } else {
      access.assertCurrent();
    }
    return this.operationResult(message);
  }

  async runSessionTool(threadId: string, leaseVersion: number | undefined, tool: WebSessionTool,
    full: boolean | undefined, assertCurrent: () => void): Promise<WebOperationResult> {
    if (!this.operations) throw new Error("Web session operations are unavailable.");
    const access = await this.operations.access.requireOwned(threadId, WEB_SOURCE_ID, leaseVersion, assertCurrent);
    if (tool === "help") {
      const message = await this.operations.help(access.session);
      access.assertCurrent();
      return this.operationResult(message);
    }
    if (tool === "status") {
      const message = await this.operations.status.renderSession(access.session, full === true);
      access.assertCurrent();
      return this.operationResult(message);
    }
    const message = await this.operations.binding.runDispatch(access.session, () => tool === "compact"
      ? this.operations!.compact.compactSession(access.session)
      : this.operations!.stop.stopSession(access.session, WEB_SOURCE_ID));
    access.assertCurrent();
    return this.operationResult(message);
  }

  async readQueue(threadId: string, leaseVersion: number | undefined,
    assertCurrent: () => void): Promise<WebQueueSnapshot> {
    if (!this.operations) throw new Error("Web session operations are unavailable.");
    const access = await this.operations.access.requireOwned(threadId, WEB_SOURCE_ID, leaseVersion, assertCurrent);
    const rows = await this.operations.store.listPendingQueuedSubmissions(threadId);
    access.assertCurrent();
    return { threadId, sessionId: access.session.id, leaseVersion: access.leaseVersion,
      running: this.operations.inFlightTurnIdByThread.has(threadId),
      entries: rows.map(({ id, summary, state, createdAt }) => ({ id, summary, state, createdAt })) };
  }

  async queueText(input: WebTextInput, assertCurrent: () => void): Promise<WebSendResult> {
    if (!this.operations) throw new Error("Web session operations are unavailable.");
    const access = await this.operations.access.requireOwned(input.threadId, WEB_SOURCE_ID, input.leaseVersion, assertCurrent);
    const beforeSend = async (): Promise<void> => {
      access.assertCurrent();
      if (!this.operations!.isRuntimeConnected()) throw new WebSendError("disconnected");
    };
    await beforeSend();
    return this.sendInput(input, access, this.operations.sender, this.operations.store, beforeSend, true);
  }

  async cancelQueued(threadId: string, leaseVersion: number | undefined, queueId: string,
    assertCurrent: () => void): Promise<WebOperationResult> {
    if (!this.operations) throw new Error("Web session operations are unavailable.");
    const access = await this.operations.access.requireOwned(threadId, WEB_SOURCE_ID, leaseVersion, assertCurrent);
    const row = await this.operations.store.getQueuedSubmission(queueId);
    access.assertCurrent();
    if (!row || row.sessionId !== access.session.id || row.telegramChatId !== WEB_SOURCE_ID) {
      throw new SessionAccessError("unavailable");
    }
    const result = await this.operations.binding.runDispatch(access.session,
      () => this.operations!.queued.cancelWithOutcome(WEB_SOURCE_ID, queueId));
    access.assertCurrent();
    return { ok: result.cancelled, message: presentWebMessage(result.message) };
  }

  private operationResult(message: MessageSpec): WebOperationResult {
    return { ok: message.kind !== "error" && message.kind !== "failed" && message.kind !== "stream-error",
      message: presentWebMessage(message) };
  }

  private async sendInput(input: WebTextInput,
    access: Awaited<ReturnType<SessionAccessService["requireOwned"]>>,
    sender: Pick<IncomingTurnService, "route">,
    store: Pick<BridgeStore, "hasTelegramMessage">,
    beforeSend: () => Promise<void>, queue: boolean): Promise<WebSendResult> {
    const sourceMessageId = `${queue ? "web-queue" : "web"}:${input.requestId}`;
    if (await store.hasTelegramMessage(access.session.id, sourceMessageId)) {
      access.assertCurrent();
      return { accepted: true, requestId: input.requestId };
    }
    let saved: IncomingAttachment[] = [];
    try {
      if (input.attachments?.length) {
        if (!this.attachments) throw new Error("Web attachment storage is unavailable.");
        saved = await this.attachments.save(input.attachments, {
          requestId: input.requestId,
          sessionId: access.session.id,
          status: queue ? "queued" : "downloaded"
        });
        access.assertCurrent();
      }
      const routedText = input.text.trim() || `Please inspect the attached ${saved.length === 1 ? "file" : "files"}: ${saved.map((file) => file.name).join(", ")}.`;
      const inputParts: CodexTurnInputPart[] | undefined = saved.length ? [
        { type: "text", text: routedText },
        ...saved.map((file): CodexTurnInputPart => file.kind === "image"
          ? { type: "localImage", path: file.localPath }
          : { type: "mention", name: file.name, path: file.localPath })
      ] : undefined;
      const result = await sender.route(access.session, {
        telegramChatId: WEB_SOURCE_ID, telegramMessageId: sourceMessageId, text: routedText,
        ...(inputParts ? { inputParts } : {}), ...(queue ? { queue: true } : {})
      }, { assertCurrent: access.assertCurrent, beforeSend, rpcTimeoutMs: WEB_MUTATION_RPC_TIMEOUT_MS });
      if (saved.length) await this.attachments!.mark(saved.map((file) => file.localPath),
        result.routed && !queue ? "sent-to-codex" : result.routed ? "queued" : "failed");
      // Once an upstream mutation was issued, finish recording it even if the window has changed.
      // Do not return a misleading "not sent" result or encourage an automatic retry.
      if (result.routed) return { accepted: true, requestId: input.requestId };
      access.assertCurrent();
      return { accepted: false, requestId: input.requestId, assertCurrent: access.assertCurrent,
        ...(result.prompt ? { prompt: presentWebMessage(result.prompt) } : {}) };
    } catch (error) {
      if (saved.length) await this.attachments?.mark(saved.map((file) => file.localPath), "failed");
      throw error;
    }
  }
}
