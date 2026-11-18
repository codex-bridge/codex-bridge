import type { ProtocolEvidenceSnapshot } from "./protocol-evidence.js";

export type MessageDisposition = "handled" | "partial" | "ignored" | "unsupported";
type CoverageGroup = { disposition: MessageDisposition; reason: string; names: readonly string[] };
type CoverageKind = "serverRequest" | "notification" | "item";
type MessageCoverage = Record<CoverageKind, readonly CoverageGroup[]>;

// An audit of client behavior, not a router or a claim of live verification.
// Keep unsupported messages explicit: listing a protocol name does not implement it.
export const APP_SERVER_MESSAGE_COVERAGE: MessageCoverage = {
  serverRequest: [
    { disposition: "handled", reason: "Original-connection approval tokens and shared decision delivery.", names: [
      "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
      "item/permissions/requestApproval", "mcpServer/elicitation/request"
    ] },
    { disposition: "unsupported", reason: "No user-question UI; return an RPC method error, never a fabricated answer or cancellation.", names: [
      "item/tool/requestUserInput"
    ] },
    { disposition: "unsupported", reason: "Bridge registers no dynamic tools; an unexpected call receives an RPC method error.", names: [
      "item/tool/call"
    ] },
    { disposition: "unsupported", reason: "Not implemented by this client; attestation is explicitly disabled during initialization.", names: [
      "attestation/generate", "account/chatgptAuthTokens/refresh", "currentTime/read"
    ] },
    { disposition: "unsupported", reason: "Legacy approval callbacks are not supported; modern approval handlers remain separate.", names: [
      "applyPatchApproval", "execCommandApproval"
    ] }
  ],
  notification: [
    { disposition: "handled", reason: "Turn lifecycle, errors and pending-request resolution use the existing session route.", names: [
      "error", "turn/started", "turn/completed", "serverRequest/resolved", "thread/compacted"
    ] },
    { disposition: "handled", reason: "Update local session metadata, queues or cached runtime status; not every state change creates a message.", names: [
      "thread/archived", "thread/deleted", "thread/unarchived", "thread/name/updated",
      "thread/settings/updated", "thread/queue/changed", "thread/tokenUsage/updated",
      "account/rateLimits/updated", "model/rerouted", "model/verification"
    ] },
    { disposition: "handled", reason: "Reasoning summaries update the working status.", names: [
      "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded"
    ] },
    { disposition: "handled", reason: "Structured file-change progress is rendered without inferring edits from arbitrary text.", names: [
      "item/fileChange/outputDelta", "item/fileChange/patchUpdated"
    ] },
    { disposition: "partial", reason: "Only supported ThreadItem kinds are rendered; message questions and moderation are not retained yet.", names: [
      "item/started", "item/completed"
    ] },
    { disposition: "partial", reason: "MCP status/error is cached and available in status views; no proactive notice or structured failure reason yet.", names: [
      "mcpServer/startupStatus/updated", "mcpServer/oauthLogin/completed"
    ] },
    { disposition: "unsupported", reason: "User-facing warning has no shared delivery handler yet.", names: [
      "warning", "guardianWarning", "configWarning", "deprecationNotice", "windows/worldWritableWarning"
    ] },
    { disposition: "unsupported", reason: "Activity or waiting-state notification has no shared presentation yet.", names: [
      "hook/started", "hook/completed", "turn/plan/updated", "item/plan/delta",
      "item/autoApprovalReview/started", "item/autoApprovalReview/completed",
      "autoApprovalReview/strictReviewRequired", "model/safetyBuffering/updated",
      "item/commandExecution/terminalInteraction", "item/mcpToolCall/progress",
      "modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted"
    ] },
    { disposition: "unsupported", reason: "No consumer for this upstream session-state transition yet.", names: [
      "thread/started", "thread/status/changed", "thread/closed", "thread/reverted",
      "thread/environment/connected", "thread/environment/disconnected", "thread/goal/updated",
      "thread/goal/cleared", "thread/attachment/updated", "thread/prediction/updated",
      "thread/project/updated", "project/changed", "skills/changed", "fs/changed"
    ] },
    { disposition: "unsupported", reason: "Account, application or setup notifications have no Bridge workflow yet.", names: [
      "account/updated", "account/login/completed", "account/gatewayOAuth/changed", "app/list/updated",
      "externalAgentConfig/import/progress", "externalAgentConfig/import/completed",
      "remoteControl/status/changed", "windowsSandbox/setupCompleted", "mcpServer/event/stream/notification"
    ] },
    { disposition: "ignored", reason: "Completed items provide the supported transcript; raw output/deltas are not separate user messages. Agent deltas are opted out.", names: [
      "item/agentMessage/delta", "item/reasoning/textDelta", "item/commandExecution/outputDelta",
      "turn/diff/updated", "rawResponse/completed", "rawResponseItem/completed", "turn/moderationMetadata"
    ] },
    { disposition: "ignored", reason: "Codex read state and section membership are separate from Bridge ownership, directory groups and adapter read state.", names: [
      "thread/readState/changed", "thread/section/changed"
    ] },
    { disposition: "ignored", reason: "No standalone process, fuzzy-search subscription or realtime voice UI is enabled by Bridge.", names: [
      "command/exec/outputDelta", "process/outputDelta", "process/exited",
      "fuzzyFileSearch/sessionUpdated", "fuzzyFileSearch/sessionCompleted",
      "thread/realtime/started", "thread/realtime/itemAdded", "thread/realtime/item/started",
      "thread/realtime/item/transcript/delta", "thread/realtime/item/completed",
      "thread/realtime/transcript/delta", "thread/realtime/transcript/done",
      "thread/realtime/outputAudio/delta", "thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed"
    ] }
  ],
  item: [
    { disposition: "handled", reason: "User dialogue is stored on submission and restored from history.", names: ["userMessage"] },
    { disposition: "handled", reason: "Existing progress summaries and lifecycle handlers cover these item kinds.", names: [
      "commandExecution", "fileChange", "mcpToolCall", "webSearch", "contextCompaction"
    ] },
    { disposition: "partial", reason: "Dialogue text is delivered, but questions and moderation/display metadata are discarded.", names: ["agentMessage"] },
    { disposition: "partial", reason: "Summaries feed live working status; raw reasoning and standalone replay are not exposed.", names: ["reasoning"] },
    { disposition: "partial", reason: "Direct-child tracking/delivery is implemented; nested delegation remains bounded.", names: [
      "subAgentActivity", "collabAgentToolCall"
    ] },
    { disposition: "partial", reason: "Generic tool activity is summarized; generated image/media delivery is not implemented.", names: ["imageGeneration"] },
    { disposition: "unsupported", reason: "No dedicated activity or review-result presentation yet.", names: [
      "plan", "sleep", "imageView", "dynamicToolCall", "enteredReviewMode", "exitedReviewMode"
    ] },
    { disposition: "ignored", reason: "Internal model-facing tool outputs and hook prompts are not user dialogue.", names: [
      "functionCallOutput", "hookPrompt"
    ] }
  ]
};

