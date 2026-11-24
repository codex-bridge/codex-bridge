import type { AppServerMcpStartupStatusEvent } from "../../codex/client.js";

export type McpStartupStatus = AppServerMcpStartupStatusEvent & { updatedAt: number; failureActive: boolean };
export function mcpStartupKey(event: Pick<AppServerMcpStartupStatusEvent, "threadId" | "name">): string {
  return JSON.stringify([event.threadId, event.name]);
}
export function isMcpReady(status: string | null): boolean {
  return ["ready", "running", "started", "connected"].includes(status?.toLowerCase() ?? "");
}
export function isMcpFailure(event: Pick<AppServerMcpStartupStatusEvent, "status" | "error"> & { failureReason?: string | null }): boolean {
  return !isMcpReady(event.status) && (!!event.error || !!event.failureReason ||
    ["failed", "error", "stopped", "disconnected", "authenticationrequired"].includes(event.status?.toLowerCase() ?? ""));
}

/** Connection observations are isolated by scope; a login receipt is not a ready connection. */
export class McpStartupTracker {
  private readonly statuses = new Map<string, McpStartupStatus>();

  remember(event: AppServerMcpStartupStatusEvent): { failed: boolean; recovered: boolean } {
    const key = mcpStartupKey(event), previous = this.statuses.get(key);
    if (event.source === "oauth" && event.status === "authenticated" && previous) return { failed: false, recovered: false };
    const failing = isMcpFailure(event), ready = event.source === "startup" && isMcpReady(event.status);
    const failureActive = failing || !!previous?.failureActive && !ready;
    this.statuses.set(key, { ...event,
      ...(failureActive && !failing && !ready ? {
        error: event.error ?? previous?.error ?? null, failureReason: event.failureReason ?? previous?.failureReason ?? null
      } : {}), updatedAt: Date.now(), failureActive });
    if (this.statuses.size > 2048) this.statuses.delete(this.statuses.keys().next().value!);
    return { failed: failing && !previous?.failureActive, recovered: ready && !!previous?.failureActive };
  }

  forThread(threadId: string): Map<string, McpStartupStatus> {
    const result = new Map<string, McpStartupStatus>();
    for (const state of this.statuses.values()) if (state.threadId === null) result.set(state.name, state);
    for (const state of this.statuses.values()) if (state.threadId === threadId) {
      // An intermediate local observation cannot clear a known global incident.
      if (result.get(state.name)?.failureActive && !state.failureActive && !(state.source === "startup" && isMcpReady(state.status))) continue;
      result.set(state.name, state);
    }
    return result;
  }

  unavailableForThread(threadId: string): string[] {
    return [...this.forThread(threadId).values()].filter(state => state.failureActive)
      .map(state => state.name).sort((a, b) => a.localeCompare(b));
  }

  summaryForThread(threadId: string): string | null {
    const names = this.unavailableForThread(threadId);
    if (!names.length) return null;
    const text = `MCP unavailable ×${names.length} · ${names.join(", ")}`;
    const characters = Array.from(text);
    return characters.length <= 800 ? text : `${characters.slice(0, 799).join("")}…`;
  }

  clear(): void { this.statuses.clear(); }
}
