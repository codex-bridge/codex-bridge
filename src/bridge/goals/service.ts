import type { CodexAppServerClient } from "../../codex/client.js";
import type { AppServerThreadGoal, AppServerThreadGoalStatus } from "../../codex/client.js";
import { formatSessionMarker } from "../../shared/session-tag.js";
import type { SessionRecord } from "../../shared/types.js";
import type { BridgeStore } from "../../store/index.js";
import { currentGoalAction, goalsAction, helpAction, messageAction, sessionAction } from "../messages/actions.js";
import { createMessage, messageContextForSession } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";

export type GoalReadResult = {
  goal: AppServerThreadGoal | null;
  error: string | null;
};

type GoalStore = Pick<BridgeStore, "getActiveSession" | "getSessionById" | "listKnownSessions">;
type GoalClient = Pick<CodexAppServerClient, "clearThreadGoal" | "readThreadGoal" | "updateThreadGoal">;

export type GoalServiceDependencies = {
  store: GoalStore;
  codexClient: GoalClient;
  sessionsPageSize: number;
  getSessionSelectorChatId: (chatId: string) => string;
  getSessionDirectory: (session: SessionRecord) => string;
  getSessionTitle: (session: SessionRecord) => string;
  readSessionGoal: (session: SessionRecord) => Promise<GoalReadResult>;
  formatGoalStatus: (status: AppServerThreadGoalStatus) => string;
  formatGoalStatusLines: (result: GoalReadResult) => string[];
  formatShortError: (message: string) => string;
};

export class GoalService {
  constructor(private readonly deps: GoalServiceDependencies) {}

  async renderActiveGoal(telegramChatId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(telegramChatId);
    if (!session) {
      return this.createGoalSpec("error", "No active session.", [sessionAction(), helpAction()], null);
    }
    return this.renderGoalForSession(telegramChatId, session);
  }

  async renderSelectedGoal(telegramChatId: string, sessionId: string): Promise<MessageSpec> {
    const session = await this.resolveGoalSession(telegramChatId, sessionId);
    if (!session) {
      return this.createGoalSpec("error", "Goal session is unavailable.", [goalsAction(), helpAction()], null);
    }
    return this.renderGoalForSession(telegramChatId, session);
  }

  private async renderGoalForSession(telegramChatId: string, session: SessionRecord): Promise<MessageSpec> {
    const result = await this.deps.readSessionGoal(session);
    const actions: MessageSpec["actions"] = [];
    if (result.goal) {
      if (result.goal.status === "active") {
        const callback = `goal:set:p:${session.id}`;
        actions.push(messageAction("pause", "Pause", callback, "Goal"));
      } else {
        const callback = `goal:set:a:${session.id}`;
        actions.push(messageAction("continue", "Continue", callback, "Goal"));
      }
      if (result.goal.status !== "complete") {
        const callback = `goal:set:c:${session.id}`;
        actions.push(messageAction("complete", "Complete", callback, "Goal"));
      }
      const clearCallback = `goal:ask:${session.id}`;
      actions.push(messageAction("clear", "Clear", clearCallback, "Goal"));
    }
    actions.push(goalsAction());
    actions.push(helpAction());
    const goalLines = this.deps.formatGoalStatusLines(result);
    return this.createGoalSpec("menu", goalLines.join("\n"), actions, session);
  }

  async setActiveGoalObjective(telegramChatId: string, objective: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(telegramChatId);
    if (!session) return this.renderActiveGoal(telegramChatId);
    const trimmed = objective.trim();
    if (!trimmed) return this.renderActiveGoal(telegramChatId);
    try {
      await this.deps.codexClient.updateThreadGoal(session.codexThreadId, { objective: trimmed, status: "active" });
      return this.renderActiveGoal(telegramChatId);
    } catch (error) {
      return this.createGoalSpec("error", `Goal update failed: ${this.deps.formatShortError(error instanceof Error ? error.message : String(error))}`, [goalsAction(), helpAction()], session);
    }
  }

