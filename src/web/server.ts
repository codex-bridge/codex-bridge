import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { readFileSync } from "node:fs";
import { isIP, type AddressInfo } from "node:net";
import { File } from "node:buffer";

import { WebWindowLeaseManager, type WebWindowLease } from "./window-lease.js";
import { WebSendError, type WebBridgeApi, type WebSessionManageInput, type WebSessionTool, type WebTextInput } from "./bridge-api.js";
import { SessionAccessError } from "../bridge/sessions/access.js";
import { WebDecisionError, type WebDecisionInput } from "./decisions.js";
import type { DecisionAction } from "../shared/types.js";
import { serveWebAsset } from "./static.js";
import { WEB_REQUEST_BODY_LIMIT_BYTES } from "./protocol-limits.js";
import { DirectoryRegistrationError } from "../bridge/sessions/directory-registry.js";
import {
  isSupportedWebImage,
  WEB_ATTACHMENT_MAX_FILES,
  WEB_ATTACHMENT_MAX_FILE_BYTES,
  WEB_ATTACHMENT_MAX_REQUEST_BYTES,
  WEB_ATTACHMENT_MAX_TOTAL_BYTES,
  type WebUploadFile
} from "./attachments.js";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    request.resume();
    throw new HttpError(413, "Request body is too large.");
  }
  return new Promise<Buffer>((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const cleanup = (keepErrorListener = false): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      if (!keepErrorListener) request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onError = (): void => {
      cleanup();
      reject(new HttpError(400, "Could not read request body."));
    };
    const onAborted = (): void => {
      // IncomingMessage may emit error after aborted; keep it handled while closing.
      cleanup(true);
      reject(new HttpError(400, "Could not read request body."));
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > limit) {
        cleanup(true);
        request.resume();
        reject(new HttpError(413, "Request body is too large."));
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "Expected application/json.");
  }
  const body = (await readBody(request, WEB_REQUEST_BODY_LIMIT_BYTES)).toString("utf8");
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Expected a JSON object.");
  }
}

function validSendInput(input: WebTextInput): boolean {
  return Boolean(input.threadId.trim()) && input.threadId.length <= 256 &&
    (input.leaseVersion === undefined || Number.isSafeInteger(input.leaseVersion) && input.leaseVersion >= 0) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) && input.text.length <= 6000 &&
    (Boolean(input.text.trim()) || Boolean(input.attachments?.length));
}

async function readSendInput(request: IncomingMessage): Promise<WebTextInput> {
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.split(";")[0]?.trim() === "application/json") {
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["threadId", "leaseVersion", "requestId", "text"].includes(key))) {
      throw new HttpError(400, "Expected threadId, optional leaseVersion, requestId and text only.");
    }
    const input = { threadId: body.threadId, leaseVersion: body.leaseVersion,
      requestId: body.requestId, text: body.text } as Partial<WebTextInput>;
    if (typeof input.threadId !== "string" || typeof input.requestId !== "string" || typeof input.text !== "string" ||
        !validSendInput(input as WebTextInput)) {
      throw new HttpError(400, "Expected threadId, optional leaseVersion, requestId and non-empty text up to 6000 characters.");
    }
    return input as WebTextInput;
  }
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new HttpError(415, "Expected application/json or multipart/form-data.");
  }
  let form: FormData;
  try {
    const body = await readBody(request, WEB_ATTACHMENT_MAX_REQUEST_BYTES);
    const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Could not parse multipart attachment request.");
  }
  const counts = new Map<string, number>();
  for (const [key] of form.entries()) counts.set(key, (counts.get(key) ?? 0) + 1);
  if ([...counts.keys()].some((key) => !["threadId", "leaseVersion", "requestId", "text", "attachment"].includes(key)) ||
      ["threadId", "requestId", "text"].some((key) => counts.get(key) !== 1) || (counts.get("leaseVersion") ?? 0) > 1) {
    throw new HttpError(400, "Unexpected or repeated multipart fields.");
  }
  const threadId = form.get("threadId");
  const requestId = form.get("requestId");
  const text = form.get("text");
  const rawLease = form.get("leaseVersion");
  const attachmentValues = form.getAll("attachment");
  if (typeof threadId !== "string" || typeof requestId !== "string" || typeof text !== "string" ||
      rawLease !== null && typeof rawLease !== "string" || !attachmentValues.length ||
      attachmentValues.length > WEB_ATTACHMENT_MAX_FILES || attachmentValues.some((value) => !(value instanceof File))) {
    throw new HttpError(400, "Expected text fields and one to five file attachments.");
  }
  const leaseVersion = rawLease === null ? undefined : Number(rawLease);
  const attachments: WebUploadFile[] = await Promise.all((attachmentValues as File[]).map(async (file) => ({
    bytes: new Uint8Array(await file.arrayBuffer()),
    mimeType: file.type.trim() || null,
    name: file.name,
    sizeBytes: file.size
  })));
  const input: WebTextInput = { threadId, requestId, text, attachments,
    ...(leaseVersion === undefined ? {} : { leaseVersion }) };
  if (!validSendInput(input) || attachments.some((file) => !file.name.trim() || file.name.length > 255 ||
      file.sizeBytes < 1 || file.sizeBytes > WEB_ATTACHMENT_MAX_FILE_BYTES || !isSupportedWebImage(file)) ||
      attachments.reduce((sum, file) => sum + file.sizeBytes, 0) > WEB_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new HttpError(400, "Attachment send fields or file limits are invalid.");
  }
  return input;
}

