import { QueryClient } from "@tanstack/react-query";
import { ApiError, decisionRequestFits, sendRequestFits, type WorkbenchApi } from "./api";
import { isOwned, type Catalog, type DirectoryReceipt, type Grant, type MessageEvent, type QueueSnapshot,
  type SessionBindingEvent, type SessionEntry, type SessionTool, type StreamEvent, type WebActionSpec } from "./protocol";
import { applyMessage, hasOpenDecision, mergeDecisions, restoreHistory, trimTimeline, type TimelineItem } from "./timeline";
import type { TimelineCache } from "./cache";
import type { ComposerDraftStore } from "./composer-drafts";
import { createClientId } from "./id";
import type { SessionLocation, WindowGrantStore } from "./browser-state";
import { bindingAppearance } from "./binding-appearance";
import type { WebNotifications, WebAttentionEvent } from "./notifications";
import { WEB_MUTATION_CLIENT_TIMEOUT_MS } from "../../../src/web/protocol-limits";
import {
  WEB_ATTACHMENT_MAX_FILES,
  WEB_ATTACHMENT_MAX_FILE_BYTES,
  WEB_ATTACHMENT_MAX_TOTAL_BYTES,
  isWebImageMimeType
} from "../../../src/web/protocol-limits";

export type WorkbenchState = {
  connection: "idle" | "connecting" | "connected" | "offline" | "revoked";
  occupied: boolean; catalog: Catalog | null; catalogFresh: boolean; selected: string | null;
  viewableSessionId: string | null;
  ready: boolean; loading: boolean; catalogError: string | null;
  operation: WorkbenchOperation | null; feedback: WorkbenchFeedback | null;
  timelines: Record<string, TimelineItem[]>; drafts: Record<string, string>; attachments: Record<string, File[]>;
  queues: Record<string, QueueSnapshot>;
};
export type WorkbenchOperation = {
  kind: "binding" | "directory" | "session-create" | "session-manage" | "session-tool" |
    "queue-send" | "queue-cancel" | "send" | "decision";
  threadId?: string;
};
export type WorkbenchFeedback = {
  source: "connection" | "read" | "operation" | "composer" | "directory";
  surface: "conversation" | "directory";
  tone: "neutral" | "warning" | "error";
  message: string;
  threadId?: string;
};
export function selectedEntry(state: WorkbenchState): SessionEntry | undefined {
  return state.catalog?.sessions.find((entry) => entry.threadId === state.selected);
}
export function canInteract(state: WorkbenchState): boolean {
  return state.connection === "connected" && state.catalogFresh && state.ready && isOwned(selectedEntry(state));
}
export function canViewSelectedTimeline(state: WorkbenchState): boolean {
  const entry = selectedEntry(state);
  return !!entry?.sessionId && state.viewableSessionId === entry.sessionId &&
    (isOwned(entry) || state.connection === "revoked" || state.connection === "offline");
}
export function isBusy(state: WorkbenchState): boolean { return state.operation !== null; }
export function isSelectedOperation(state: WorkbenchState, kind?: WorkbenchOperation["kind"]): boolean {
  return !!state.operation && state.operation.threadId === state.selected && (!kind || state.operation.kind === kind);
}

