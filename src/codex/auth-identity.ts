import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getCodexAuthFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCodexHomePath(env), "auth.json");
}

export function getCodexHomePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function getCodexEnvFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCodexHomePath(env), ".env");
}

/**
 * Return only the stable login identity. Token refreshes must not cause an
 * app-server reconnect, so token fields are intentionally ignored.
 */
export function readCodexAuthIdentity(authFilePath: string): string | null {
  try {
    const raw = readFileSync(authFilePath, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }

    const record = data as Record<string, unknown>;
    const tokens = record.tokens;
    const tokenRecord = tokens && typeof tokens === "object" && !Array.isArray(tokens)
      ? tokens as Record<string, unknown>
      : null;
    const authMode = typeof record.auth_mode === "string" ? record.auth_mode : "";
    const accountId = typeof tokenRecord?.account_id === "string"
      ? tokenRecord.account_id
      : typeof record.account_id === "string"
        ? record.account_id
        : "";

    if (!authMode && !accountId) {
      return null;
    }
    return `${authMode}\t${accountId}`;
  } catch {
    return null;
  }
}
