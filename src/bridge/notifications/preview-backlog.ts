import type { AppServerNotification } from "../../codex/client.js";
import { extractProgressEvent } from "../../codex/notification-events.js";
import { normalizeProgressEvent, type NewProgressPhaseKind, type ProgressDeliveryOptions } from "../progress/normalizer.js";

type PendingPreview = {
  turnId: string;
  kind: NewProgressPhaseKind;
  delivery: ProgressDeliveryOptions;
};

/** Marks replaceable previews, never removes notifications from the FIFO queue. */
export class NotificationPreviewBacklog {
  private readonly pending = new Map<string, PendingPreview>();

  track(key: string, notification: AppServerNotification): () => ProgressDeliveryOptions {
    const event = extractProgressEvent(notification);
    const normalized = event && normalizeProgressEvent(event);
    // Unknown notifications (including stateful reasoning deltas) are conservative
    // barriers. Only explicit protocol turn identities can share a pending group.
    if (!event?.turnId || !normalized || event.failed) {
      this.boundary(key);
      return () => ({});
    }
    const previous = this.pending.get(key);
    if (previous?.turnId === event.turnId && previous.kind === normalized.kind) {
      previous.delivery.suppressPreview = true;
    }
    const current: PendingPreview = { turnId: event.turnId, kind: normalized.kind, delivery: {} };
    this.pending.set(key, current);
    return () => {
      // A running operation cannot be superseded by later arrivals. Only queued
      // previews can be skipped; transport writes already in progress finish.
      if (this.pending.get(key) === current) this.pending.delete(key);
      return current.delivery;
    };
  }

  boundary(key: string): void {
    if (key === "global") this.reset();
    else this.pending.delete(key);
  }

  reset(): void { this.pending.clear(); }
}
