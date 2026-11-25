import type { InteractionDelivery } from "./types.js";

/** Wrappers may own the write; follow-up work runs only for caller-confirmed writes. */
export async function runInteractionDelivery(delivery: InteractionDelivery, write: () => Promise<boolean>): Promise<void> {
  let delivered = false;
  const operation = async () => { delivered = await write(); };
  if (delivery.aroundDelivery) await delivery.aroundDelivery(operation);
  else await operation();
  if (delivered) await delivery.afterDelivery?.();
}
