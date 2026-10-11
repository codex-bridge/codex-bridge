import assert from "node:assert/strict";
import test from "node:test";

import { NotificationApprovalService } from "../src/bridge/notifications/approval.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { CodexAppServerClient, type AppServerApprovalRequest } from "../src/codex/client.js";
import type { SessionRecord } from "../src/shared/types.js";

const session = {
  id: "session-1",
  telegramChatId: "chat-1",
  codexThreadId: "thread-1"
} as SessionRecord;

function approvalServiceFixture() {
  const resolutions: Array<{ requestId: string; action: string; method: string | null }> = [];
  const messages: MessageSpec[] = [];
  const service = new NotificationApprovalService({
    store: {} as never,
    codexClient: {
      isApprovalPending: () => true,
      resolveApproval: async (requestId: string, action: string, method: string | null) => {
        resolutions.push({ requestId, action, method });
      }
    } as never,
    subagents: { route: () => null } as never,
    earlyApprovals: new Map(),
    resolveNotificationSession: async () => session,
    getSessionDirectory: () => "/workspace/project",
    cancelGoShortcut: () => undefined,
    setSessionStatus: async () => undefined,
    sendDecisionMessage: async () => undefined,
    syncBatchDecisionMessage: async () => undefined,
    sendLongSpec: async (_chatId, message) => { messages.push(message); }
  });
  return { service, resolutions, messages };
}

function mcpRequest(input: Partial<AppServerApprovalRequest>): AppServerApprovalRequest {
  return {
    requestId: "approval-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: null,
    method: "mcpServer/elicitation/request",
    title: "MCP request",
    summary: null,
    requestedFields: [],
    requiresUserInput: false,
    elicitationMode: null,
    ...input
  };
}

test("ordinary prefilled MCP elicitations keep their auto-accept behavior", async () => {
  const fixture = approvalServiceFixture();
  await fixture.service.handleApprovalRequest(mcpRequest({ elicitationMode: "form" }));
  assert.deepEqual(fixture.resolutions, [{
    requestId: "approval-1",
    action: "accept",
    method: "mcpServer/elicitation/request"
  }]);
  assert.deepEqual(fixture.messages, []);
});

test("user verification is cancelled and redirected without exposing challenge data", async () => {
  const fixture = approvalServiceFixture();
  await fixture.service.handleApprovalRequest(mcpRequest({
    elicitationMode: "openai/userVerification",
    title: "Confirm identity",
    summary: "Use local verification"
  }));

  assert.deepEqual(fixture.resolutions, [{
    requestId: "approval-1",
    action: "cancel",
    method: "mcpServer/elicitation/request"
  }]);
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.messages[0]?.title, "System · /workspace/project");
  assert.deepEqual(fixture.messages[0]?.body, [{
    type: "text",
    text: "Verification must be completed in Codex App."
  }]);
});

test("unknown elicitation modes fail closed", async () => {
  const fixture = approvalServiceFixture();
  await fixture.service.handleApprovalRequest(mcpRequest({ elicitationMode: "future/mode" }));
  assert.equal(fixture.resolutions[0]?.action, "cancel");
  assert.match(fixture.messages[0]?.body[0]?.type === "text" ? fixture.messages[0].body[0].text : "", /Codex App/);
});

test("app-server approval extraction retains mode but not verification challenge", () => {
  const approvals: AppServerApprovalRequest[] = [];
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    approvalIds: new Map(),
    approvalTokens: new Map(),
    approvalListeners: new Set([(request: AppServerApprovalRequest) => { approvals.push(request); }])
  });
  const internal = client as unknown as {
    handleServerRequest(request: { id: string; method: string; params: unknown }): void;
  };
  internal.handleServerRequest({
    id: "rpc-1",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      mode: "openai/userVerification",
      title: "Confirm identity",
      description: "Use Codex App",
      challenge: "secret-challenge-value"
    }
  });

  assert.equal(approvals[0]?.elicitationMode, "openai/userVerification");
  assert.doesNotMatch(JSON.stringify(approvals[0]), /secret-challenge-value/);
});
