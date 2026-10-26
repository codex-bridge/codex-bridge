import { buildTurnConfigParams, type CodexConfigSnapshot } from "./config-snapshot.js";
import { asRecord, firstString } from "./protocol-utils.js";
import { logger } from "../logging/logger.js";
import type { AppServerLoadedThreadsStatus, AppServerThreadStatus, CodexTurnInputPart } from "./client.js";

export type TurnApiDependencies = {
  connect: () => Promise<void>;
  getObservedThreadSettings: (threadId: string) => AppServerThreadStatus | undefined;
  readCodexConfigSnapshot: (cwd: string) => Promise<CodexConfigSnapshot>;
  readLoadedThreadsStatus: (threadId: string) => Promise<AppServerLoadedThreadsStatus | null>;
  resumeThread: (threadId: string, cwd: string, assertCurrent?: () => void, timeoutMs?: number) => Promise<unknown>;
  request: (method: "turn/start" | "turn/interrupt", params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
  requestKnownMethod: (method: "turn/steer", params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
  onTurnStartBeginning: () => void;
  onTurnStarted: (turnId: string) => void;
  onTurnStartFinished: () => void;
  updateObservedThreadSettingsAfterStart: (
    threadId: string,
    observed: AppServerThreadStatus | undefined,
    result: unknown
  ) => void;
};

export type SendTurnOptions = {
  inputParts?: CodexTurnInputPart[];
  configSnapshot?: CodexConfigSnapshot;
  assertCurrent?: () => void;
  timeoutMs?: number;
};

export class CodexTurnApi {
  constructor(private readonly deps: TurnApiDependencies) {}

  async sendTurn(
    threadId: string,
    text: string,
    cwd: string,
    options?: SendTurnOptions
  ): Promise<{ turnId: string | null }> {
    await this.deps.connect();
    logger.info("codex.turn.start", {
      threadId,
      cwd,
      inputPartCount: options?.inputParts?.length ?? 1,
      text
    });
    const snapshot = options?.configSnapshot ?? await this.deps.readCodexConfigSnapshot(cwd);
    // A newly started thread is already loaded but may have no rollout yet.
    // Only current runtime evidence can bypass resume; remembered settings cannot.
    options?.assertCurrent?.();
    const loaded = await this.deps.readLoadedThreadsStatus(threadId);
    options?.assertCurrent?.();
    if (loaded?.activeLoaded !== true) {
      await this.deps.resumeThread(threadId, cwd, options?.assertCurrent, options?.timeoutMs);
    }

    const input: CodexTurnInputPart[] = options?.inputParts?.length
      ? options.inputParts
      : [{ type: "text", text }];
    const params = {
      threadId,
      input,
      cwd,
      ...buildTurnConfigParams(snapshot)
    } satisfies Record<string, unknown>;
    logger.info("codex.turn.start.request", {
      threadId,
      inputPartCount: input.length,
      params: {
        ...params,
        input: input.map((part) => part.type === "text"
          ? { type: part.type, textLength: part.text.length }
          : { type: part.type, path: part.path })
      }
    });

    const observed = this.deps.getObservedThreadSettings(threadId);
    options?.assertCurrent?.();
    this.deps.onTurnStartBeginning();
    let result: Record<string, unknown> | null;
    try {
      result = asRecord(await this.deps.request("turn/start", params, { timeoutMs: options?.timeoutMs }));
      const startedTurnId = firstString(
        asRecord(result?.turn)?.id,
        result?.turnId,
        result?.messageId
      ) ?? null;
      if (startedTurnId) {
        this.deps.onTurnStarted(startedTurnId);
      }
    } finally {
      this.deps.onTurnStartFinished();
    }
    this.deps.updateObservedThreadSettingsAfterStart(threadId, observed, result);

    const turnId = firstString(
      asRecord(result?.turn)?.id,
      result?.turnId,
      result?.messageId
    ) ?? null;
    logger.info("codex.turn.started", { threadId, turnId });
    return { turnId };
  }

  async interruptThread(threadId: string, turnId?: string | null): Promise<void> {
    await this.deps.connect();
    logger.info("codex.thread.interrupt", { threadId, turnId: turnId ?? null });
    try {
      await this.deps.request(
        "turn/interrupt",
        turnId ? { threadId, turnId } : { threadId },
        { timeoutMs: 5_000 }
      );
      logger.info("codex.thread.interrupt.result", {
        threadId,
        method: "turn/interrupt",
        ok: true
      });
    } catch (error) {
      const resolved = error instanceof Error ? error : new Error(String(error));
      if (!turnId && resolved.message.includes("missing field `turnId`")) {
        logger.warn("codex.thread.interrupt.turn_id_required", { threadId });
      } else {
        logger.warn("codex.thread.interrupt.failed", {
          threadId,
          method: "turn/interrupt",
          error: resolved.message
        });
      }
      throw resolved;
    }
  }

  async steerTurn(threadId: string, turnId: string, text: string, inputParts?: CodexTurnInputPart[],
    assertCurrent?: () => void, timeoutMs?: number): Promise<{ turnId: string | null }> {
    await this.deps.connect();
    const input = inputParts?.length ? inputParts : [{ type: "text" as const, text }];
    logger.info("codex.turn.steer", { threadId, turnId, inputPartCount: input.length, text });
    const params = {
      threadId,
      expectedTurnId: turnId,
      input
    } satisfies Record<string, unknown>;
    logger.info("codex.turn.steer.request", {
      threadId,
      turnId,
      input: input.map((part) => part.type === "text"
        ? { type: part.type, textLength: part.text.length }
        : { type: part.type, path: part.path })
    });
    assertCurrent?.();
    const result = asRecord(await this.deps.requestKnownMethod("turn/steer", params, { timeoutMs }));
    const steeredTurnId = firstString(result?.turnId, asRecord(result?.turn)?.id) ?? turnId;
    logger.info("codex.turn.steered", { threadId, turnId: steeredTurnId });
    return { turnId: steeredTurnId };
  }
}
