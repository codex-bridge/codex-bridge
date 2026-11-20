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
    { disposition: "handled", reason: "Connection-bound native questions collect typed answers through shared session guards and platform forms; verification-only clients without a handler reject requests explicitly.", names: [
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
    { disposition: "handled", reason: "Public reasoning summaries feed ordered Thinking activity; Working retains only the stage.", names: [
      "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded"
    ] },
    { disposition: "handled", reason: "Structured file-change progress is rendered without inferring edits from arbitrary text.", names: [
      "item/fileChange/outputDelta", "item/fileChange/patchUpdated"
    ] },
    { disposition: "partial", reason: "Supported ThreadItem kinds include assistant display rules and async question choices; other activities remain unsupported.", names: [
      "item/started", "item/completed"
    ] },
    { disposition: "handled", reason: "Scoped MCP status and failure reasons feed shared status views and deduplicated failure/recovery notices; OAuth success alone does not imply readiness.", names: [
      "mcpServer/startupStatus/updated", "mcpServer/oauthLogin/completed"
    ] },
    { disposition: "handled", reason: "Public warnings use declared session or service scope and shared presentation; identical observations are deduplicated in memory.", names: [
      "warning", "guardianWarning", "configWarning", "deprecationNotice"
    ] },
    { disposition: "unsupported", reason: "Windows writable-path warnings still need a dedicated presentation contract.", names: [
      "windows/worldWritableWarning"
    ] },
    { disposition: "handled", reason: "Plan snapshots and approval-review observations use the existing ordered activity lifecycle, without executing or approving actions.", names: [
      "turn/plan/updated",
      "item/autoApprovalReview/started", "item/autoApprovalReview/completed",
      "autoApprovalReview/strictReviewRequired"
    ] },
    { disposition: "partial", reason: "Turn-scoped Hook lifecycle and public status/error entries are shown as activities; null-turn session/connection hooks are not assigned to an invented task. Internal context and feedback stay private.", names: [
      "hook/started", "hook/completed"
    ] },
    { disposition: "ignored", reason: "Full plan items and structured turn plan snapshots provide content; raw plan deltas are not separate messages.", names: ["item/plan/delta"] },
    { disposition: "unsupported", reason: "Activity or waiting-state notification has no shared presentation yet.", names: [
      "model/safetyBuffering/updated",
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
    { disposition: "partial", reason: "Dialogue, versioned display instructions and async question choices are supported; other native interactions remain separately classified.", names: ["agentMessage"] },
    { disposition: "partial", reason: "Public summaries feed ordered Thinking activity; raw reasoning and standalone replay are not exposed.", names: ["reasoning"] },
    { disposition: "partial", reason: "Direct-child tracking/delivery is implemented; nested delegation remains bounded.", names: [
      "subAgentActivity", "collabAgentToolCall"
    ] },
    { disposition: "partial", reason: "Generic tool activity is summarized; generated image/media delivery is not implemented.", names: ["imageGeneration"] },
    { disposition: "handled", reason: "Public activities feed ordered phases; plan/review text is retained, dynamic tools expose names/results, and direct-child observations remain with the tracker.", names: [
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