/** Permissions, reads, stream lifecycle and mutation receipts; no presentation. */
export class WorkbenchController {
  private state: WorkbenchState = { connection: "idle", occupied: false, catalog: null, catalogFresh: false,
    selected: null, viewableSessionId: null, ready: false, loading: false, catalogError: null,
    operation: null, feedback: null,
    timelines: {}, drafts: {}, attachments: {}, queues: {} };
  private readonly listeners = new Set<() => void>();
  private grant: Grant | null = null;
  private generation = 0;
  private navigationSequence = 0;
  private readSequence = 0;
  private stream?: AbortController;
  private reads?: AbortController;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private disposed = false;
  private catalogSequence = 0;
  private liveDuringRead?: { threadId: string; events: MessageEvent[] };
  private started = false;
  private readonly unsubscribeLocation?: () => void;
  private readonly restoringAttachments = new Set<string>();
  constructor(private readonly api: WorkbenchApi, private readonly queries = new QueryClient(),
    private readonly windowId = createClientId(), private readonly cache?: TimelineCache,
    private readonly browser: { location?: SessionLocation; grants?: WindowGrantStore; drafts?: ComposerDraftStore;
      notifications?: WebNotifications } = {},
    private readonly mutationTimeoutMs = WEB_MUTATION_CLIENT_TIMEOUT_MS) {
    this.state.selected = browser.location?.read() ?? null;
    this.unsubscribeLocation = browser.location?.subscribe(() => this.select(browser.location!.read(), false));
    if (this.state.selected) this.restoreComposerDraft(this.state.selected);
    browser.notifications?.onOpen((threadId) => { if (!this.disposed) this.select(threadId); });
  }
  get notifications(): WebNotifications | undefined { return this.browser.notifications; }
  getSnapshot = (): WorkbenchState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<WorkbenchState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private valid(grant: Grant, generation: number): boolean { return !this.disposed && this.grant === grant && generation === this.generation; }
  private sameSelection(entry: SessionEntry): boolean {
    const current = selectedEntry(this.state);
    return current?.threadId === entry.threadId && current.sessionId === entry.sessionId;
  }
  private beginOperation(operation: WorkbenchOperation): WorkbenchOperation | null {
    if (this.state.operation) return null;
    this.update({ operation, feedback: null });
    return operation;
  }
  private finishOperation(operation: WorkbenchOperation): void {
    if (this.state.operation === operation) this.update({ operation: null });
  }
  private async mutation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Timed out waiting for the Bridge receipt; the result is unknown."));
        abort.abort();
      }, Math.max(1, this.mutationTimeoutMs));
    });
    try { return await Promise.race([operation(abort.signal), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private timeline(threadId: string, items: TimelineItem[]): void {
    this.update({ timelines: { ...this.state.timelines, [threadId]: trimTimeline(items) } });
    const entry = this.state.catalog?.sessions.find((item) => item.threadId === threadId);
    if (entry?.sessionId && isOwned(entry) && this.state.catalogFresh && this.state.connection === "connected")
      this.cache?.save(threadId, entry.sessionId, trimTimeline(items));
  }
  async inspect(): Promise<void> {
    try { const holder = await this.api.holder(); if (!this.grant) this.update({ occupied: !!holder.holderWindowId }); }
    catch { if (!this.grant) this.update({ feedback: { source: "connection", surface: "conversation", tone: "error",
      message: "Bridge is unavailable. Check the service and reconnect." } }); }
  }
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const previous = this.browser.grants?.take();
    if (!previous) { await this.inspect(); return; }
    const generation = ++this.generation;
    this.update({ connection: "connecting",
      feedback: this.state.feedback?.source === "connection" ? null : this.state.feedback });
    try {
      const grant = await this.api.restore(previous);
      if (this.disposed || generation !== this.generation) return;
      this.grant = grant;
      this.browser.grants?.save(grant);
      this.update({ occupied: false });
      void this.listen(grant, generation);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.browser.grants?.clear();
      this.update({ connection: "revoked", ready: false, catalogFresh: false,
        feedback: { source: "connection", surface: "conversation", tone: "warning",
          message: error instanceof ApiError && error.status === 403
            ? "The previous service connection expired. The target session is preserved; reconnect or explicitly take over."
            : "The previous service connection could not be restored with certainty. The target session is preserved; reconnect or explicitly take over." } });
      await this.inspect();
    }
  }
  async connect(takeover = false): Promise<void> {
    if (this.state.connection === "connecting" || this.state.connection === "connected") return;
    if (this.state.connection === "offline" && this.grant) {
      clearTimeout(this.retryTimer);
      await this.reconnect(this.grant, this.generation); return;
    }
    this.stopStreams();
    this.grant = null;
    this.browser.grants?.clear();
    const generation = ++this.generation;
    this.update({ connection: "connecting", ready: false, catalogFresh: false,
      feedback: this.state.feedback?.source === "connection" ? null : this.state.feedback });
    try {
      const grant = await this.api.acquire(this.windowId, takeover);
      if (generation !== this.generation || this.disposed) return;
      this.grant = grant;
      this.browser.grants?.save(grant);
      this.update({ occupied: false });
      void this.listen(grant, generation);
    } catch (error) {
      if (generation === this.generation) this.update({ connection: "idle", occupied: error instanceof ApiError && error.status === 409,
        feedback: { source: "connection", surface: "conversation", tone: "error",
          message: error instanceof Error ? error.message : "Service connection failed." } });
    }
  }
  private stopStreams(): void {
    this.stream?.abort(); this.reads?.abort();
    clearTimeout(this.retryTimer); clearInterval(this.poll);
    this.queries.clear();
  }
  private revoke(reason: string): void {
    this.browser.notifications?.clear();
    this.generation++; this.readSequence++; this.grant = null; this.stopStreams();
    this.browser.grants?.clear();
    this.update({ connection: "revoked", occupied: true, ready: false, loading: false, catalogFresh: false,
      feedback: { source: "connection", surface: "conversation", tone: "warning",
        message: reason === "taken_over" ? "Another browser window took over the service connection. Static content and drafts remain here; the task is not interrupted." : "The previous service connection expired. Reconnect or explicitly take over." } });
  }
  private async listen(grant: Grant, generation: number): Promise<void> {
    if (!this.valid(grant, generation)) return;
    this.stream = new AbortController();
    try {
      await this.api.events(grant, this.stream.signal, (event) => { if (this.valid(grant, generation)) this.receive(event); });
      if (this.valid(grant, generation)) throw new Error("The live connection was lost.");
    } catch (error) {
      if (!this.valid(grant, generation)) return;
      if (error instanceof ApiError && error.status === 403) { this.revoke("invalid"); return; }
      clearInterval(this.poll); this.reads?.abort();
      this.update({ connection: "offline", ready: false, loading: false, catalogFresh: false,
        feedback: { source: "connection", surface: "conversation", tone: "warning",
          message: "The network connection was lost and actions are disabled. Restoring the original connection; operations will not be resent." } });
      this.retryTimer = setTimeout(() => { void this.reconnect(grant, generation); }, 2000);
    }
  }
  private async reconnect(grant: Grant, generation: number): Promise<void> {
    if (!this.valid(grant, generation) || this.state.connection !== "offline") return;
    // The retry timer and repeated manual clicks share one recovery attempt.
    this.update({ connection: "connecting" });
    try { await this.api.resume(grant); }
    catch (error) {
      if (!this.valid(grant, generation)) return;
      if (error instanceof ApiError && error.status === 403) { this.revoke("invalid"); return; }
      this.update({ connection: "offline" });
      this.retryTimer = setTimeout(() => { void this.reconnect(grant, generation); }, 4000); return;
    }
    if (this.valid(grant, generation)) void this.listen(grant, generation);
  }
  private receive(event: StreamEvent): void {
    if (event.name === "connection-lost") { this.revoke((event.data as { reason?: string })?.reason ?? "invalid"); return; }
    if (event.name === "connected") {
      this.update({ connection: "connected",
        feedback: this.state.feedback?.source === "connection" ? null : this.state.feedback });
      void this.refresh(true);
      clearInterval(this.poll);
      this.poll = setInterval(() => { void this.refresh(false); }, 8000);
    } else if (event.name === "session-binding") {
      const binding = event.data as SessionBindingEvent;
      if (binding.kind === "transferred") this.browser.notifications?.withdrawSession(binding.sessionId);
      const lostSelected = binding.kind === "transferred" && binding.threadId === this.state.selected;
      if (lostSelected) {
        this.readSequence++;
        this.reads?.abort();
      }
      const ownershipChanged = binding.kind === "acquired" || binding.kind === "transferred";
      const catalog = ownershipChanged && this.state.catalog ? {
        ...this.state.catalog,
        sessions: this.state.catalog.sessions.map((entry) => entry.threadId === binding.threadId ? {
          ...entry,
          ownership: { state: "active", ownerSourceId: binding.kind === "acquired" ? binding.sourceId : binding.otherSourceId, pendingSourceId: null,
            version: binding.leaseVersion }
        } : entry)
      } : this.state.catalog;
      this.update({ catalog, catalogFresh: false, ready: false,
        ...(lostSelected ? { loading: false, viewableSessionId: null } : {}) });
      void this.refresh(true);
    } else if (event.name === "attention") {
      const attention = event.data as WebAttentionEvent;
      if (!attention || typeof attention.id !== "string" || typeof attention.threadId !== "string" ||
        typeof attention.sessionId !== "string" || !Number.isSafeInteger(attention.leaseVersion)) return;
      const generation = this.generation;
      const current = (): boolean => !this.disposed && generation === this.generation && this.state.connection === "connected" &&
        !!this.state.catalog?.sessions.some((entry) => entry.threadId === attention.threadId && entry.sessionId === attention.sessionId &&
          isOwned(entry));
      void this.browser.notifications?.notify(attention, current);
    } else if (event.name === "message") {
      const message = event.data as MessageEvent;
      const entry = selectedEntry(this.state);
      if (!entry || !isOwned(entry) || message.threadId !== entry.threadId || message.sessionId !== entry.sessionId ||
          !Number.isSafeInteger(message.leaseVersion) || typeof message.messageId !== "string") return;
      if (this.liveDuringRead?.threadId === message.threadId) {
        this.liveDuringRead.events.push(message);
        // A slow snapshot cannot retain an unbounded live replay buffer.
        this.liveDuringRead.events = this.liveDuringRead.events.slice(-2048);
      }
      this.timeline(message.threadId, applyMessage(this.state.timelines[message.threadId] ?? [], message));
      // Native delivery is guarded by Bridge and carries its current lease version.
      if (entry.ownership && message.leaseVersion > entry.ownership.version) this.update({ catalog: {
        ...this.state.catalog!, sessions: this.state.catalog!.sessions.map((item) => item === entry ?
          { ...item, ownership: { ...entry.ownership!, version: message.leaseVersion } } : item)
      } });
    }
  }
  async refresh(reload = true): Promise<void> {
    const grant = this.grant, generation = this.generation;
    if (!grant || this.state.connection !== "connected") return;
    const sequence = ++this.catalogSequence;
    try {
      const catalog = await this.queries.fetchQuery({ queryKey: ["web-catalog", generation], staleTime: 0,
        retry: false, queryFn: ({ signal }) => this.api.catalog(grant, signal) });
      if (!this.valid(grant, generation) || sequence !== this.catalogSequence || this.state.connection !== "connected") return;
      const before = selectedEntry(this.state);
      for (const previous of this.state.catalog?.sessions ?? []) {
        if (previous.sessionId && isOwned(previous) && !catalog.sessions.some((entry) => entry.sessionId === previous.sessionId && isOwned(entry))) {
          this.browser.notifications?.withdrawSession(previous.sessionId);
        }
      }
      const after = catalog.sessions.find((entry) => entry.threadId === this.state.selected);
      const accessChanged = before?.sessionId !== after?.sessionId || isOwned(before) !== isOwned(after) ||
        before?.ownership?.version !== after?.ownership?.version;
      const retainsView = !!after?.sessionId && isOwned(after) && this.state.viewableSessionId === after.sessionId;
      this.update({ catalog, catalogFresh: true, catalogError: null, ...(accessChanged ? { ready: false } : {}),
        ...(!retainsView ? { viewableSessionId: null } : {}) });
      if (reload || accessChanged || (!this.state.ready && isOwned(after))) await this.loadSelected();
      else if (after && isOwned(after)) await this.loadQueue(after, grant, generation);
    } catch (error) {
      if (this.valid(grant, generation) && sequence === this.catalogSequence) {
        this.update({ catalogFresh: false, ready: false,
          catalogError: "Status is temporarily unavailable. The stale list is for identification only and cannot authorize actions." });
        this.handlePermission(error);
      }
    }
  }
  select(threadId: string | null, writeLocation = true): void {
    if (writeLocation) this.browser.location?.write(threadId);
    this.navigationSequence++; this.readSequence++; this.reads?.abort();
    this.update({ selected: threadId, viewableSessionId: null, ready: false, loading: false,
      feedback: this.state.feedback?.threadId ? null : this.state.feedback });
    if (threadId) this.restoreComposerDraft(threadId);
    if (this.state.connection === "connected" && this.state.catalogFresh) void this.loadSelected();
  }
  setDraft(text: string): void {
    if (!this.state.selected) return;
    this.update({ drafts: { ...this.state.drafts, [this.state.selected]: text } });
    this.browser.drafts?.saveText(this.state.selected, text);
  }
  private restoreComposerDraft(threadId: string): void {
    const store = this.browser.drafts;
    if (!store) return;
    if (!Object.hasOwn(this.state.drafts, threadId))
      this.update({ drafts: { ...this.state.drafts, [threadId]: store.loadText(threadId) } });
    if (Object.hasOwn(this.state.attachments, threadId) || this.restoringAttachments.has(threadId)) return;
    this.restoringAttachments.add(threadId);
    void store.loadAttachments(threadId).then((files) => {
      if (!this.disposed && !Object.hasOwn(this.state.attachments, threadId))
        this.update({ attachments: { ...this.state.attachments, [threadId]: files } });
    }).finally(() => this.restoringAttachments.delete(threadId));
  }
  addAttachments(files: readonly File[]): void {
    if (!this.state.selected || !files.length) return;
    if (files.some((file) => !isWebImageMimeType(file.type))) {
      this.update({ feedback: { source: "composer", surface: "conversation", tone: "error",
        threadId: this.state.selected, message: "Only PNG, JPEG, WebP, and GIF images are supported." } }); return;
    }
    const current = this.state.attachments[this.state.selected] ?? [];
    const next = [...current, ...files];
    if (next.length > WEB_ATTACHMENT_MAX_FILES) {
      this.update({ feedback: { source: "composer", surface: "conversation", tone: "error",
        threadId: this.state.selected, message: `Add no more than ${WEB_ATTACHMENT_MAX_FILES} images at once.` } }); return;
    }
    if (next.some((file) => file.size < 1 || file.size > WEB_ATTACHMENT_MAX_FILE_BYTES)) {
      this.update({ feedback: { source: "composer", surface: "conversation", tone: "error",
        threadId: this.state.selected, message: "Each image must be larger than 0 bytes and no larger than 10 MiB." } }); return;
    }
    if (next.reduce((sum, file) => sum + file.size, 0) > WEB_ATTACHMENT_MAX_TOTAL_BYTES) {
      this.update({ feedback: { source: "composer", surface: "conversation", tone: "error",
        threadId: this.state.selected, message: "The images cannot exceed 25 MiB in total." } }); return;
    }
    const selected = this.state.selected;
    this.update({ attachments: { ...this.state.attachments, [selected]: next },
      feedback: this.state.feedback?.source === "composer" && this.state.feedback.threadId === selected ? null : this.state.feedback });
    void this.browser.drafts?.saveAttachments(selected, next);
  }
  removeAttachment(index: number): void {
    if (!this.state.selected) return;
    const current = this.state.attachments[this.state.selected] ?? [];
    if (index < 0 || index >= current.length) return;
    const selected = this.state.selected;
    const next = current.filter((_, itemIndex) => itemIndex !== index);
    this.update({ attachments: { ...this.state.attachments, [selected]: next } });
    void this.browser.drafts?.saveAttachments(selected, next);
  }
  private async loadSelected(): Promise<void> {
    const grant = this.grant, generation = this.generation, selected = this.state.selected, sequence = ++this.readSequence;
    this.reads?.abort();
    const entry = selectedEntry(this.state);
    if (!grant || !selected || !isOwned(entry) || this.state.connection !== "connected" || !this.state.catalogFresh) return;
    const reads = this.reads = new AbortController();
    const live = this.liveDuringRead = { threadId: selected, events: [] as MessageEvent[] };
    this.update({ loading: true, ready: false,
      feedback: this.state.feedback?.source === "read" && this.state.feedback.threadId === selected ? null : this.state.feedback });
    const valid = () => this.valid(grant, generation) && sequence === this.readSequence && this.state.connection === "connected" && isOwned(selectedEntry(this.state));
    try {
      const [history, decisions, queue] = await Promise.all([this.api.history(grant, selected, reads.signal),
        this.api.decisions(grant, selected, reads.signal), this.api.queue(grant, selected, entry?.ownership?.version, reads.signal)]);
      if (!valid()) return;
      if (history.threadId !== selected || decisions.threadId !== selected || queue.threadId !== selected ||
          history.sessionId !== entry?.sessionId || decisions.sessionId !== history.sessionId || queue.sessionId !== history.sessionId) {
        throw new Error("The session state changed. Refresh it.");
      }
      const existing = this.state.timelines[selected] ?? [];
      const base = existing.length ? existing : this.cache?.load(selected, history.sessionId) ?? [];
      const restored = mergeDecisions(restoreHistory(base, history), decisions.decisions);
      this.timeline(selected, live.events.reduce(applyMessage, restored));
      this.update({ viewableSessionId: history.sessionId, ready: true, loading: false,
        queues: { ...this.state.queues, [selected]: queue } });
    } catch (error) {
      if (valid()) { this.update({ loading: false, ready: false,
        feedback: { source: "read", surface: "conversation", tone: "error", threadId: selected,
          message: error instanceof Error ? error.message : "Failed to load the conversation." } }); this.handlePermission(error); }
    } finally { if (this.liveDuringRead === live) this.liveDuringRead = undefined; }
  }
  private async loadQueue(entry: SessionEntry, grant: Grant, generation: number): Promise<void> {
    try {
      const queue = await this.api.queue(grant, entry.threadId, entry.ownership?.version);
      if (!this.valid(grant, generation) || !this.sameSelection(entry) || queue.sessionId !== entry.sessionId) return;
      this.update({ queues: { ...this.state.queues, [entry.threadId]: queue } });
    } catch (error) { this.handlePermission(error); }
  }
  private handlePermission(error: unknown): void {
    if (!(error instanceof ApiError)) return;
    if (error.reason === "not_owner" || error.reason === "stale") {
      // The normal poll/manual refresh reconciles metadata. Do not create a
      // rapid read→stale→refresh loop if upstream metadata is temporarily stale.
      this.update({ ready: false, catalogFresh: false });
    } else if (error.status === 403) this.revoke("invalid");
  }
  async bind(action: "request" | "cancel"): Promise<void> {
    const grant = this.grant, generation = this.generation, entry = selectedEntry(this.state);
    if (!grant || !entry || entry.archived || this.state.connection !== "connected" || !this.state.catalogFresh) return;
    const operation = this.beginOperation({ kind: "binding", threadId: entry.threadId });
    if (!operation) return;
    try {
      const receipt = await this.mutation((signal) =>
        this.api.binding(grant, entry.threadId, action, entry.ownership?.version, signal));
      if (!this.valid(grant, generation)) return;
      const feedback = bindingAppearance(receipt, action);
      await this.refresh(true);
      if (this.valid(grant, generation) && this.sameSelection(entry) && feedback) {
        this.update({ feedback: { source: "operation", surface: "conversation", tone: feedback.tone === "notice" ? "neutral" : "error",
          threadId: entry.threadId, message: feedback.message } });
      }
    } catch (error) {
      if (this.valid(grant, generation)) {
        if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          threadId: entry.threadId, message: `${error instanceof Error ? error.message : "Binding failed."} Refresh the status; it will not retry automatically.` } });
        this.handlePermission(error);
      }
    } finally { this.finishOperation(operation); }
  }
  async addDirectory(path: string): Promise<DirectoryReceipt | null> {
    const grant = this.grant, generation = this.generation;
    if (!grant || this.state.connection !== "connected" || !path.trim()) return null;
    const operation = this.beginOperation({ kind: "directory" });
    if (!operation) return null;
    try {
      const receipt = await this.mutation((signal) => this.api.directory(grant, path, signal));
      if (!this.valid(grant, generation)) return null;
      this.update({ feedback: { source: "directory", surface: "conversation", tone: "neutral",
        message: receipt.existing ? "The directory already exists and is now in view." : "The directory was added to navigation." } });
      await this.refresh(false);
      return receipt;
    } catch (error) {
      if (this.valid(grant, generation)) {
        this.update({ feedback: { source: "directory", surface: "directory", tone: "error",
          message: error instanceof Error ? error.message : "Failed to add the directory." } });
        this.handlePermission(error);
      }
      return null;
    } finally { this.finishOperation(operation); }
  }
  async createSession(directory: string): Promise<string | null> {
    const grant = this.grant, generation = this.generation, navigation = this.navigationSequence;
    if (!grant || this.state.connection !== "connected" || !directory.trim()) return null;
    const operation = this.beginOperation({ kind: "session-create" });
    if (!operation) return null;
    try {
      const receipt = await this.mutation((signal) => this.api.createSession(grant, directory, createClientId(), signal));
      if (!this.valid(grant, generation)) return null;
      await this.refresh(false);
      if (navigation === this.navigationSequence) {
        this.select(receipt.threadId);
        this.update({ feedback: { source: "operation", surface: "conversation", tone: "neutral",
          threadId: receipt.threadId, message: "The new session was created and claimed by this browser window." } });
      }
      return receipt.threadId;
    } catch (error) {
      if (this.valid(grant, generation)) {
        this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          message: `${error instanceof Error ? error.message : "The creation result is unknown."} Refresh the directory to confirm; it will not retry automatically.` } });
        this.handlePermission(error);
      }
      return null;
    } finally { this.finishOperation(operation); }
  }
  async manageSession(entry: SessionEntry, action: "rename" | "archive" | "restore" | "release", name?: string): Promise<boolean> {
    const grant = this.grant, generation = this.generation;
    if (!grant || this.state.connection !== "connected" || !this.state.catalogFresh) return false;
    if (action !== "restore" && !isOwned(entry)) return false;
    if (action === "release" && entry.capabilities?.releaseToCodex !== true) return false;
    const operation = this.beginOperation({ kind: "session-manage", threadId: entry.threadId });
    if (!operation) return false;
    try {
      const receipt = await this.mutation((signal) => this.api.manageSession(grant, entry.threadId, action,
        entry.ownership?.version, name, signal));
      if (!this.valid(grant, generation)) return false;
      if (receipt.ok && action === "rename" && this.sameSelection(entry)) {
        this.timeline(entry.threadId, [...this.state.timelines[entry.threadId] ?? [],
          { id: `manage-${createClientId()}`, origin: "live", message: receipt.message }]);
      }
      await this.refresh(false);
      if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation",
        tone: receipt.ok ? "neutral" : "error", threadId: entry.threadId,
        message: receipt.ok ? action === "rename" ? "The session name was updated." : action === "archive" ? "The session was archived."
          : action === "release" ? "Released to external Codex. The browser will not bind it again automatically." : "The session was restored."
          : receipt.message.body.map((part) => "text" in part ? part.text : "value" in part ? part.value : "").filter(Boolean).join("\n") || "The operation did not complete." } });
      return receipt.ok;
    } catch (error) {
      if (this.valid(grant, generation)) {
        if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          threadId: entry.threadId, message: `${error instanceof Error ? error.message : "The operation result is unknown."} Refresh the status to confirm; it will not retry automatically.` } });
        this.handlePermission(error);
      }
      return false;
    } finally { this.finishOperation(operation); }
  }
  async send(): Promise<void> {
    const entry = selectedEntry(this.state);
    const text = entry ? this.state.drafts[entry.threadId] ?? "" : "";
    const attachments = entry ? this.state.attachments[entry.threadId] ?? [] : [];
    await this.sendText(text, true, attachments);
  }
  async actMessage(action: WebActionSpec): Promise<void> {
    switch (action.execution.type) {
      case "send-text": await this.sendText(action.execution.text, false);
        break;
      case "session-tool": await this.runSessionTool(action.execution.tool, action.execution.full);
    }
  }
  async runSessionTool(tool: SessionTool, full?: boolean): Promise<void> {
    const grant = this.grant, generation = this.generation, entry = selectedEntry(this.state);
    if (!grant || !entry || !canInteract(this.state)) return;
    const operation = this.beginOperation({ kind: "session-tool", threadId: entry.threadId });
    if (!operation) return;
    try {
      const receipt = await this.mutation((signal) => this.api.sessionTool(grant, entry.threadId, tool,
        entry.ownership!.version, full, signal));
      if (!this.valid(grant, generation)) return;
      this.timeline(entry.threadId, [...this.state.timelines[entry.threadId] ?? [],
        { id: `tool-${createClientId()}`, origin: "live", message: receipt.message }]);
      if (this.sameSelection(entry) && !receipt.ok) this.update({ feedback: { source: "operation", surface: "conversation",
        tone: "error", threadId: entry.threadId, message: "The operation did not complete. The reason is shown in the conversation." } });
      await this.loadQueue(entry, grant, generation);
    } catch (error) {
      if (this.valid(grant, generation)) {
        if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          threadId: entry.threadId, message: `${error instanceof Error ? error.message : "The operation result is unknown."} Check the conversation and status; it will not retry automatically.` } });
        this.handlePermission(error);
      }
    } finally { this.finishOperation(operation); }
  }
  async queueDraft(): Promise<void> {
    const grant = this.grant, generation = this.generation, entry = selectedEntry(this.state);
    const text = entry ? this.state.drafts[entry.threadId] ?? "" : "";
    const attachments = entry ? this.state.attachments[entry.threadId] ?? [] : [];
    const queue = entry ? this.state.queues[entry.threadId] : undefined;
    if (!grant || !entry || !canInteract(this.state) || !queue?.running ||
        (!text.trim() && !attachments.length) || text.length > 6000) return;
    const requestId = createClientId();
    if (!attachments.length && !sendRequestFits(entry.threadId, text, requestId, entry.ownership!.version)) {
      this.update({ feedback: { source: "composer", surface: "conversation", tone: "error", threadId: entry.threadId,
        message: "The message is too long after UTF-8 encoding and was not queued. Shorten it and try again." } }); return;
    }
    const operation = this.beginOperation({ kind: "queue-send", threadId: entry.threadId });
    if (!operation) return;
    try {
      const receipt = await this.mutation((signal) => this.api.queueSend(grant, entry.threadId, text, requestId,
        entry.ownership!.version, attachments, signal));
      if (receipt.accepted) {
        if (this.state.drafts[entry.threadId] === text) {
          this.update({ drafts: { ...this.state.drafts, [entry.threadId]: "" } });
          this.browser.drafts?.saveText(entry.threadId, "");
        }
        if (this.state.attachments[entry.threadId] === attachments) {
          this.update({ attachments: { ...this.state.attachments, [entry.threadId]: [] } });
          void this.browser.drafts?.saveAttachments(entry.threadId, []);
        }
        if (this.valid(grant, generation)) {
          await this.loadQueue(entry, grant, generation);
          if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "neutral",
            threadId: entry.threadId, message: "The message was added to the current run queue." } });
        }
      } else if (this.valid(grant, generation)) {
        if (receipt.prompt) this.timeline(entry.threadId, [...this.state.timelines[entry.threadId] ?? [],
          { id: `queue-refused-${requestId}`, origin: "live", message: receipt.prompt }]);
        if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          threadId: entry.threadId, message: "Bridge did not accept the queued message. The draft was preserved." } });
      }
    } catch (error) {
      if (this.valid(grant, generation)) {
        if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          threadId: entry.threadId, message: `${error instanceof Error ? error.message : "The queue result is unknown."} The draft was preserved. Refresh the queue to confirm; it will not retry automatically.` } });
        this.handlePermission(error);
      }
    } finally { this.finishOperation(operation); }
  }
  async cancelQueued(queueId: string): Promise<void> {
    const grant = this.grant, generation = this.generation, entry = selectedEntry(this.state);
    if (!grant || !entry || !canInteract(this.state)) return;
    const operation = this.beginOperation({ kind: "queue-cancel", threadId: entry.threadId });
    if (!operation) return;
    try {
      const receipt = await this.mutation((signal) => this.api.queueCancel(grant, entry.threadId, queueId,
        entry.ownership!.version, signal));
      if (!this.valid(grant, generation)) return;
      await this.loadQueue(entry, grant, generation);
      if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation",
        tone: receipt.ok ? "neutral" : "error", threadId: entry.threadId,
        message: receipt.ok ? "The queued message was cancelled." : "The queued message may have started and could not be cancelled." } });
    } catch (error) {
      if (this.valid(grant, generation)) {
        if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          threadId: entry.threadId, message: `${error instanceof Error ? error.message : "The cancellation result is unknown."} Refresh the queue to confirm; it will not retry automatically.` } });
        this.handlePermission(error);
      }
    } finally { this.finishOperation(operation); }
  }
  private async sendText(text: string, fromDraft: boolean, attachments: readonly File[] = []): Promise<void> {
    const grant = this.grant, generation = this.generation, entry = selectedEntry(this.state);
    if (!grant || !entry || !canInteract(this.state) ||
        (!text.trim() && !attachments.length) || text.length > 6000) return;
    const open = (this.state.timelines[entry.threadId] ?? []).some(hasOpenDecision);
    if (open) { this.update({ feedback: { source: "composer", surface: "conversation", tone: "error",
      threadId: entry.threadId, message: "Resolve the pending approval or input request before sending a message." } }); return; }
    const requestId = createClientId();
    if (!attachments.length && !sendRequestFits(entry.threadId, text, requestId, entry.ownership!.version)) {
      this.update({ feedback: { source: "composer", surface: "conversation", tone: "error", threadId: entry.threadId,
        message: "The message is too long after UTF-8 encoding and was not sent. Shorten it and try again." } });
      return;
    }
    const operation = this.beginOperation({ kind: "send", threadId: entry.threadId });
    if (!operation) return;
    const localId = `local-${requestId}`;
    const visibleText = [text.trim(), attachments.length ? `Images: ${attachments.map((file) => file.name).join(", ")}` : ""]
      .filter(Boolean).join("\n\n");
    this.timeline(entry.threadId, [...this.state.timelines[entry.threadId] ?? [], { id: localId, origin: "local", deliveryStatus: "sending",
      message: { kind: "user", title: "You", actions: [], body: [{ type: "markdown", text: visibleText }] } }]);
    const delivery = (deliveryStatus: TimelineItem["deliveryStatus"]) => this.timeline(entry.threadId,
      (this.state.timelines[entry.threadId] ?? []).map((item) => item.id === localId ? { ...item, deliveryStatus } : item));
    try {
      const receipt = await this.mutation((signal) =>
        this.api.send(grant, entry.threadId, text, requestId, entry.ownership!.version, attachments, signal));
      // Even after takeover, an accepted send is a receipt, not completion.
      if (receipt.accepted) {
        delivery("accepted");
        if (fromDraft && this.state.drafts[entry.threadId] === text) {
          this.update({ drafts: { ...this.state.drafts, [entry.threadId]: "" } });
          this.browser.drafts?.saveText(entry.threadId, "");
        }
        if (fromDraft && this.state.attachments[entry.threadId] === attachments) {
          this.update({ attachments: { ...this.state.attachments, [entry.threadId]: [] } });
          void this.browser.drafts?.saveAttachments(entry.threadId, []);
        }
      } else if (this.valid(grant, generation)) {
        delivery("refused");
        if (receipt.prompt) this.timeline(entry.threadId, [...this.state.timelines[entry.threadId] ?? [], { id: `refused-${requestId}`, origin: "live", message: receipt.prompt }]);
        if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          threadId: entry.threadId, message: fromDraft ? "Bridge did not accept the message. The draft was preserved." : "Bridge did not accept this action." } });
      }
    } catch (error) {
      delivery("unknown");
      if (this.valid(grant, generation)) {
        if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          threadId: entry.threadId, message: `${error instanceof Error ? error.message : "The send result is unknown."} The message may have been delivered${fromDraft ? "; the draft was preserved" : ""}. Check the conversation before deciding what to do; it will not resend automatically.` } });
        this.handlePermission(error);
      }
    } finally { this.finishOperation(operation); }
  }
  async actDecision(decisionId: string, action: string, content?: Record<string, unknown>): Promise<void> {
    const grant = this.grant, generation = this.generation, entry = selectedEntry(this.state);
    const card = entry && this.state.timelines[entry.threadId]?.find((item) => item.message.decision?.id === decisionId);
    const decision = card?.message.decision;
    if (!grant || !entry || !canInteract(this.state) || !decision || card?.openDecision === false ||
        !["pending", "awaitingInput"].includes(decision.state)) return;
    const supported = ["accept", "acceptForSession", "decline", "cancel"];
    if (action === "submit") {
      if (!decision.inputAllowed) return;
      if (!content || Array.isArray(content) || typeof content !== "object" ||
          decision.requestedFields.some((field) => !Object.hasOwn(content, field))) {
        this.update({ feedback: { source: "composer", surface: "conversation", tone: "error", threadId: entry.threadId,
          message: "Submit a JSON object containing every required field." } }); return;
      }
    } else if (!supported.includes(action) || !decision.availableActions.includes(action as "accept")) return;
    if (!decisionRequestFits(entry.threadId, decisionId, action, entry.ownership!.version, content)) {
      this.update({ feedback: { source: "composer", surface: "conversation", tone: "error", threadId: entry.threadId,
        message: "The MCP input is too long after UTF-8 encoding and was not submitted. Shorten the JSON and try again." } });
      return;
    }
    const operation = this.beginOperation({ kind: "decision", threadId: entry.threadId });
    if (!operation) return;
    try {
      const receipt = await this.mutation((signal) =>
        this.api.decision(grant, entry.threadId, decisionId, action, entry.ownership!.version, content, signal));
      if (!this.valid(grant, generation)) return;
      if (receipt.decisionId !== decisionId) throw new Error("The approval receipt does not match the request.");
      // A guarded terminal receipt can fill a lost SSE update, but must not overwrite
      // a newer native edit of this card. Awaiting-input controls come from a fresh read.
      const terminal = ["approved", "approvedForSession", "rejected", "cancelled", "stale"];
      if (receipt.accepted && receipt.state && terminal.includes(receipt.state)) this.timeline(entry.threadId,
        (this.state.timelines[entry.threadId] ?? []).map((item) => item.message.decision === decision ? { ...item,
          message: { ...item.message, decision: { ...decision, state: receipt.state as typeof decision.state,
            availableActions: [], inputAllowed: false } } } : item));
      if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation",
        tone: receipt.accepted ? "neutral" : "error", threadId: entry.threadId,
        message: receipt.accepted
          ? receipt.state === "awaitingInput" ? "Awaiting input. Fill in the JSON; it has not been submitted to the runtime." : "The approval action was accepted. This does not mean execution succeeded."
          : receipt.message ?? "Bridge did not accept the approval action." } });
      await this.refresh(true);
    } catch (error) {
      if (this.valid(grant, generation)) {
        if (this.sameSelection(entry)) this.update({ feedback: { source: "operation", surface: "conversation", tone: "error",
          threadId: entry.threadId, message: `${error instanceof Error ? error.message : "The approval result is unknown."} It will not retry automatically. Refresh and check the original card.` } });
        this.handlePermission(error);
      }
    } finally { this.finishOperation(operation); }
  }
  dispose(): void { this.disposed = true; this.generation++; this.stopStreams(); this.unsubscribeLocation?.();
    this.browser.notifications?.dispose(); this.listeners.clear(); }
}
