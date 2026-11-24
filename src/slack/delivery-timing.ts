import { createDeliveryTiming } from "../shared/delivery-timing.js";

export type SlackDeliveryOperation = "send" | "edit" | "delete" | "clear_actions";

function errorCode(error: unknown): string | undefined {
  const value = error as { code?: unknown; data?: { error?: unknown } } | null;
  const code = value?.data?.error ?? value?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(code) ? code : undefined;
}

export const { timeDelivery: timeSlackDelivery, timeApi: timeSlackApi, timeRetryWait: timeSlackRetryWait } =
  createDeliveryTiming("slack.delivery.timing", errorCode);
