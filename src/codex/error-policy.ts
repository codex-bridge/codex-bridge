import { AppServerRpcError } from "./app-server-connection.js";
import { logger } from "../logging/logger.js";

type RecoveryClass = "missing_thread" | "stale_turn" | "active_writer";

const RPC_METHODS: Record<RecoveryClass, ReadonlySet<string>> = {
  missing_thread: new Set(["thread/read", "thread/resume", "turn/start", "turn/steer", "thread/compact/start"]),
  stale_turn: new Set(["turn/steer"]),
  active_writer: new Set(["thread/resume", "turn/start", "turn/steer"])
};

// COMPATIBILITY: Codex has not exposed a verified semantic code/data discriminator for these errors.
// Match only known message shapes; RPC method scope prevents unrelated failures from changing session state.
const MISSING_THREAD = /^(?:(?:404[: ]+)?thread not found|no rollout found for thread id|unknown thread|thread does not exist|thread is missing|missing thread)(?:[: ]+[\w.-]+)?[.!]?$/i;
const STALE_TURN = /^(?:expectedturnid(?: is)? stale|expected turn(?: id)?(?: is)? stale|active turn(?: [\w.-]+)? (?:not found|already completed)|turn not found|turn already completed|no active turn)[.!]?$/i;
const ACTIVE_WRITER = /^(?:thread(?: [\w.-]+)? )?already has an active writer[.!]?$/i;

function matchesRecoveryError(error: unknown, classification: RecoveryClass, pattern: RegExp): boolean {
  if (error instanceof AppServerRpcError && !RPC_METHODS[classification].has(error.method)) return false;
  const message = (error instanceof Error ? error.message : String(error)).trim().replace(/\s+/g, " ");
  if (!pattern.test(message)) return false;
  logger.info("codex.error_policy.compatibility_match", {
    classification,
    method: error instanceof AppServerRpcError ? error.method : null,
    code: error instanceof AppServerRpcError ? error.code : null
  });
  return true;
}

export function isMissingRuntimeThreadError(error: unknown): boolean {
  return matchesRecoveryError(error, "missing_thread", MISSING_THREAD);
}

export function isStaleActiveTurnError(error: unknown): boolean {
  return matchesRecoveryError(error, "stale_turn", STALE_TURN);
}

export function isActiveWriterConflictError(error: unknown): boolean {
  return matchesRecoveryError(error, "active_writer", ACTIVE_WRITER);
}

export function isIncompatibleHistoryError(message: string): boolean {
  // COMPATIBILITY: the notification carries prose but no verified semantic error discriminator.
  const matched = /\baction\.type\b[\s\S]{0,256}\bSupported values are: 'search', 'open_page', and 'find_in_page'(?:[.!]|$)/.test(message);
  if (matched) logger.info("codex.error_policy.compatibility_match", { classification: "incompatible_history" });
  return matched;
}

export function extractRetryAfterSeconds(message: string): number {
  const match = message.match(/retry after (\d+)/i);
  if (!match) return 0;
  const seconds = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(seconds) ? seconds : 0;
}
