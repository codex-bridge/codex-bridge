import type { AppServerNotification } from "../../codex/client.js";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v && typeof v === "object" ? v as RecordValue : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const terminal = (status: string): boolean => ["completed", "failed", "interrupted", "errored", "cancelled"].includes(status);

export interface SubagentRoute {
  sessionId: string;
  parentThreadId: string;
  parentTurnId: string;
  childThreadId: string;
  name: string;
  turnId: string;
  status: string;
  incomplete?: boolean;
}
export interface SubagentDelivery { route: SubagentRoute; event: AppServerNotification; summary?: string }

// Track only observed direct children. Never infer ownership from directory or active chat.
export class SubagentTracker {
  private parents = new Map<string, { sessionId: string; threadId: string; turnId: string }>();
  private children = new Map<string, SubagentRoute>();
  private executions = new Map<string, SubagentRoute>();
  private seen = new Set<string>();
  private early: { event: AppServerNotification; at: number; bytes: number }[] = [];
  private incomplete = new Set<string>();
  private relations = new Set<string>();
  private retired = new Set<string>();
  private coverageGaps = new Set<string>();

  private markCoverageGap(route: SubagentRoute): void {
    this.coverageGaps.add(`${route.parentThreadId}:${route.parentTurnId}`);
    if (this.coverageGaps.size > 256) this.coverageGaps.delete(this.coverageGaps.values().next().value!);
  }

  private capacityNotice(route: SubagentRoute): SubagentDelivery {
    this.markCoverageGap(route);
    return { route, event: { method: "bridge/subagent/gap", params: {
      message: "Subagent monitoring capacity reached. Some activity is not being forwarded."
    } }, summary: this.summary(route) };
  }

  route(threadId: string, turnId?: string | null): SubagentRoute | undefined {
    const binding = this.children.get(threadId);
    return turnId ? this.executions.get(`${threadId}:${turnId}`)
      ?? (binding && !binding.turnId ? binding : undefined) : binding;
  }

  hasRunningChildren(sessionId: string): boolean {
    return [...this.executions.values()].some((run) => run.sessionId === sessionId && run.status === "running");
  }

  hasObservedParent(threadId: string, turnId: string): boolean {
    return this.parents.has(`${threadId}:${turnId}`);
  }

  reset(): SubagentRoute[] {
    const routes = [...this.children.values()];
    this.parents.clear(); this.children.clear(); this.executions.clear();
    this.seen.clear(); this.early = []; this.incomplete.clear(); this.relations.clear();
    this.retired.clear(); this.coverageGaps.clear();
    return routes;
  }

  summary(route: SubagentRoute): string {
    return this.summaryForParent(route.parentThreadId, route.parentTurnId);
  }

  summaryForParent(parentThreadId: string, parentTurnId: string): string {
    const runs = [...this.executions.values()].filter((run) =>
      run.parentThreadId === parentThreadId && run.parentTurnId === parentTurnId
    );
    const counts = new Map<string, number>();
    for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
    const incomplete = this.coverageGaps.has(`${parentThreadId}:${parentTurnId}`) || runs.some((run) => run.incomplete);
    return `Observed subagent turns: ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ") || "pending"}.${incomplete ? " Coverage is incomplete." : ""}`;
  }

