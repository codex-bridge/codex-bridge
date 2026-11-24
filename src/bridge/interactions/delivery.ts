import type { InteractionDelivery } from "./types.js";

/** Delivery wrappers serialize the write only; follow-up work runs outside their queue. */
export async function runInteractionDelivery(delivery: InteractionDelivery, write: () => Promise<boolean>): Promise<void> {
  let delivered = false;
  const operation = async () => { delivered = await write(); };
  if (delivery.aroundDelivery) await delivery.aroundDelivery(operation);
  else await operation();
  if (delivered) await delivery.afterDelivery?.();
}
