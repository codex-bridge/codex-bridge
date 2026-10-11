export type LastAssistantMessage = {
  chatId: string;
  messageId: string;
  text: string;
};

export type McpStartupStatus = {
  status: string | null;
  error: string | null;
  updatedAt: number;
};

export type ModelRuntimeEvent = {
  kind: "rerouted" | "verified";
  fromModel: string | null;
  toModel: string | null;
  reason: string | null;
  verifications: string[];
  updatedAt: number;
};

export class BridgeRuntimeState {
  readonly refreshStatusMessageBySession = new Map<string, { chatId: string; messageId: string }>();
  readonly lastUserInputBySession = new Map<string, string>();
  readonly recentResolvedMcpBySession = new Map<string, number>();
  readonly inFlightTurnIdByThread = new Map<string, string>();
  readonly assistantOutputByThread = new Map<string, boolean>();
  readonly errorSeenByThread = new Map<string, boolean>();
  readonly pendingGoShortcutByThread = new Map<string, ReturnType<typeof setTimeout>>();
  readonly lastAssistantTelegramByThread = new Map<string, LastAssistantMessage>();
  readonly mcpStartupStatusByName = new Map<string, McpStartupStatus>();
  readonly modelRuntimeEventByThread = new Map<string, ModelRuntimeEvent>();
  editedProgressMinIntervalMs = 1_500;
}