  async updateActiveGoalStatus(telegramChatId: string, status: "active" | "paused" | "complete"): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(telegramChatId);
    if (!session) return this.renderActiveGoal(telegramChatId);
    return this.updateGoalStatus(telegramChatId, session.id, status);
  }

  async updateGoalStatus(telegramChatId: string, sessionId: string, status: "active" | "paused" | "complete"): Promise<MessageSpec> {
    const session = await this.resolveGoalSession(telegramChatId, sessionId);
    if (!session) return this.renderSelectedGoal(telegramChatId, sessionId);
    try {
      const current = await this.deps.codexClient.readThreadGoal(session.codexThreadId);
      if (!current) {
        return this.createGoalSpec("error", "This session has no goal.", [goalsAction(), helpAction()], session);
      }
      await this.deps.codexClient.updateThreadGoal(session.codexThreadId, { status });
      return this.renderGoalForSession(telegramChatId, session);
    } catch (error) {
      return this.createGoalSpec("error", `Goal update failed: ${this.deps.formatShortError(error instanceof Error ? error.message : String(error))}`, [goalsAction(), helpAction()], session);
    }
  }

  async clearActiveGoal(telegramChatId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(telegramChatId);
    if (!session) return this.renderActiveGoal(telegramChatId);
    return this.clearGoal(telegramChatId, session.id);
  }

  async clearGoal(telegramChatId: string, sessionId: string): Promise<MessageSpec> {
    const session = await this.resolveGoalSession(telegramChatId, sessionId);
    if (!session) return this.renderSelectedGoal(telegramChatId, sessionId);
    try {
      const cleared = await this.deps.codexClient.clearThreadGoal(session.codexThreadId);
      const text = cleared ? "Goal cleared." : "This session has no goal.";
      return this.createGoalSpec("system", text, [goalsAction(), helpAction()], session);
    } catch (error) {
      return this.createGoalSpec("error", `Goal clear failed: ${this.deps.formatShortError(error instanceof Error ? error.message : String(error))}`, [goalsAction(), helpAction()], session);
    }
  }

  async requestClearActiveGoal(telegramChatId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(telegramChatId);
    if (!session) return this.renderActiveGoal(telegramChatId);
    return this.requestClearGoal(telegramChatId, session.id);
  }

  async requestClearGoal(telegramChatId: string, sessionId: string): Promise<MessageSpec> {
    const session = await this.resolveGoalSession(telegramChatId, sessionId);
    if (!session) return this.renderSelectedGoal(telegramChatId, sessionId);
    const result = await this.deps.readSessionGoal(session);
    if (!result.goal) return this.renderGoalForSession(telegramChatId, session);
    const clearCallback = `goal:del:${session.id}`;
    const cancelCallback = `goal:view:${session.id}`;
    return this.createGoalSpec("decision", ["Clear this goal?", result.goal.objective, "This removes the saved goal and its usage history."].join("\n"), [
        { id: "clear", label: "Clear", callback: clearCallback, style: "danger" },
        messageAction("cancel", "Cancel", cancelCallback)
      ], session);
  }

  async renderGoalsMenu(telegramChatId: string, page = 0): Promise<MessageSpec> {
    const selectorChatId = this.deps.getSessionSelectorChatId(telegramChatId);
    const [sessions, activeSession] = await Promise.all([
      this.deps.store.listKnownSessions(selectorChatId),
      this.deps.store.getActiveSession(telegramChatId)
    ]);
    const inspected: Array<{ session: SessionRecord; result: GoalReadResult }> = [];
    for (let offset = 0; offset < sessions.length; offset += this.deps.sessionsPageSize) {
      inspected.push(...await Promise.all(
        sessions.slice(offset, offset + this.deps.sessionsPageSize)
          .map(async (session) => ({ session, result: await this.deps.readSessionGoal(session) }))
      ));
    }
    const rows = inspected
      .filter((row): row is { session: SessionRecord; result: { goal: AppServerThreadGoal; error: null } } =>
        Boolean(row.result.goal && row.result.goal.status !== "complete"))
      .sort((left, right) => right.result.goal.updatedAt - left.result.goal.updatedAt);
    const totalPages = Math.max(1, Math.ceil(rows.length / this.deps.sessionsPageSize));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const visible = rows.slice(safePage * this.deps.sessionsPageSize, (safePage + 1) * this.deps.sessionsPageSize);
    const lines = visible.length === 0
      ? ["No unfinished goals were found in known sessions."]
      : [`${rows.length} unfinished ${rows.length === 1 ? "goal" : "goals"}.`];
    for (const [index, { session, result }] of visible.entries()) {
      lines.push(
        "",
        `${safePage * this.deps.sessionsPageSize + index + 1}. ${result.goal.objective}`,
        formatSessionMarker(this.deps.getSessionDirectory(session))
      );
    }
    const actions: MessageSpec["actions"] = [];
    for (const [index, { session, result }] of visible.entries()) {
      const callback = `goal:view:${session.id}`;
      const label = `${safePage * this.deps.sessionsPageSize + index + 1} · ${this.deps.formatGoalStatus(result.goal.status)} · ${this.deps.getSessionTitle(session)}`;
      actions.push(messageAction(`goal-${session.id}`, label, callback, "Goals"));
    }
    if (totalPages > 1) {
      if (safePage > 0) {
        const callback = `goal-page:${safePage - 1}`;
        actions.push(messageAction("previous", "Previous", callback, "Pagination"));
      }
      actions.push(messageAction("page", `${safePage + 1}/${totalPages}`, "noop", "Pagination"));
      if (safePage < totalPages - 1) {
        const callback = `goal-page:${safePage + 1}`;
        actions.push(messageAction("next", "Next", callback, "Pagination"));
      }
    }
    actions.push(messageAction("refresh", "Refresh", "goal-page:0", "Goals"));
    if (activeSession) {
      actions.push(currentGoalAction());
    }
    actions.push(helpAction());
    return this.createGoalSpec("menu", lines.join("\n"), actions, null, "Goals");
  }

  private createGoalSpec(
    kind: MessageSpec["kind"],
    body: string,
    actions: MessageSpec["actions"],
    session: SessionRecord | null,
    titleLabel?: string
  ): MessageSpec {
    return createMessage({
      kind,
      ...messageContextForSession(session ? {
          id: session.codexThreadId,
          directory: this.deps.getSessionDirectory(session)
      } : null),
      ...(titleLabel ? { titleLabel } : {}),
      body: body ? [{ type: "text", text: body }] : [],
      actions
    });
  }

  private async resolveGoalSession(telegramChatId: string, sessionId: string): Promise<SessionRecord | null> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (!session) return null;
    return this.deps.getSessionSelectorChatId(session.telegramChatId) === this.deps.getSessionSelectorChatId(telegramChatId)
      ? session
      : null;
  }
}
