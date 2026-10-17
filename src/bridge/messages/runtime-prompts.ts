import type { DecisionRecord, SessionRecord } from "../../shared/types.js";
import {
  buildAwaitingMcpPrompt,
  buildMcpJsonExample,
  extractMcpToolName
} from "../decisions/formatters.js";
import { helpAction, messageAction } from "./actions.js";
import { createMessage, messageContextForSession } from "./factory.js";
import type { MessageSpec } from "./types.js";

export type RuntimePromptFactoryDependencies = {
  isRuntimeConnected: () => boolean;
  getSessionDirectory: (session: SessionRecord) => string;
};

export class RuntimePromptFactory {
  constructor(private readonly deps: RuntimePromptFactoryDependencies) {}

  createIncoming(kind: MessageSpec["kind"], text: string, session: SessionRecord | null): MessageSpec {
    return createMessage({
      kind,
      ...messageContextForSession(session ? {
          id: session.codexThreadId,
          directory: this.deps.getSessionDirectory(session)
      } : null),
      body: [{ type: "text", text }],
      actions: this.createRecoveryActions()
    });
  }

  createMcpInput(session: SessionRecord, decision: DecisionRecord, errorMessage?: string): MessageSpec {
    const example = buildMcpJsonExample(decision);
    const toolName = extractMcpToolName(decision.title, decision.summary);
    const heading = toolName
      ? `Still waiting for MCP ${toolName} JSON input.`
      : "Still waiting for MCP JSON input.";
    const instruction = buildAwaitingMcpPrompt(decision);
    const body = errorMessage
      ? `${heading}\n${errorMessage}${example ? `\n\nExample:\n${example}` : ""}`
      : instruction;
    return createMessage({
      kind: "mcp",
      titleLabel: "MCP Input Required",
      session: {
        id: session.codexThreadId,
        directory: this.deps.getSessionDirectory(session)
      },
      body: [{ type: "text", text: body }],
      actions: [helpAction()]
    });
  }

  createSystemError(session: SessionRecord, stage: "stream" | "error", message: string): MessageSpec {
    return createMessage({
      kind: stage === "stream" ? "stream-error" : "error",
      session: { id: session.id, directory: this.deps.getSessionDirectory(session) },
      body: [{ type: "text", text: message }],
      actions: this.createRecoveryActions()
    });
  }

  private createRecoveryActions(): MessageSpec["actions"] {
    return [
      ...(!this.deps.isRuntimeConnected()
        ? [messageAction("bot-connect", "Connect", "quick:bot_connect", "Bot")]
        : []),
      helpAction()
    ];
  }
}
