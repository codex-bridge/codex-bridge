import { McpStartupTracker } from "./status/mcp-startup.js";

export type LastAssistantMessage = {
  chatId: string;
  messageId: string;
  text: string;
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
  readonly lastUserInputBySession = new Map<string, string>();
  readonly recentResolvedMcpBySession = new Map<string, number>();
  readonly inFlightTurnIdByThread = new Map<string, string>();
  readonly assistantOutputByThread = new Map<string, boolean>();
  readonly errorSeenByThread = new Map<string, boolean>();
  readonly lastAssistantTelegramByThread = new Map<string, LastAssistantMessage>();
  readonly mcpStartupStatus = new McpStartupTracker();
  readonly modelRuntimeEventByThread = new Map<string, ModelRuntimeEvent>();
  editedProgressMinIntervalMs = 1_500;
}
