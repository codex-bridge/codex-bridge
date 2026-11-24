import { TelegramDeliveryBudget } from "../../src/telegram/delivery-budget.js";

/** Keep transport/input tests focused on their contracts. Budget timing has its
 * own tests using real limits and a controlled clock. No production env switch.
 */
export function unlimitedTelegramBudget(): TelegramDeliveryBudget {
  return new TelegramDeliveryBudget(undefined, {
    botPerSecond: Infinity, groupPerMinute: Infinity, chatIntervalMs: 0, backgroundIntervalMs: 0
  });
}
