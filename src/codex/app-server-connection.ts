import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import readline from "node:readline";

import { logger } from "../logging/logger.js";

export type JsonRpcId = string | number;

export class AppServerRpcError extends Error {
  readonly method: string;
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(method: string, error: { code?: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = "AppServerRpcError";
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
}

export type AppServerServerRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcSuccess = {
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcError = {
  id: JsonRpcId | null;
  error: {
    code?: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type AppServerConnectionDependencies = {
  args: string[];
  command: string;
  onDisconnected: (options: { expected: boolean }) => void;
  onInitialized: (result: unknown) => void;
  onNotification: (notification: JsonRpcNotification) => void;
  onServerRequest: (request: AppServerServerRequest) => void;
  readEnvironment: () => Promise<Record<string, string>>;
  transport: "stdio" | "websocket";
};

type PendingRequest = {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

export class AppServerConnection {
  private expectedExit = false;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private proc: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private rl: readline.Interface | null = null;

  constructor(private readonly deps: AppServerConnectionDependencies) {}

  isConnected(): boolean {
    return this.proc !== null;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async connect(): Promise<void> {
    if (this.proc) {
      return;
    }
    if (this.deps.transport !== "stdio") {
      throw new Error("Only stdio transport is implemented right now.");
    }

    this.expectedExit = false;
    logger.info("codex.connect.spawn", {
      transport: this.deps.transport,
      command: this.deps.command,
      args: this.deps.args
    });
    const codexEnv = await this.deps.readEnvironment();
    this.proc = spawn(this.deps.command, this.deps.args, {
      env: { ...process.env, ...codexEnv },
      stdio: ["pipe", "pipe", "inherit"]
    });
    const proc = this.proc;
    if (!proc) {
      throw new Error("Failed to start Codex App Server process.");
    }

    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => {
      if (this.proc === proc) {
        void this.handleLine(line);
      }
    });
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) {
        return;
      }
      if (this.expectedExit) {
        logger.info("codex.process.exit.expected", { code, signal });
      } else {
        logger.error("codex.process.exit", { code, signal });
      }
      this.rejectPending(new Error(`Codex App Server exited (code=${code}, signal=${signal})`));
      this.initialized = false;
      this.proc = null;
      this.rl?.close();
      this.rl = null;
      this.deps.onDisconnected({ expected: this.expectedExit });
    });

    await this.initialize();
  }

  async close(reason: string): Promise<void> {
    if (!this.proc) {
      return;
    }

    this.expectedExit = true;
    this.rejectPending(new Error(reason));
    this.rl?.close();
    this.proc.kill("SIGTERM");
    this.proc = null;
    this.rl = null;
    this.initialized = false;
    this.deps.onDisconnected({ expected: true });
  }

  async request(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    const id = this.nextId++;
    logger.info("codex.rpc.request", { id, method });
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? 0;
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
            const pending = this.pending.get(id);
            if (!pending) {
              return;
            }
            this.pending.delete(id);
            logger.warn("codex.rpc.timeout", { id, method, timeoutMs });
            reject(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        method,
        resolve: (value) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          logger.info("codex.rpc.result", { id, method, summary: summarizeResult(value) });
          resolve(value);
        },
        reject: (error) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          reject(error);
        }
      });
    });
    try {
      await this.send({ method, id, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
    return promise;
  }

  async sendResponse(id: JsonRpcId, result: unknown): Promise<void> {
    await this.send({ id, result });
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const result = await this.request("initialize", {
      clientInfo: {
        name: "codex_bridge",
        title: "Codex Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: ["item/agentMessage/delta"]
      }
    });
    this.deps.onInitialized(result);
    await this.send({ method: "initialized", params: {} });
    this.initialized = true;
    logger.info("codex.initialize.completed");
  }

  private async send(message: unknown): Promise<void> {
    if (!this.proc?.stdin.writable) {
      throw new Error("Codex App Server stdin is not writable.");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    const message = JSON.parse(line) as JsonRpcSuccess | JsonRpcError | AppServerServerRequest | JsonRpcNotification;
    if ("result" in message && "id" in message) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.resolve(message.result);
      }
      return;
    }
    if ("error" in message && "id" in message) {
      logger.error("codex.rpc.error", {
        id: message.id,
        message: message.error.message,
        code: message.error.code
      });
      const pending = this.pending.get(message.id ?? -1);
      if (pending) {
        this.pending.delete(message.id ?? -1);
        pending.reject(new AppServerRpcError(pending.method, message.error));
      }
      return;
    }
    if ("id" in message && "method" in message) {
      this.deps.onServerRequest(message);
      return;
    }
    this.deps.onNotification(message);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function summarizeResult(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (!record) {
    return Array.isArray(result) ? { type: "array", count: result.length } : { type: typeof result };
  }
  const data = Array.isArray(record.data) ? record.data : undefined;
  const conversations = Array.isArray(record.conversations) ? record.conversations : undefined;
  const items = Array.isArray(record.items) ? record.items : undefined;
  return {
    keys: Object.keys(record),
    dataCount: data?.length,
    conversationCount: conversations?.length,
    itemCount: items?.length,
    id: firstString(record.id, record.threadId, record.conversationId, record.messageId)
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}
