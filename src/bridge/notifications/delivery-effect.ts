import type { AppServerNotification } from "../../codex/client.js";
import type { ProgressDeliveryOptions } from "../progress/normalizer.js";

export type NotificationDeliveryOptions = ProgressDeliveryOptions & { canRefreshStatus?: () => boolean };

// Explicit metadata or panel-only updates handled without chronological output. Rate-limit
// observations are transparent; their producer declares a boundary if it warns.
const METADATA = new Set([
  "thread/tokenUsage/updated", "account/rateLimits/updated", "turn/diff/updated",
  "turn/moderationMetadata", "thread/readState/changed", "thread/status/changed",
  "thread/name/updated", "thread/settings/updated", "thread/section/changed", "thread/queue/changed",
  "mcpServer/startupStatus/updated", "mcpServer/oauthLogin/completed"
]);

export function isMetadataNotification(notification: AppServerNotification): boolean {
  return METADATA.has(notification.method);
}
