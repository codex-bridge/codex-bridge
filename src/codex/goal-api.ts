import { asRecord, firstString } from "./protocol-utils.js";

export type AppServerThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type AppServerThreadGoal = {
  threadId: string;
  objective: string;
  status: AppServerThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type ThreadGoalPatch = {
  objective?: string | null;
  status?: AppServerThreadGoalStatus | null;
  tokenBudget?: number | null;
};

export type GoalApiDependencies = {
  connect: () => Promise<void>;
  requestKnownMethod: (
    method: "thread/goal/get" | "thread/goal/set" | "thread/goal/clear",
    params?: unknown,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>;
};

export class CodexGoalApi {
  constructor(private readonly deps: GoalApiDependencies) {}

  async readThreadGoal(threadId: string): Promise<AppServerThreadGoal | null> {
    await this.deps.connect();
    const result = asRecord(await this.deps.requestKnownMethod(
      "thread/goal/get",
      { threadId },
      { timeoutMs: 5_000 }
    ));
    return extractThreadGoal(result?.goal);
  }

  async updateThreadGoal(threadId: string, patch: ThreadGoalPatch): Promise<AppServerThreadGoal> {
    await this.deps.connect();
    const result = asRecord(await this.deps.requestKnownMethod(
      "thread/goal/set",
      { threadId, ...patch },
      { timeoutMs: 5_000 }
    ));
    const goal = extractThreadGoal(result?.goal);
    if (!goal) {
      throw new Error("Goal update returned no valid goal.");
    }
    return goal;
  }

  async clearThreadGoal(threadId: string): Promise<boolean> {
    await this.deps.connect();
    const result = asRecord(await this.deps.requestKnownMethod(
      "thread/goal/clear",
      { threadId },
      { timeoutMs: 5_000 }
    ));
    return result?.cleared === true;
  }
}

export function extractThreadGoal(value: unknown): AppServerThreadGoal | null {
  const goal = asRecord(value);
  const threadId = firstString(goal?.threadId);
  const objective = firstString(goal?.objective);
  const status = goal?.status;
  if (!threadId || !objective || !(
    status === "active" || status === "paused" || status === "blocked" ||
    status === "usageLimited" || status === "budgetLimited" || status === "complete"
  )) {
    return null;
  }
  const number = (candidate: unknown, fallback = 0) =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  return {
    threadId,
    objective,
    status,
    tokenBudget: typeof goal?.tokenBudget === "number" ? goal.tokenBudget : null,
    tokensUsed: number(goal?.tokensUsed),
    timeUsedSeconds: number(goal?.timeUsedSeconds),
    createdAt: number(goal?.createdAt),
    updatedAt: number(goal?.updatedAt)
  };
}
