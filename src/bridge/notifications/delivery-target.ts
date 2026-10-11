import type { BridgeStore } from "../../store/index.js";
import type { SessionRecord } from "../../shared/types.js";
import { WEB_SOURCE_ID } from "../../shared/source-address.js";

type DeliveryStore = Pick<BridgeStore, "getActiveSession" | "getSessionLease" | "getSessionBindingById">;

/** Web occupation is independent of navigation; chat transports retain selection semantics. */
export async function canDeliverSession(store: DeliveryStore, session: SessionRecord,
  sourceId = session.telegramChatId): Promise<boolean> {
  if (sourceId !== WEB_SOURCE_ID) return (await store.getActiveSession(sourceId))?.id === session.id;
  const lease = store.getSessionLease(session.id);
  if (!lease || (lease.state !== "active" && lease.state !== "handoff_pending") || !lease.ownerBindingId) return false;
  return store.getSessionBindingById(lease.ownerBindingId)?.sourceId === sourceId;
}

/** Keep the original delivery source after a terminal route is retired and ownership moves. */
export class NotificationDeliveryTargets {
  private readonly sources = new Map<string, { sessionId: string; sourceId: string }>();

  constructor(private readonly store: Pick<BridgeStore, "getActiveTurnRoute">,
    private readonly resolveSession: (threadId: string) => Promise<SessionRecord | null>) {}

  remember(session: SessionRecord): void {
    this.sources.set(session.codexThreadId, { sessionId: session.id, sourceId: session.telegramChatId });
    if (this.sources.size > 2048) this.sources.delete(this.sources.keys().next().value!);
  }

  async resolve(threadId: string): Promise<SessionRecord | null> {
    const route = this.store.getActiveTurnRoute(threadId);
    const session = await this.resolveSession(threadId);
    if (!session) return null;
    if (route?.sessionId === session.id) this.remember({ ...session, telegramChatId: route.sourceId });
    const original = this.sources.get(threadId);
    return original?.sessionId === session.id ? { ...session, telegramChatId: original.sourceId } : session;
  }
}
