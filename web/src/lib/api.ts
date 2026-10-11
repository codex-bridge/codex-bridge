import type { BindingReceipt, Catalog, DecisionReceipt, Decisions, DirectoryReceipt, Grant, History, OperationReceipt,
  QueueSnapshot, SendReceipt, SessionCreateReceipt, SessionTool, StreamEvent } from "./protocol";
import { WEB_REQUEST_BODY_LIMIT_BYTES } from "../../../src/web/protocol-limits";

const encoder = new TextEncoder();
const sendRequestBody = (threadId: string, text: string, requestId: string, leaseVersion: number) =>
  ({ threadId, text, requestId, leaseVersion });
const decisionRequestBody = (threadId: string, decisionId: string, action: string, leaseVersion: number,
  content?: Record<string, unknown>) => ({ threadId, decisionId, action, leaseVersion, ...(content ? { content } : {}) });
const requestFits = (body: unknown): boolean => encoder.encode(JSON.stringify(body)).byteLength <= WEB_REQUEST_BODY_LIMIT_BYTES;

export const sendRequestFits = (threadId: string, text: string, requestId: string, leaseVersion: number): boolean =>
  requestFits(sendRequestBody(threadId, text, requestId, leaseVersion));
export const decisionRequestFits = (threadId: string, decisionId: string, action: string, leaseVersion: number,
  content?: Record<string, unknown>): boolean => requestFits(decisionRequestBody(threadId, decisionId, action, leaseVersion, content));

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string) { super(message); }
}