export function getMessageCoverage(kind: CoverageKind, name: string): CoverageGroup | undefined {
  return APP_SERVER_MESSAGE_COVERAGE[kind].find((group) => group.names.includes(name));
}

export function assertMessageCoverage(
  evidence: Pick<ProtocolEvidenceSnapshot, "schemaMethods" | "schemaItemTypes">,
  coverage: MessageCoverage = APP_SERVER_MESSAGE_COVERAGE
): void {
  const inventories = {
    serverRequest: evidence.schemaMethods.serverRequest,
    notification: evidence.schemaMethods.notification,
    item: evidence.schemaItemTypes
  };
  for (const kind of ["serverRequest", "notification", "item"] as const) {
    const names = coverage[kind].flatMap((group) => {
      if (!group.reason.trim()) throw new Error(`Missing ${kind} coverage reason`);
      return group.names;
    });
    if (names.length !== new Set(names).size) throw new Error(`Duplicate ${kind} coverage entries`);
    if (!inventories[kind]?.length) throw new Error(`Missing generated ${kind} inventory`);
    const missing = inventories[kind].filter((name) => !names.includes(name));
    const extra = names.filter((name) => !inventories[kind].includes(name));
    if (missing.length || extra.length) {
      throw new Error(`Review ${kind} coverage: unclassified [${missing.join(", ")}]; obsolete [${extra.join(", ")}]`);
    }
  }
}
