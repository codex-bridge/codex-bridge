import { createDeliveryTiming } from "../shared/delivery-timing.js";

export const { timeDelivery: timeTelegramDelivery, timeApi: timeTelegramApi, timeRetryWait: timeTelegramRetryWait } =
  createDeliveryTiming("telegram.delivery.timing", error => {
    const code = (error as { error_code?: unknown } | null)?.error_code;
    return typeof code === "number" ? String(code) : undefined;
  });
