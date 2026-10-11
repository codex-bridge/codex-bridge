import type { SessionBindingRecord } from "./types.js";

// All windows use one stable Web source. Window credentials are not session bindings.
export const WEB_SOURCE_ID = "web:local";

export type SourceAddress = Pick<SessionBindingRecord, "platform" | "botKey" | "channelId" | "threadId">;

/** Delivery uses concrete adapter addresses; legacy binding aliases are not routable. */
export function messageTransportPlatform(sourceId: string): SourceAddress["platform"] | null {
  if (/\s/.test(sourceId)) return null;
  if (sourceId === WEB_SOURCE_ID) return "web";
  if (/^-?\d+$/.test(sourceId)) return "telegram";
  const slack = /^slack:([^:]+):([^:]+)(?::(.+))?$/.exec(sourceId);
  if (!slack) return null;
  try {
    if (slack[3]) decodeURIComponent(slack[3]);
    return "slack";
  } catch { return null; }
}

export function parseSourceAddress(sourceId: string): SourceAddress {
  if (sourceId.startsWith("web:")) {
    if (!/^web:[A-Za-z0-9_-]+$/.test(sourceId)) {
      throw new Error("Invalid Web source address.");
    }
    return { platform: "web", botKey: "web", channelId: null, threadId: null };
  }

  const slack = /^slack:([^:]+):([^:]+)(?::(.+))?$/.exec(sourceId);
  if (slack) {
    return { platform: "slack", botKey: "slack", channelId: slack[2]!, threadId: slack[3] ?? null };
  }

  // Preserve legacy Telegram source IDs, including numeric chat IDs and test fixtures.
  return { platform: "telegram", botKey: "telegram", channelId: null, threadId: null };
}
