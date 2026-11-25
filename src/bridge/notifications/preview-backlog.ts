import type { AppServerNotification } from "../../codex/client.js";
import { extractProgressEvent, extractStatusUpdate, extractTurnLifecycleEvent } from "../../codex/notification-events.js";
import { normalizeProgressEvent, type NewProgressPhaseKind } from "../progress/normalizer.js";
import { isMetadataNotification, type NotificationDeliveryOptions } from "./delivery-effect.js";

type PendingPreview = {
  turnId: string;
  kind: NewProgressPhaseKind;
  delivery: NotificationDeliveryOptions;
};

/** Marks replaceable previews, never removes notifications from the FIFO queue. */
export class NotificationPreviewBacklog {
  private readonly pending = new Map<string, PendingPreview>();
  private readonly statuses = new Map<string, object>();
  private readonly turns = new Map<string, { id: string; completed: boolean }>();
  private generation = 0;

  track(key: string, notification: AppServerNotification): () => NotificationDeliveryOptions {
    const delivery: NotificationDeliveryOptions = {};
    if (isMetadataNotification(notification)) return () => delivery;
    const lifecycle = extractTurnLifecycleEvent(notification);
    if (lifecycle?.kind === "started") this.turns.set(key, { id: lifecycle.turnId, completed: false });
    const status = extractStatusUpdate(notification);
    const event = extractProgressEvent(notification);
    const turnId = lifecycle?.turnId ?? event?.turnId ?? (notification.params as { turnId?: string } | undefined)?.turnId;
    const currentTurn = this.turns.get(key);
    const stale = currentTurn && (currentTurn.completed || turnId && turnId !== currentTurn.id);
    if (status?.kind === "running") {
      if (stale) delivery.canRefreshStatus = () => false;
      else if (status.activity === "contextCompaction") {
        // Compact is a chronological boundary, not a replaceable Working preview.
        // Validate its turn at arrival; later queued events must not erase it.
        this.statuses.delete(key);
        const generation = this.generation;
        delivery.canRefreshStatus = () => this.generation === generation;
      } else {
        const token = {};
        this.statuses.set(key, token);
        delivery.canRefreshStatus = () => this.statuses.get(key) === token;
      }
    } else if (status?.kind === "clear" && (!currentTurn || turnId === currentTurn.id)) {
      this.statuses.delete(key);
      if (turnId) this.turns.set(key, { id: turnId, completed: true });
    }
    const normalized = event && normalizeProgressEvent(event);
    // Unknown notifications (including stateful reasoning deltas) remain barriers.
    // Metadata does not change the visible sequence or supersede a status panel.
    if (!event?.turnId || !normalized || event.failed) {
      if (status) this.pending.delete(key);
      else this.boundary(key);
      return () => delivery;
    }
    const previous = this.pending.get(key);
    if (previous?.turnId === event.turnId && previous.kind === normalized.kind) {
      previous.delivery.suppressPreview = true;
    }
    const current: PendingPreview = { turnId: event.turnId, kind: normalized.kind, delivery };
    this.pending.set(key, current);
    return () => {
      // A running operation cannot be superseded by later arrivals. Only queued
      // previews can be skipped; transport writes already in progress finish.
      if (this.pending.get(key) === current) this.pending.delete(key);
      return current.delivery;
    };
  }

  boundary(key: string): void {
    if (key === "global") { this.pending.clear(); this.statuses.clear(); }
    else { this.pending.delete(key); this.statuses.delete(key); }
  }

  reset(): void { this.generation++; this.pending.clear(); this.statuses.clear(); this.turns.clear(); }
}
