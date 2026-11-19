import { createHash } from "node:crypto";
import type { AppServerWarningEvent } from "../../codex/notification-events.js";
import type { AppServerMcpStartupStatusEvent } from "../../codex/client.js";
import type { BridgeStore } from "../../store/index.js";
import type { SessionRecord } from "../../shared/types.js";
import { logger } from "../../logging/logger.js";
import { createMessage } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";
import { McpStartupTracker, mcpStartupKey, isMcpFailure } from "../status/mcp-startup.js";
import { SessionAccessService } from "../sessions/access.js";
import { canDeliverSession } from "./delivery-target.js";

const labels: Record<AppServerWarningEvent["kind"], string> = {
  warning: "Codex warning", guardianWarning: "Guardian warning", configWarning: "Configuration warning", deprecationNotice: "Deprecation notice"
};

/** Public notices only. Global snapshots are service state, never copies in every conversation. */
export class NotificationNoticeService {
  private readonly seenWarnings = new Set<string>();
  private readonly globalNotices = new Map<string, MessageSpec>();
  private readonly pendingNotices = new Map<string, MessageSpec>();
  private flushing = false;
  constructor(private readonly deps: {
    store: BridgeStore;
    mcpStartup: McpStartupTracker;
    resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
    getSessionDirectory: (session: SessionRecord) => string;
    sendLongSpec: (sourceId: string, spec: MessageSpec) => Promise<void>;
  }) {}

  snapshot(): MessageSpec[] { return structuredClone([...this.globalNotices.values()]); }
  clear(): void { this.seenWarnings.clear(); this.globalNotices.clear(); this.pendingNotices.clear(); }

  /** One conversation takes the pending batch; reading service state never consumes it. */
  async flushPending(session: SessionRecord, sourceId: string, assertRequestCurrent: () => void = () => {}): Promise<void> {
    if (this.flushing || !this.pendingNotices.size) return;
    let access;
    try {
      access = await new SessionAccessService(this.deps.store).requireOwned(session.codexThreadId, sourceId, undefined, assertRequestCurrent);
    } catch { return; }
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [key, spec] of [...this.pendingNotices]) {
        try { access.assertCurrent(); } catch { break; }
        // An MCP incident can resolve or change while earlier notices are being sent.
        if (this.pendingNotices.get(key) !== spec) continue;
        this.pendingNotices.delete(key);
        try {
          await this.deps.sendLongSpec(sourceId, createMessage({ kind: spec.kind, titleLabel: spec.title,
            session: { id: access.session.id, directory: this.deps.getSessionDirectory(access.session) },
            presentation: "activity", body: spec.body }));
        } catch {
          // The write may have reached the transport; do not retry an unknown outcome.
          logger.warn("bridge.notice.service_delivery_failed", { sourceId });
        }
      }
    } finally { this.flushing = false; }
  }

  async handleWarning(event: AppServerWarningEvent): Promise<void> {
    const key = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    if (this.seenWarnings.has(key)) return;
    this.seenWarnings.add(key);
    if (this.seenWarnings.size > 512) this.seenWarnings.delete(this.seenWarnings.values().next().value!);
    await this.deliver(event.threadId, key, labels[event.kind], [event.message, event.details, event.path ? `File: ${event.path}` : null]);
  }

  async handleMcpStartup(event: AppServerMcpStartupStatusEvent): Promise<void> {
    const transition = this.deps.mcpStartup.remember(event);
    const key = `mcp:${mcpStartupKey(event)}`;
    if (transition.recovered) {
      if (event.threadId === null) {
        this.globalNotices.delete(key);
        // Nothing was pushed about this incident, so there is nothing to announce as recovered.
        if (this.pendingNotices.delete(key)) return;
      }
      await this.deliver(event.threadId, key, "MCP recovered", [`${event.name} is ready.`], { active: false });
    } else if (isMcpFailure(event)) {
      await this.deliver(event.threadId, key, "MCP connection failed", [event.name,
        event.error ? `Error: ${event.error}` : null, event.failureReason ? `Reason: ${event.failureReason}` : null,
        event.failureReason === "reauthenticationRequired" ? "Sign in again with Codex to reconnect this MCP server." : null], { notify: transition.failed });
    }
  }

  private async deliver(threadId: string | null, key: string, title: string, lines: Array<string | null>, options: { notify?: boolean; active?: boolean } = {}): Promise<void> {
    const notify = options.notify ?? true;
    const body = lines.filter((line): line is string => !!line).map(text => ({ type: "text" as const, text }));
    if (threadId === null) {
      const spec = createMessage({ kind: "system", scope: "global", titleLabel: title, presentation: "activity", body });
      if (options.active !== false) this.globalNotices.set(key, spec);
      if (notify || this.pendingNotices.has(key)) this.pendingNotices.set(key, spec);
      if (this.globalNotices.size > 64) {
        const oldest = this.globalNotices.keys().next().value!;
        this.globalNotices.delete(oldest); this.pendingNotices.delete(oldest);
      }
      if (this.pendingNotices.size > 64) this.pendingNotices.delete(this.pendingNotices.keys().next().value!);
      return;
    }
    if (!notify) return;
    const session = await this.deps.resolveNotificationSession(threadId);
    if (!session || session.codexArchivedAt !== null || !await canDeliverSession(this.deps.store, session)) {
      logger.info("bridge.notice.unrouted", { threadId, title });
      return;
    }
    try { await new SessionAccessService(this.deps.store).requireOwned(session.codexThreadId, session.telegramChatId, undefined, () => {}); }
    catch { logger.info("bridge.notice.not_owned", { threadId }); return; }
    await this.deps.sendLongSpec(session.telegramChatId, createMessage({ kind: "system", titleLabel: title, presentation: "activity",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) }, body }));
  }
}
