type Clearable = {
  clear: () => void;
};

type SessionRouteClearable = {
  clearSessionRoutes: () => void;
};

type TypingClearable = {
  clearAll: () => void;
};

export type RuntimeStateCleanupDependencies = {
  threadMetadataCache: Clearable;
  inFlightTurnIds: Clearable;
  notificationSessions: Clearable;
  assistantOutput: Clearable;
  seenErrors: Clearable;
  rateLimitSessions: SessionRouteClearable;
  tokenUsage: Clearable;
  mcpStartupStatus: Clearable;
  modelRuntimeEvents: Clearable;
  lastAssistantMessages: Clearable;
  pendingGoShortcuts: Map<string, ReturnType<typeof setTimeout>>;
  typing: TypingClearable;
  clearProgressMessages: () => Promise<void>;
  clearSessionStatusMessages: () => Promise<void>;
};

export class RuntimeStateCleanupService {
  constructor(private readonly deps: RuntimeStateCleanupDependencies) {}

  async clear(): Promise<void> {
    this.deps.threadMetadataCache.clear();
    this.deps.inFlightTurnIds.clear();
    this.deps.notificationSessions.clear();
    this.deps.assistantOutput.clear();
    this.deps.seenErrors.clear();
    this.deps.rateLimitSessions.clearSessionRoutes();
    this.deps.tokenUsage.clear();
    this.deps.mcpStartupStatus.clear();
    this.deps.modelRuntimeEvents.clear();
    this.deps.lastAssistantMessages.clear();
    for (const timeout of this.deps.pendingGoShortcuts.values()) {
      clearTimeout(timeout);
    }
    this.deps.pendingGoShortcuts.clear();
    this.deps.typing.clearAll();
    await this.deps.clearProgressMessages();
    await this.deps.clearSessionStatusMessages();
  }
}
