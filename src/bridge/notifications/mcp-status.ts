import type { SessionRecord } from "../../shared/types.js";
import { logger } from "../../logging/logger.js";
import { createActivityMessage } from "../messages/factory.js";
import type { BridgeMessageOperations } from "../messages/operations.js";
import { formatMcpUnavailableSummary } from "../status/mcp-startup.js";

/** One low-emphasis snapshot per changed session state, immediately before Actions. */
export class McpStatusNotifier {
  private readonly attempted = new Map<string, string>();
  private readonly delivering = new Map<string, object>();
  private generation = 0;

  constructor(private readonly deps: {
    getUnavailable: (threadId: string) => string[];
    getSessionDirectory: (session: SessionRecord) => string;
    sendMessageSpec: BridgeMessageOperations["sendMessageSpec"];
  }) {}

  clear(): void { this.generation++; this.attempted.clear(); this.delivering.clear(); }

  async deliverBeforeActions(session: SessionRecord, sourceId: string, canSend: () => Promise<boolean>,
    signal?: AbortSignal): Promise<boolean> {
    const thread = session.codexThreadId;
    const names = [...this.deps.getUnavailable(thread)];
    const fingerprint = JSON.stringify(names);
    const previous = this.attempted.get(thread);
    if (this.delivering.has(thread) || fingerprint === previous || previous === undefined && !names.length) return false;
    const generation = this.generation, token = {};
    this.delivering.set(thread, token);
    const eligible = async () => {
      if (signal?.aborted || generation !== this.generation || !await canSend()) return false;
      return !signal?.aborted && generation === this.generation && fingerprint === JSON.stringify(this.deps.getUnavailable(thread));
    };
    const authorize = async () => {
      if (!await eligible()) return false;
      // Reserve only at the delivery boundary. An ambiguous network outcome is
      // not replayed; changes to the full list still get a new attempt.
      this.rememberAttempt(thread, fingerprint);
      return true;
    };
    try {
      if (!await eligible()) return false;
      const sent = await this.deps.sendMessageSpec(sourceId, createActivityMessage({
        kind: "system", titleLabel: "MCP status",
        session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
        body: [{ type: "text", text: formatMcpUnavailableSummary(names) }]
      }), { disable_notification: true, canSend: authorize, deliverySignal: signal });
      if (sent && generation === this.generation) this.rememberAttempt(thread, fingerprint);
      return sent !== null;
    } catch (error) {
      if (!signal?.aborted) logger.warn("bridge.mcp_status.delivery_failed", {
        sessionId: session.id, error: error instanceof Error ? error.message : String(error)
      });
      return false;
    } finally {
      if (this.delivering.get(thread) === token) this.delivering.delete(thread);
    }
  }

  private rememberAttempt(thread: string, fingerprint: string): void {
    this.attempted.set(thread, fingerprint);
    if (this.attempted.size > 2048) this.attempted.delete(this.attempted.keys().next().value!);
  }
}
