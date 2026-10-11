import { logger } from "../../logging/logger.js";
import { BridgeStore } from "../../store/index.js";
import type { SessionTranscript } from "../contracts.js";
import type { SessionReader } from "./reader.js";
import type { SessionOwnershipService } from "./ownership.js";

export type SessionViewDependencies = {
  store: BridgeStore;
  sessionReader: Pick<SessionReader, "readSessionTranscript" | "reconcileExternalSessionLease">;
  sessionOwnershipService: Pick<SessionOwnershipService, "reconcileIdleBridgeLease">;
};

export class SessionViewService {
  constructor(private readonly deps: SessionViewDependencies) {}

  async refreshSessionView(
    telegramChatId: string,
    sessionId: string,
    expectedLeaseVersion?: number
  ): Promise<SessionTranscript> {
    const startedAt = Date.now();
    const current = await this.deps.store.getSessionById(sessionId);
    if (!current) throw new Error(`Unknown session: ${sessionId}`);
    const currentLease = this.deps.store.getSessionLease(sessionId);
    logger.info("bridge.session.refresh_started", {
      chatId: telegramChatId,
      sessionId,
      threadId: current.codexThreadId,
      expectedLeaseVersion: expectedLeaseVersion ?? null,
      leaseState: currentLease?.state ?? "unbound",
      leaseVersion: currentLease?.version ?? null
    });
    if (expectedLeaseVersion !== undefined && currentLease?.version !== expectedLeaseVersion) {
      logger.info("bridge.session.refresh_data_ready", {
        chatId: telegramChatId,
        sessionId,
        threadId: current.codexThreadId,
        outcome: "stale",
        leaseState: currentLease?.state ?? "unbound",
        leaseVersion: currentLease?.version ?? null,
        elapsedMs: Date.now() - startedAt
      });
      return {
        session: current,
        recentMessages: await this.deps.store.listRecentMessages(current.id, 5),
      };
    }
    const externalRecovered = await this.deps.sessionReader.reconcileExternalSessionLease(current);
    await this.deps.sessionOwnershipService.reconcileIdleBridgeLease(current);
    let lease = this.deps.store.getSessionLease(sessionId);
    if (externalRecovered) {
      this.deps.store.claimSession(sessionId, telegramChatId);
      lease = this.deps.store.getSessionLease(sessionId);
    }
    const viewed = await this.deps.sessionReader.readSessionTranscript(current);
    const binding = this.deps.store.getSessionBinding(sessionId, telegramChatId);
    const owner = lease?.ownerBindingId ? this.deps.store.getSessionBindingById(lease.ownerBindingId) : null;
    const isOwner = Boolean(binding && owner && binding.id === owner.id);
    if (lease?.state === "external_unknown") {
      logger.info("bridge.session.refresh_data_ready", {
        chatId: telegramChatId,
        sessionId,
        threadId: current.codexThreadId,
        outcome: "external_locked",
        externalRecovered,
        leaseState: lease.state,
        leaseVersion: lease.version,
        historyCount: viewed.recentMessages.length,
        elapsedMs: Date.now() - startedAt
      });
      return viewed;
    }
    logger.info("bridge.session.refresh_data_ready", {
      chatId: telegramChatId,
      sessionId,
      threadId: current.codexThreadId,
      outcome: isOwner ? "owner" : lease?.state === "unbound" ? "available" : "read_only",
      externalRecovered,
      leaseState: lease?.state ?? "unbound",
      leaseVersion: lease?.version ?? null,
      historyCount: viewed.recentMessages.length,
      elapsedMs: Date.now() - startedAt
    });
    return viewed;
  }
}
