import { createHash } from "node:crypto";
import type { AppServerWarningEvent } from "../../codex/notification-events.js";
import type { AppServerMcpStartupStatusEvent } from "../../codex/client.js";
import type { BridgeStore } from "../../store/index.js";
import type { SessionRecord } from "../../shared/types.js";
import { logger } from "../../logging/logger.js";
import { createMessage } from "../messages/factory.js";
import type { MessageBodyPart, MessageSpec } from "../messages/types.js";
import { messageBodyPartText } from "../messages/content.js";
import { McpStartupTracker } from "../status/mcp-startup.js";
import { SessionAccessService } from "../sessions/access.js";
import { canDeliverSession } from "./delivery-target.js";
import type { WorkflowAppend } from "../progress/workflow-sequence.js";

const labels: Record<AppServerWarningEvent["kind"], string> = {
  warning: "Codex warning", guardianWarning: "Guardian warning", configWarning: "Configuration warning", deprecationNotice: "Deprecation notice"
};

type NoticeIdentity = { type: "warning"; key: string; global: boolean };
type PendingNotice = { spec: MessageSpec; identity: NoticeIdentity };

function bodyKey(body: MessageBodyPart[]): string {
  return createHash("sha256").update(body.map(messageBodyPartText).join("\n")).digest("hex");
}

/** Public notices only. Global snapshots are service state, never copies in every conversation. */
export class NotificationNoticeService {
  private readonly globalWarnings = new Set<string>();
  private readonly seenWarnings = new Map<string, Set<string>>();
  private readonly globalNotices = new Map<string, MessageSpec>();
  private readonly pendingNotices = new Map<string, PendingNotice>();
  private flushing = false;
  constructor(private readonly deps: {
    appendWorkflowMessage: WorkflowAppend;
    store: BridgeStore;
    mcpStartup: McpStartupTracker;
    resolveNotificationSession: (threadId: string) => Promise<SessionRecord | null>;
    getSessionDirectory: (session: SessionRecord) => string;
    sendLongSpec: (sourceId: string, spec: MessageSpec) => Promise<void>;
  }) {}

  snapshot(): MessageSpec[] { return structuredClone([...this.globalNotices.values()]); }
  clear(): void {
    this.globalWarnings.clear(); this.seenWarnings.clear();
    this.globalNotices.clear(); this.pendingNotices.clear();
  }

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
      for (const [key, notice] of [...this.pendingNotices]) {
        try { access.assertCurrent(); } catch { break; }
        // An MCP incident can resolve or change while earlier notices are being sent.
        if (this.pendingNotices.get(key) !== notice) continue;
        this.pendingNotices.delete(key);
        try {
          await this.sendNotice(access.session, sourceId, notice);
        } catch {
          // The write may have reached the transport; do not retry an unknown outcome.
          logger.warn("bridge.notice.service_delivery_failed", { sourceId });
        }
      }
    } finally { this.flushing = false; }
  }

  async handleWarning(event: AppServerWarningEvent): Promise<void> {
    const lines = [event.message, event.details, event.path ? `File: ${event.path}` : null];
    // Display content is the identity across equivalent warning methods. Guardian warnings remain separate.
    const key = `${event.kind === "guardianWarning" ? "guardian" : "warning"}:${bodyKey(this.body(lines))}`;
    const global = event.threadId === null;
    if (global) {
      if (this.globalWarnings.has(key)) return;
      this.globalWarnings.add(key);
      if (this.globalWarnings.size > 512) this.globalWarnings.delete(this.globalWarnings.values().next().value!);
    }
    await this.deliver(event.threadId, key, labels[event.kind], lines,
      { identity: { type: "warning", key, global }, notify: !global || !this.seenWarnings.has(key) });
  }

  async handleMcpStartup(event: AppServerMcpStartupStatusEvent): Promise<void> {
    const transition = this.deps.mcpStartup.remember(event);
    logger.info("bridge.notice.mcp_observed", { threadId: event.threadId, name: event.name, status: event.status,
      source: event.source, failureReason: event.failureReason, newFailure: transition.failed, recovered: transition.recovered });
    // State is shown in Actions/status, never as a chronological notice.
  }

  private body(lines: Array<string | null>): MessageBodyPart[] {
    return lines.filter((line): line is string => !!line).map(text => ({ type: "text", text }));
  }

  private async sendNotice(session: SessionRecord, sourceId: string, notice: PendingNotice): Promise<void> {
    const { spec, identity } = notice;
    if (identity.type === "warning") {
      const seen = this.seenWarnings.get(identity.key) ?? new Set<string>();
      if (identity.global ? seen.size > 0 : this.globalWarnings.has(identity.key) || seen.has(session.id)) return;
      seen.add(session.id);
      if (seen.size > 512) seen.delete(seen.values().next().value!);
      this.seenWarnings.set(identity.key, seen);
      if (this.seenWarnings.size > 512) this.seenWarnings.delete(this.seenWarnings.keys().next().value!);
    }
    await this.deps.appendWorkflowMessage(session, () => this.deps.sendLongSpec(sourceId, createMessage({ kind: spec.kind, titleLabel: spec.title,
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      presentation: "activity", body: spec.body })), { sourceId });
  }

  private async deliver(threadId: string | null, key: string, title: string, lines: Array<string | null>, options: { identity: NoticeIdentity; notify?: boolean; active?: boolean }): Promise<void> {
    const notify = options.notify ?? true;
    const body = this.body(lines);
    if (threadId === null) {
      const spec = createMessage({ kind: "system", scope: "global", titleLabel: title, presentation: "activity", body });
      if (options.active !== false) this.globalNotices.set(key, spec);
      if (notify || this.pendingNotices.has(key)) this.pendingNotices.set(key, { spec, identity: options.identity });
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
    let access;
    try { access = await new SessionAccessService(this.deps.store).requireOwned(session.codexThreadId, session.telegramChatId, undefined, () => {}); }
    catch { logger.info("bridge.notice.not_owned", { threadId }); return; }
    access.assertCurrent();
    await this.sendNotice(access.session, session.telegramChatId,
      { spec: createMessage({ kind: "system", scope: "global", titleLabel: title, body }), identity: options.identity });
  }
}
