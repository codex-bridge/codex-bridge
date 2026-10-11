import { readFile, stat } from "node:fs/promises";

import { logger } from "../../logging/logger.js";

type RolloutMessage = {
  role: "user" | "assistant" | "system";
  text: string;
};

export class RolloutReader {
  async resolveSessionActivityAt(
    rolloutPath: string,
    fallbackTimestamp: number | null
  ): Promise<number> {
    try {
      const info = await stat(rolloutPath);
      if (Number.isFinite(info.mtimeMs) && info.mtimeMs > 0) {
        return info.mtimeMs;
      }
    } catch {
      logger.warn("bridge.session_activity.stat_failed", { rolloutPath });
    }

    return fallbackTimestamp ?? Date.now();
  }

  async readRecentMessages(rolloutPath: string): Promise<RolloutMessage[]> {
    try {
      const raw = await readFile(rolloutPath, "utf8");
      const messages = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { payload?: Record<string, unknown> })
        .map((entry): RolloutMessage | null => {
          const payload = entry.payload;
          if (!payload || typeof payload !== "object" || payload.type !== "message") {
            return null;
          }

          const role = payload.role;
          if (role !== "user" && role !== "assistant") {
            return null;
          }

          const content = Array.isArray(payload.content) ? payload.content : [];
          const text = content
            .map((item) => item && typeof item === "object" && "text" in item ? String(item.text ?? "") : "")
            .filter(Boolean)
            .join("\n")
            .trim();
          return text ? { role, text } : null;
        })
        .filter((item): item is RolloutMessage => Boolean(item));

      logger.info("bridge.session.rollout_history_read", {
        rolloutPath,
        messageCount: messages.length
      });
      return messages.slice(-5);
    } catch (error) {
      logger.warn("bridge.session.rollout_history_failed", {
        rolloutPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  async readDisplayPath(rolloutPath: string): Promise<string | null> {
    try {
      const raw = await readFile(rolloutPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;

        const entry = JSON.parse(line) as {
          type?: string;
          payload?: Record<string, unknown>;
        };
        const payload = entry.payload;
        if (!payload || typeof payload !== "object") continue;

        if (entry.type === "session_meta" || entry.type === "turn_context") {
          const cwd = payload.cwd;
          if (typeof cwd === "string" && cwd.trim()) return cwd;
        }
      }
    } catch {
      return null;
    }

    return null;
  }
}