  observe(event: AppServerNotification, sessionId?: string, now = Date.now()): {
    handled: boolean; deliveries: SubagentDelivery[];
  } {
    const p = record(event.params); const item = record(p.item);
    const threadId = str(p.threadId); const turn = record(p.turn);
    const turnId = str(p.turnId) || str(turn.id);
    for (const pending of this.early.filter((e) => now - e.at > 10_000)) {
      this.incomplete.add(str(record(pending.event.params).threadId));
    }
    this.early = this.early.filter((e) => now - e.at <= 10_000);
    if (this.incomplete.size > 256) this.incomplete.delete(this.incomplete.values().next().value!);
    if (sessionId && event.method === "turn/started" && !this.children.has(threadId)) {
      this.parents.set(`${threadId}:${turnId}`, { sessionId, threadId, turnId });
      if (this.parents.size > 256) this.parents.delete(this.parents.keys().next().value!);
    }
    const parent = this.parents.get(`${threadId}:${turnId}`);
    const deliveries: SubagentDelivery[] = [];
    if (item.type === "subAgentActivity" || item.type === "collabAgentToolCall") {
      // Child delegation is not recursively followed by this first release.
      if (!parent) {
        const owner = this.children.get(threadId);
        const noticeKey = `nested:${threadId}:${turnId}`;
        const delegates = item.kind === "started" || item.tool === "spawnAgent";
        if (owner && delegates && str(item.agentThreadId) !== owner.parentThreadId && !this.seen.has(noticeKey)) {
          this.seen.add(noticeKey);
          deliveries.push({ route: { ...owner }, event: { method: "bridge/subagent/gap", params: {
            message: "Nested subagent activity detected. This bridge forwards direct children only."
          } } });
        }
        return { handled: Boolean(owner), deliveries };
      }
      const ids = item.type === "subAgentActivity" ? [str(item.agentThreadId)]
        : item.tool === "spawnAgent" || item.tool === "sendInput" || item.tool === "resumeAgent"
          ? (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id): id is string => typeof id === "string") : []) : [];
      for (const id of ids.filter((id) => Boolean(id) && id !== threadId)) {
        const existing = this.children.get(id);
        const starts = item.kind === "started" || item.tool === "spawnAgent" || item.tool === "sendInput" || item.tool === "resumeAgent";
        if (!starts) continue;
        const relationKey = `${threadId}:${turnId}:${str(item.id)}:${id}`;
        if (this.relations.has(relationKey)) continue;
        this.relations.add(relationKey);
        if (this.relations.size > 4096) this.relations.delete(this.relations.values().next().value!);
        const route: SubagentRoute = { sessionId: parent.sessionId, parentThreadId: threadId,
          parentTurnId: turnId, childThreadId: id, name: str(item.agentPath).split("/").pop() || `agent-${id.slice(-6)}`,
          turnId: "", status: "pending" };
        if (this.children.size >= 128 && !existing) {
          const reusable = [...this.children].find(([, candidate]) => {
            const execution = this.executions.get(`${candidate.childThreadId}:${candidate.turnId}`);
            return execution && terminal(execution.status);
          });
          if (reusable) this.children.delete(reusable[0]);
          else {
            const noticeKey = `capacity:${threadId}:${turnId}`;
            if (!this.seen.has(noticeKey)) {
              this.seen.add(noticeKey);
              deliveries.push(this.capacityNotice(route));
            }
            continue;
          }
        }
        this.children.set(id, route);
        for (const early of this.early.filter((e) => str(record(e.event.params).threadId) === id)) {
          deliveries.push(...this.accept(route, early.event));
        }
        this.early = this.early.filter((e) => str(record(e.event.params).threadId) !== id);
      }
      return { handled: true, deliveries };
    }
    const route = this.children.get(threadId);
    const awaitingAssociation = route && turnId && route.turnId && route.turnId !== turnId
      && !this.executions.has(`${threadId}:${turnId}`);
    if (route && !awaitingAssociation) return { handled: true, deliveries: this.accept(route, event) };
    if ((!sessionId || awaitingAssociation) && threadId && /^(item\/completed|turn\/started|turn\/completed|error)$/.test(event.method)) {
      const bytes = JSON.stringify(event).length * 2;
      if (bytes <= 64_000) this.early.push({ event, at: now, bytes });
      else this.incomplete.add(threadId);
      while (this.early.length > 128 || this.early.reduce((n, e) => n + e.bytes, 0) > 256_000) {
        this.incomplete.add(str(record(this.early.shift()!.event.params).threadId));
      }
      return { handled: true, deliveries };
    }
    return { handled: false, deliveries };
  }

  private accept(binding: SubagentRoute, event: AppServerNotification): SubagentDelivery[] {
    const p = record(event.params); const t = record(p.turn); const item = record(p.item);
    const turnId = str(p.turnId) || str(t.id);
    if (!turnId) {
      return event.method === "error" ? [{ route: { ...binding }, event }] : [];
    }
    const key = `${binding.childThreadId}:${turnId}`;
    if (this.retired.has(key)) return [];
    let run = this.executions.get(key);
    if (!run) {
      if (!/^(turn\/started|turn\/completed|item\/completed|error)$/.test(event.method)) return [];
      if (this.executions.size >= 256) {
        const reusable = [...this.executions].find(([, candidate]) => terminal(candidate.status));
        if (!reusable) return [this.capacityNotice({ ...binding, turnId, status: "unknown" })];
        this.executions.delete(reusable[0]);
        this.markCoverageGap(reusable[1]);
        this.retired.add(reusable[0]);
        if (this.retired.size > 4096) this.retired.delete(this.retired.values().next().value!);
      }
      if (event.method !== "turn/started") this.incomplete.add(binding.childThreadId);
      run = { ...binding, turnId, status: event.method === "turn/started" ? "running" : "unknown" };
      binding.turnId = turnId;
      this.executions.set(key, run);
    }
    const eventKey = `${key}:${event.method}:${str(item.id)}:${event.method === "error" ? JSON.stringify(p.error) : ""}`;
    if (this.seen.has(eventKey)) return [];
    this.seen.add(eventKey);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    if (event.method === "turn/completed") {
      run.status = str(t.status) || "unknown";
    }
    if (event.method === "turn/started" && run.status === "unknown") run.status = "running";
    const output: SubagentDelivery[] = [];
    if (this.incomplete.delete(binding.childThreadId)) {
      run.incomplete = true;
      output.push({ route: { ...run }, event: {
      method: "bridge/subagent/gap", params: { message: "Some subagent events were not observed." }
      } });
    }
    if (/^(item\/completed|turn\/started|turn\/completed|error)$/.test(event.method)) output.push({ route: { ...run }, event, summary: this.summary(run) });
    return output;
  }
}