/** Chunk-safe SSE decoding; comments and unrecognised event names are harmless. */
export async function* decodeEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "", name = "message", data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length + data.join("").length > 1_048_576) throw new Error("The live message is too large, so reading stopped. Refresh the conversation.");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (!line) {
          if (data.length) yield { name, data: JSON.parse(data.join("\n")) as unknown };
          name = "message"; data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const content = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") name = content;
          if (field === "data") data.push(content);
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export interface WorkbenchApi {
  holder(): Promise<{ holderWindowId: string | null }>;
  acquire(windowId: string, takeover: boolean): Promise<Grant>;
  resume(grant: Grant): Promise<unknown>;
  restore(grant: Grant): Promise<Grant>;
  catalog(grant: Grant, signal?: AbortSignal): Promise<Catalog>;
  directory(grant: Grant, path: string, signal?: AbortSignal): Promise<DirectoryReceipt>;
  history(grant: Grant, threadId: string, signal?: AbortSignal): Promise<History>;
  decisions(grant: Grant, threadId: string, signal?: AbortSignal): Promise<Decisions>;
  binding(grant: Grant, threadId: string, action: "request" | "cancel", leaseVersion?: number, signal?: AbortSignal): Promise<BindingReceipt>;
  send(grant: Grant, threadId: string, text: string, requestId: string, leaseVersion: number,
    attachments?: readonly File[], signal?: AbortSignal): Promise<SendReceipt>;
  decision(grant: Grant, threadId: string, decisionId: string, action: string, leaseVersion: number,
    content?: Record<string, unknown>, signal?: AbortSignal): Promise<DecisionReceipt>;
  createSession(grant: Grant, directory: string, requestId: string, signal?: AbortSignal): Promise<SessionCreateReceipt>;
  manageSession(grant: Grant, threadId: string, action: "rename" | "archive" | "restore" | "release", leaseVersion?: number,
    name?: string, signal?: AbortSignal): Promise<OperationReceipt>;
  sessionTool(grant: Grant, threadId: string, tool: SessionTool, leaseVersion?: number,
    full?: boolean, signal?: AbortSignal): Promise<OperationReceipt>;
  queue(grant: Grant, threadId: string, leaseVersion?: number, signal?: AbortSignal): Promise<QueueSnapshot>;
  queueSend(grant: Grant, threadId: string, text: string, requestId: string, leaseVersion: number,
    attachments?: readonly File[], signal?: AbortSignal): Promise<SendReceipt>;
  queueCancel(grant: Grant, threadId: string, queueId: string, leaseVersion: number,
    signal?: AbortSignal): Promise<OperationReceipt>;
  events(grant: Grant, signal: AbortSignal, receive: (event: StreamEvent) => void): Promise<void>;
}

export class HttpWorkbenchApi implements WorkbenchApi {
  constructor(private readonly request: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private headers(grant?: Grant): Record<string, string> {
    return grant ? { "X-Bridge-Window-Id": grant.windowId, Authorization: `Bearer ${grant.token}` } : {};
  }
  private async json<T>(path: string, grant?: Grant, body?: unknown, signal?: AbortSignal, allowRefusal = false): Promise<T> {
    const response = await this.request(`/api/web/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { ...this.headers(grant), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal, cache: "no-store", credentials: "same-origin" });
    const result = await response.json() as { error?: string; reason?: string; holderWindowId?: string; accepted?: boolean };
    if (allowRefusal && response.status === 422 && result.accepted === false) return result as T;
    if (!response.ok) throw new ApiError(response.status, result.error ?? (response.status === 409 && result.holderWindowId
      ? "Another browser window is connected. You can explicitly take over without interrupting the session task." : "Bridge request failed."), result.reason);
    return result as T;
  }
  private async multipart<T>(path: string, grant: Grant, body: FormData, signal?: AbortSignal,
    allowRefusal = false): Promise<T> {
    const response = await this.request(`/api/web/${path}`, { method: "POST", headers: this.headers(grant), body,
      signal, cache: "no-store", credentials: "same-origin" });
    const result = await response.json() as { error?: string; reason?: string; accepted?: boolean };
    if (allowRefusal && response.status === 422 && result.accepted === false) return result as T;
    if (!response.ok) throw new ApiError(response.status, result.error ?? "Bridge request failed.", result.reason);
    return result as T;
  }
  private sendBody(threadId: string, text: string, requestId: string, leaseVersion: number,
    attachments: readonly File[]): FormData {
    const body = new FormData();
    body.set("threadId", threadId); body.set("requestId", requestId); body.set("leaseVersion", String(leaseVersion));
    body.set("text", text);
    for (const file of attachments) body.append("attachment", file, file.name);
    return body;
  }
  holder() { return this.json<{ holderWindowId: string | null }>("connection"); }
  async acquire(windowId: string, takeover: boolean): Promise<Grant> {
    const result = await this.json<Grant>("window/acquire", undefined, { windowId, takeover });
    return { windowId: result.windowId, token: result.token };
  }
  resume(grant: Grant) { return this.json("window", grant); }
  restore(grant: Grant) { return this.json<Grant>("window/restore", grant, {}); }
  catalog(grant: Grant, signal?: AbortSignal) { return this.json<Catalog>("catalog", grant, undefined, signal); }
  directory(grant: Grant, path: string, signal?: AbortSignal) {
    return this.json<DirectoryReceipt>("directories", grant, { path }, signal);
  }
  history(grant: Grant, threadId: string, signal?: AbortSignal) { return this.json<History>("session/history", grant, { threadId }, signal); }
  decisions(grant: Grant, threadId: string, signal?: AbortSignal) { return this.json<Decisions>("session/decisions", grant, { threadId }, signal); }
  binding(grant: Grant, threadId: string, action: "request" | "cancel", leaseVersion?: number, signal?: AbortSignal) {
    return this.json<BindingReceipt>(`session/${action}`, grant, { threadId, leaseVersion }, signal);
  }
  send(grant: Grant, threadId: string, text: string, requestId: string, leaseVersion: number,
    attachments: readonly File[] = [], signal?: AbortSignal) {
    return attachments.length
      ? this.multipart<SendReceipt>("session/send", grant,
        this.sendBody(threadId, text, requestId, leaseVersion, attachments), signal, true)
      : this.json<SendReceipt>("session/send", grant, sendRequestBody(threadId, text, requestId, leaseVersion), signal, true);
  }
  decision(grant: Grant, threadId: string, decisionId: string, action: string, leaseVersion: number,
    content?: Record<string, unknown>, signal?: AbortSignal) {
    return this.json<DecisionReceipt>("session/decision", grant,
      decisionRequestBody(threadId, decisionId, action, leaseVersion, content), signal, true);
  }
  createSession(grant: Grant, directory: string, requestId: string, signal?: AbortSignal) {
    return this.json<SessionCreateReceipt>("session/create", grant, { directory, requestId }, signal);
  }
  manageSession(grant: Grant, threadId: string, action: "rename" | "archive" | "restore" | "release", leaseVersion?: number,
    name?: string, signal?: AbortSignal) {
    return this.json<OperationReceipt>("session/manage", grant,
      { threadId, action, leaseVersion, ...(action === "rename" ? { name } : {}) }, signal);
  }
  sessionTool(grant: Grant, threadId: string, tool: SessionTool, leaseVersion?: number, full?: boolean, signal?: AbortSignal) {
    return this.json<OperationReceipt>("session/tool", grant,
      { threadId, tool, leaseVersion, ...(tool === "status" && full !== undefined ? { full } : {}) }, signal);
  }
  queue(grant: Grant, threadId: string, leaseVersion?: number, signal?: AbortSignal) {
    return this.json<QueueSnapshot>("session/queue/read", grant, { threadId, leaseVersion }, signal);
  }
  queueSend(grant: Grant, threadId: string, text: string, requestId: string, leaseVersion: number,
    attachments: readonly File[] = [], signal?: AbortSignal) {
    return attachments.length
      ? this.multipart<SendReceipt>("session/queue/send", grant,
        this.sendBody(threadId, text, requestId, leaseVersion, attachments), signal, true)
      : this.json<SendReceipt>("session/queue/send", grant,
        sendRequestBody(threadId, text, requestId, leaseVersion), signal, true);
  }
  queueCancel(grant: Grant, threadId: string, queueId: string, leaseVersion: number, signal?: AbortSignal) {
    return this.json<OperationReceipt>("session/queue/cancel", grant,
      { threadId, queueId, leaseVersion }, signal);
  }
  async events(grant: Grant, signal: AbortSignal, receive: (event: StreamEvent) => void): Promise<void> {
    const response = await this.request("/api/web/events", { headers: this.headers(grant), signal, cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new ApiError(response.status, "The service connection could not be restored. Reconnect or explicitly take over.");
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("The Bridge live endpoint did not return an event stream.");
    for await (const event of decodeEvents(response.body)) { if (signal.aborted) return; receive(event); }
  }
}
