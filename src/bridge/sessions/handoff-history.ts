import type { BridgeStore } from "../../store/index.js";
import type { SessionBindingEvent } from "./binding.js";
import type { SessionReader } from "./reader.js";
import type { SessionRecord } from "../../shared/types.js";
import { logger } from "../../logging/logger.js";

type Acquisition = { event: SessionBindingEvent; consumed: boolean };

/** One history delivery per chat acquisition, never a history subscription. */
export class SessionHandoffHistoryService {
  private readonly acquisitions = new Map<string, Acquisition>();

  constructor(private readonly deps: {
    store: BridgeStore;
    reader: Pick<SessionReader, "readSessionTranscript">;
    deliver: (sourceId: string, session: SessionRecord,
      messages: Awaited<ReturnType<SessionReader["readSessionTranscript"]>>["recentMessages"],
      canSend: () => Promise<boolean>) => Promise<void>;
  }) {}

  observe(event: SessionBindingEvent): void {
    if (event.kind !== "acquired") return;
    // Web retrieves its own conversation after binding through HTTP/SSE.
    if (event.sourceId.startsWith("web:")) {
      this.acquisitions.delete(event.sessionId);
      return;
    }
    this.acquisitions.set(event.sessionId, { event, consumed: false });
  }

  async canDeliver(event: SessionBindingEvent): Promise<boolean> {
    if (this.acquisitions.get(event.sessionId)?.event !== event) return false;
    const selected = await this.deps.store.getActiveSession(event.sourceId);
    const lease = this.deps.store.getSessionLease(event.sessionId);
    const binding = this.deps.store.getSessionBinding(event.sessionId, event.sourceId);
    return this.acquisitions.get(event.sessionId)?.event === event &&
      this.deps.store.getSelectedSessionId(event.sourceId) === event.sessionId && selected?.id === event.sessionId &&
      selected.codexArchivedAt === null && Boolean(binding && lease?.ownerBindingId === binding.id &&
        (lease.state === "active" || lease.state === "handoff_pending"));
  }

  async post(sourceId: string, sessionId: string): Promise<void> {
    const acquisition = this.acquisitions.get(sessionId);
    if (!acquisition || acquisition.consumed || acquisition.event.sourceId !== sourceId) return;
    acquisition.consumed = true; // Reserve before I/O; repeated clicks cannot replay history.
    const canSend = () => this.canDeliver(acquisition.event);
    try {
      if (!await canSend()) return;
      const session = await this.deps.store.getSessionById(sessionId);
      if (!session || !await canSend()) return;
      const transcript = await this.deps.reader.readSessionTranscript(session);
      if (!await canSend()) return;
      await this.deps.deliver(sourceId, transcript.session, transcript.recentMessages, canSend);
    } catch (error) {
      // An uncertain send outcome must not trigger an automatic history replay.
      logger.warn("bridge.session.handoff_history_failed", { sessionId, sourceId,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
}
