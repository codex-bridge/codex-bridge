import { GoalService } from "./service.js";
import type { MessageSpec } from "../messages/types.js";
import { SessionOwnershipService } from "../sessions/ownership.js";
import { BridgeStore } from "../../store/index.js";

type GoalStatus = "active" | "paused" | "complete";

export type GoalCommandDependencies = {
  store: BridgeStore;
  goalService: GoalService;
  sessionOwnershipService: SessionOwnershipService;
};

export class GoalCommandService {
  constructor(private readonly deps: GoalCommandDependencies) {}

  renderActive(chatId: string): Promise<MessageSpec> {
    return this.deps.goalService.renderActiveGoal(chatId);
  }

  renderSelected(chatId: string, sessionId: string): Promise<MessageSpec> {
    return this.deps.goalService.renderSelectedGoal(chatId, sessionId);
  }

  async setActiveObjective(chatId: string, objective: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(chatId);
    if (session) {
      const prompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, chatId);
      if (prompt) return prompt;
    }
    return this.deps.goalService.setActiveGoalObjective(chatId, objective);
  }

  async updateActiveStatus(chatId: string, status: GoalStatus): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(chatId);
    if (session) {
      const prompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, chatId);
      if (prompt) return prompt;
    }
    return this.deps.goalService.updateActiveGoalStatus(chatId, status);
  }

  async updateStatus(chatId: string, sessionId: string, status: GoalStatus): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (session) {
      const prompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, chatId);
      if (prompt) return prompt;
    }
    return this.deps.goalService.updateGoalStatus(chatId, sessionId, status);
  }

  async clearActive(chatId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(chatId);
    if (session) {
      const prompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, chatId);
      if (prompt) return prompt;
    }
    return this.deps.goalService.clearActiveGoal(chatId);
  }

  async clear(chatId: string, sessionId: string): Promise<MessageSpec> {
    const session = await this.deps.store.getSessionById(sessionId);
    if (session) {
      const prompt = await this.deps.sessionOwnershipService.getSessionOwnershipPrompt(session, chatId);
      if (prompt) return prompt;
    }
    return this.deps.goalService.clearGoal(chatId, sessionId);
  }

  requestClearActive(chatId: string): Promise<MessageSpec> {
    return this.deps.goalService.requestClearActiveGoal(chatId);
  }

  requestClear(chatId: string, sessionId: string): Promise<MessageSpec> {
    return this.deps.goalService.requestClearGoal(chatId, sessionId);
  }

  renderMenu(chatId: string, page = 0): Promise<MessageSpec> {
    return this.deps.goalService.renderGoalsMenu(chatId, page);
  }
}