/** HTTP transport; session policy stays behind the Bridge API. */
export class WebServer {
  private readonly leases = new WebWindowLeaseManager();
  private currentLease: WebWindowLease | null = null;
  private readonly streams = new Set<ServerResponse>();
  private readonly server: Server;
  private readonly handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    void this.handle(request, response).catch((error: unknown) => {
      if (!response.headersSent && !response.destroyed) {
        const status = error instanceof HttpError ? error.status : error instanceof SessionAccessError
          ? { stale: 409, not_owner: 403, unavailable: 404 }[error.reason]
          : error instanceof DirectoryRegistrationError
            ? { required: 400, not_found: 404, not_directory: 400, inaccessible: 403 }[error.reason]
          : error instanceof WebSendError ? (error.reason === "waiting" ? 409 : 503)
            : error instanceof WebDecisionError ? { inactive: 409, invalid_action: 400, disconnected: 503, unavailable: 404 }[error.reason] : 500;
        const fallbackMessage = request.method === "POST" && ["/api/web/session/send", "/api/web/session/decision", "/api/web/session/create",
          "/api/web/session/manage", "/api/web/session/tool", "/api/web/session/queue/send", "/api/web/session/queue/cancel"].includes(request.url ?? "")
          ? "Internal Web server error. Operation outcome may be unknown; do not retry automatically."
          : "Internal Web server error.";
        json(response, status, {
          error: error instanceof HttpError || error instanceof SessionAccessError || error instanceof DirectoryRegistrationError || error instanceof WebSendError || error instanceof WebDecisionError ? error.message
            : error instanceof Error && error.message.trim() ? error.message.trim() : fallbackMessage,
          ...(error instanceof SessionAccessError || error instanceof DirectoryRegistrationError || error instanceof WebSendError || error instanceof WebDecisionError ? { reason: error.reason } : {})
        });
      } else {
        response.end();
      }
      request.resume();
    });
  };

  constructor(private readonly options: { host: string; port: number; staticRoot?: string;
    tls?: { certFile: string; keyFile: string } }, private readonly bridge?: WebBridgeApi) {
    this.server = options.tls
      ? createSecureServer({ cert: readFileSync(options.tls.certFile), key: readFileSync(options.tls.keyFile) }, this.handleRequest)
      : createServer(this.handleRequest);
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
  }

  async start(): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { reject(error); };
      this.server.once("error", onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    return this.server.address() as AddressInfo;
  }

  async stop(): Promise<void> {
    for (const response of this.streams) {
      response.end('event: connection-lost\ndata: {"reason":"server_stopped"}\n\n');
    }
    if (this.currentLease) {
      this.leases.release(this.currentLease.windowId, this.currentLease.token);
      this.currentLease = null;
    }
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
      this.server.closeAllConnections();
    });
  }

  private checkOrigin(request: IncomingMessage): URL {
    const host = request.headers.host;
    let url: URL;
    const protocol = this.options.tls ? "https:" : "http:";
    try {
      if (!host || !request.url?.startsWith("/") || request.url.startsWith("//")) throw new Error();
      url = new URL(`${protocol}//${host}${request.url}`);
      const authority = new URL(`${protocol}//${host}`);
      if (authority.username || authority.password || authority.pathname !== "/" || authority.search || authority.hash) throw new Error();
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      if (hostname !== "localhost" && !isIP(hostname)) throw new Error();
      if (Number(url.port || (this.options.tls ? 443 : 80)) !== (this.server.address() as AddressInfo).port) throw new Error();
    } catch {
      throw new HttpError(403, "Invalid Web host.");
    }
    if (request.headers["sec-fetch-site"] === "cross-site" ||
        (request.headers.origin && request.headers.origin !== url.origin)) {
      throw new HttpError(403, "Cross-origin Web requests are not allowed.");
    }
    return url;
  }

  private requireLease(request: IncomingMessage): WebWindowLease {
    const windowId = request.headers["x-bridge-window-id"];
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const lease = typeof windowId === "string" ? this.leases.resume(windowId, token) : null;
    if (!lease) throw new HttpError(403, "This window does not hold the Web connection.");
    return lease;
  }

  private openStream(response: ServerResponse, lease: WebWindowLease): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no"
    });
    response.write(`event: connected\ndata: ${JSON.stringify({ windowId: lease.windowId })}\n\n`);
    this.streams.add(response);
    const unsubscribe = this.bridge?.subscribeBinding?.((event) => {
      if (!lease.signal.aborted && !response.writableEnded && !response.destroyed) {
        if (!response.write(`event: session-binding\ndata: ${JSON.stringify(event)}\n\n`)) response.end();
      }
    });
    const unsubscribeMessages = this.bridge?.subscribeMessages?.((delivery) => {
      if (!lease.signal.aborted && !response.writableEnded && !response.destroyed && delivery.isCurrent()) {
        if (!response.write(`event: message\ndata: ${JSON.stringify(delivery.event)}\n\n`)) response.end();
      }
    });
    const unsubscribeAttention = this.bridge?.subscribeAttention?.((delivery) => {
      if (!lease.signal.aborted && !response.writableEnded && !response.destroyed && delivery.isCurrent()) {
        if (!response.write(`event: attention\ndata: ${JSON.stringify(delivery.event)}\n\n`)) response.end();
      }
    });
    const onRevoked = (): void => {
      if (response.writableEnded) return;
      response.end(`event: connection-lost\ndata: ${JSON.stringify({ reason: lease.signal.reason })}\n\n`);
    };
    lease.signal.addEventListener("abort", onRevoked, { once: true });
    const heartbeat = setInterval(() => {
      if (!response.write(": heartbeat\n\n")) response.end();
    }, 15_000);
    heartbeat.unref();
    response.once("close", () => {
      unsubscribe?.();
      unsubscribeMessages?.();
      unsubscribeAttention?.();
      clearInterval(heartbeat);
      lease.signal.removeEventListener("abort", onRevoked);
      this.streams.delete(response);
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = this.checkOrigin(request);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/web/health":
        json(response, 200, { status: "ok" });
        return;
      case "GET /api/web/connection":
        json(response, 200, { holderWindowId: this.leases.getHolderWindowId() });
        return;
      case "POST /api/web/window/acquire": {
        const body = await readJson(request);
        if (typeof body.windowId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.windowId) ||
            (body.takeover !== undefined && typeof body.takeover !== "boolean")) {
          throw new HttpError(400, "Expected a windowId and optional boolean takeover.");
        }
        const result = this.leases.acquire(body.windowId, { takeover: body.takeover === true });
        if (!result.acquired) {
          json(response, 409, result);
          return;
        }
        this.currentLease = result.lease;
        json(response, 200, {
          acquired: true, windowId: result.lease.windowId, token: result.lease.token,
          replacedWindowId: result.replacedWindowId
        });
        return;
      }
      case "GET /api/web/window": {
        const lease = this.requireLease(request);
        json(response, 200, { windowId: lease.windowId });
        return;
      }
      case "POST /api/web/window/restore": {
        await readJson(request);
        const previous = this.requireLease(request);
        const lease = this.leases.restore(previous.windowId, previous.token)!;
        this.currentLease = lease;
        json(response, 200, { windowId: lease.windowId, token: lease.token });
        return;
      }
      case "POST /api/web/window/release": {
        await readJson(request);
        // Validate after awaiting the body: a takeover may have revoked earlier credentials.
        const lease = this.requireLease(request);
        this.leases.release(lease.windowId, lease.token);
        this.currentLease = null;
        json(response, 200, { released: true });
        return;
      }
      case "GET /api/web/events":
        this.openStream(response, this.requireLease(request));
        return;
      case "GET /api/web/catalog": {
        this.requireLease(request);
        if (!this.bridge) throw new HttpError(503, "Web Bridge API is unavailable.");
        const catalog = await this.bridge.listCatalog();
        this.requireLease(request);
        json(response, 200, catalog);
        return;
      }
      case "POST /api/web/directories": {
        this.requireLease(request);
        const body = await readJson(request);
        this.requireLease(request);
        if (typeof body.path !== "string" || !body.path.trim() || body.path.length > 4096 ||
            Object.keys(body).some((key) => key !== "path")) {
          throw new HttpError(400, "Expected a non-empty directory path up to 4096 characters.");
        }
        if (!this.bridge?.registerDirectory) throw new HttpError(503, "Web directory API is unavailable.");
        const result = await this.bridge.registerDirectory(body.path, () => { this.requireLease(request); });
        this.requireLease(request);
        json(response, 200, result);
        return;
      }
      case "POST /api/web/session/create": {
        this.requireLease(request);
        const body = await readJson(request);
        this.requireLease(request);
        if (typeof body.directory !== "string" || !body.directory.trim() || body.directory.length > 4096 ||
            typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId) ||
            Object.keys(body).some((key) => !["directory", "requestId"].includes(key))) {
          throw new HttpError(400, "Expected directory and requestId.");
        }
        if (!this.bridge?.createSession) throw new HttpError(503, "Web session creation is unavailable.");
        const result = await this.bridge.createSession(body.directory, body.requestId, () => { this.requireLease(request); });
        this.requireLease(request);
        json(response, 201, result);
        return;
      }
      case "POST /api/web/session/manage": {
        this.requireLease(request);
        const body = await readJson(request);
        this.requireLease(request);
        const action = body.action;
        if (typeof body.threadId !== "string" || !body.threadId.trim() || body.threadId.length > 256 ||
            (body.leaseVersion !== undefined && (!Number.isSafeInteger(body.leaseVersion) || Number(body.leaseVersion) < 0)) ||
            typeof action !== "string" || !["rename", "archive", "restore", "release"].includes(action) ||
            (action === "rename" ? typeof body.name !== "string" || !body.name.trim() || body.name.length > 48 : body.name !== undefined) ||
            Object.keys(body).some((key) => !["threadId", "leaseVersion", "action", "name"].includes(key))) {
          throw new HttpError(400, "Expected a valid session management action.");
        }
        if (!this.bridge?.manageSession) throw new HttpError(503, "Web session management is unavailable.");
        const input = { threadId: body.threadId, leaseVersion: body.leaseVersion as number | undefined, action,
          ...(action === "rename" ? { name: body.name as string } : {}) } as WebSessionManageInput;
        const result = await this.bridge.manageSession(input, () => { this.requireLease(request); });
        this.requireLease(request);
        json(response, 200, result);
        return;
      }
      case "POST /api/web/session/tool": {
        this.requireLease(request);
        const body = await readJson(request);
        this.requireLease(request);
        if (typeof body.threadId !== "string" || !body.threadId.trim() || body.threadId.length > 256 ||
            (body.leaseVersion !== undefined && (!Number.isSafeInteger(body.leaseVersion) || Number(body.leaseVersion) < 0)) ||
            typeof body.tool !== "string" || !["help", "status", "compact", "interrupt"].includes(body.tool) ||
            (body.full !== undefined && typeof body.full !== "boolean") ||
            (body.tool !== "status" && body.full !== undefined) ||
            Object.keys(body).some((key) => !["threadId", "leaseVersion", "tool", "full"].includes(key))) {
          throw new HttpError(400, "Expected threadId, optional leaseVersion and a supported tool.");
        }
        if (!this.bridge?.runSessionTool) throw new HttpError(503, "Web session tools are unavailable.");
        const result = await this.bridge.runSessionTool(body.threadId, body.leaseVersion as number | undefined,
          body.tool as WebSessionTool, body.full as boolean | undefined, () => { this.requireLease(request); });
        this.requireLease(request);
        json(response, 200, result);
        return;
      }
      case "POST /api/web/session/queue/read": {
        this.requireLease(request);
        const body = await readJson(request);
        this.requireLease(request);
        if (typeof body.threadId !== "string" || !body.threadId.trim() || body.threadId.length > 256 ||
            (body.leaseVersion !== undefined && (!Number.isSafeInteger(body.leaseVersion) || Number(body.leaseVersion) < 0)) ||
            Object.keys(body).some((key) => !["threadId", "leaseVersion"].includes(key))) {
          throw new HttpError(400, "Expected threadId and optional leaseVersion.");
        }
        if (!this.bridge?.readQueue) throw new HttpError(503, "Web queue is unavailable.");
        const result = await this.bridge.readQueue(body.threadId, body.leaseVersion as number | undefined,
          () => { this.requireLease(request); });
        this.requireLease(request);
        json(response, 200, result);
        return;
      }
      case "POST /api/web/session/queue/send": {
        this.requireLease(request);
        const body = await readSendInput(request);
        this.requireLease(request);
        if (!this.bridge?.queueText) throw new HttpError(503, "Web queue is unavailable.");
        const result = await this.bridge.queueText(body, () => { this.requireLease(request); });
        if (!result.accepted) { this.requireLease(request); result.assertCurrent?.(); }
        json(response, result.accepted ? 202 : 422, { accepted: result.accepted, requestId: result.requestId,
          ...(!result.accepted && result.prompt ? { prompt: result.prompt } : {}) });
        return;
      }
      case "POST /api/web/session/queue/cancel": {
        this.requireLease(request);
        const body = await readJson(request);
        this.requireLease(request);
        if (typeof body.threadId !== "string" || !body.threadId.trim() || body.threadId.length > 256 ||
            (body.leaseVersion !== undefined && (!Number.isSafeInteger(body.leaseVersion) || Number(body.leaseVersion) < 0)) ||
            typeof body.queueId !== "string" || !body.queueId.trim() || body.queueId.length > 256 ||
            Object.keys(body).some((key) => !["threadId", "leaseVersion", "queueId"].includes(key))) {
          throw new HttpError(400, "Expected threadId, optional leaseVersion and queueId.");
        }
        if (!this.bridge?.cancelQueued) throw new HttpError(503, "Web queue is unavailable.");
        const result = await this.bridge.cancelQueued(body.threadId, body.leaseVersion as number | undefined,
          body.queueId, () => { this.requireLease(request); });
        this.requireLease(request);
        json(response, 200, result);
        return;
      }
      case "POST /api/web/session/request":
      case "POST /api/web/session/cancel":
      case "POST /api/web/session/decisions":
      case "POST /api/web/session/history": {
        this.requireLease(request);
        const body = await readJson(request);
        this.requireLease(request);
        if (typeof body.threadId !== "string" || !body.threadId.trim() || body.threadId.length > 256 ||
            (body.leaseVersion !== undefined && (!Number.isSafeInteger(body.leaseVersion) || Number(body.leaseVersion) < 0))) {
          throw new HttpError(400, "Expected threadId and optional non-negative integer leaseVersion.");
        }
        if (route.endsWith("/decisions")) {
          if (Object.keys(body).some((key) => !["threadId", "leaseVersion"].includes(key))) throw new HttpError(400, "Expected threadId and optional leaseVersion only.");
          if (!this.bridge?.readDecisions) throw new HttpError(503, "Web decision API is unavailable.");
          const result = await this.bridge.readDecisions(body.threadId, body.leaseVersion as number | undefined, () => { this.requireLease(request); });
          this.requireLease(request);
          result.assertCurrent();
          json(response, 200, result.snapshot);
          return;
        }
        if (route.endsWith("/history")) {
          if (!this.bridge?.readHistory) throw new HttpError(503, "Web conversation API is unavailable.");
          const result = await this.bridge.readHistory(body.threadId, body.leaseVersion as number | undefined,
            () => { this.requireLease(request); });
          this.requireLease(request);
          result.assertCurrent();
          json(response, 200, result.history);
          return;
        }
        const operation = route.endsWith("/request") ? this.bridge?.requestBinding?.bind(this.bridge) : this.bridge?.cancelBinding?.bind(this.bridge);
        if (!operation) throw new HttpError(503, "Web session binding API is unavailable.");
        const result = await operation(body.threadId, body.leaseVersion as number | undefined,
          () => { this.requireLease(request); });
        this.requireLease(request);
        // Do not expose the stored SessionRecord (rollout paths, legacy transport fields).
        const bodyResult = "outcome" in result ? {
          owned: result.outcome?.owned ?? false,
          pending: result.outcome?.pending ?? false,
          reason: result.outcome?.reason ?? "unavailable",
          replacedSourceId: result.outcome?.replacedSourceId ?? null,
          leaseVersion: result.outcome?.lease.version ?? null
        } : { cancelled: result.cancelled, reason: result.reason, leaseVersion: result.lease?.version ?? null };
        json(response, 200, bodyResult);
        return;
      }
      case "POST /api/web/session/send": {
        this.requireLease(request);
        const body = await readSendInput(request);
        this.requireLease(request);
        if (!this.bridge?.sendText) throw new HttpError(503, "Web send API is unavailable.");
        const result = await this.bridge.sendText(body, () => { this.requireLease(request); });
        if (!result.accepted) {
          this.requireLease(request);
          result.assertCurrent?.();
        }
        const receipt = { accepted: result.accepted, requestId: result.requestId,
          ...(!result.accepted && result.prompt ? { prompt: result.prompt } : {}) };
        json(response, result.accepted ? 202 : 422, receipt);
        return;
      }
      case "POST /api/web/session/decision": {
        this.requireLease(request);
        const body = await readJson(request);
        this.requireLease(request);
        const submitting = body.action === "submit";
        if (typeof body.threadId !== "string" || !body.threadId.trim() || body.threadId.length > 256 ||
            (body.leaseVersion !== undefined && (!Number.isSafeInteger(body.leaseVersion) || Number(body.leaseVersion) < 0)) ||
            typeof body.decisionId !== "string" || !body.decisionId.trim() || body.decisionId.length > 256 ||
            typeof body.action !== "string" || !["accept", "acceptForSession", "decline", "cancel", "submit"].includes(body.action) ||
            (submitting ? !body.content || typeof body.content !== "object" || Array.isArray(body.content) : body.content !== undefined) ||
            Object.keys(body).some((key) => !["threadId", "leaseVersion", "decisionId", "action", "content"].includes(key))) {
          throw new HttpError(400, "Expected threadId, optional leaseVersion, decisionId and action; submit requires a JSON object content.");
        }
        if (!this.bridge?.actDecision) throw new HttpError(503, "Web decision API is unavailable.");
        const input: WebDecisionInput = submitting
          ? { threadId: body.threadId, leaseVersion: body.leaseVersion as number | undefined, decisionId: body.decisionId,
            action: "submit", content: body.content as Record<string, unknown> }
          : { threadId: body.threadId, leaseVersion: body.leaseVersion as number | undefined, decisionId: body.decisionId, action: body.action as DecisionAction };
        const result = await this.bridge.actDecision(input, () => { this.requireLease(request); });
        if (!result.accepted) { this.requireLease(request); result.assertCurrent?.(); }
        json(response, result.accepted ? 200 : 422, { accepted: result.accepted, decisionId: result.decisionId, state: result.state,
          ...(!result.accepted && result.message ? { message: result.message } : {}) });
        return;
      }
      default:
        if (request.method === "GET" && await serveWebAsset(url.pathname, response, this.options.staticRoot)) return;
        throw new HttpError(404, "Unknown Web endpoint.");
    }
  }
}
