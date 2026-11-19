import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { CodexAppServerClient, type AppServerUserInputRequest } from "../src/codex/client.js";
import type { AppConfig } from "../src/config/index.js";
import { parseUserInputPrompt, USER_INPUT_METHOD, validateUserInputAnswers } from "../src/shared/user-input.js";
import { UserInputService, userQuestionActions, parseUserQuestionAction } from "../src/bridge/decisions/user-input.js";
import { BridgeStore } from "../src/store/index.js";
import { createDecisionMessageSpec, describeDecision } from "../src/bridge/decisions/formatters.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";
import { renderSlackMessageSpec } from "../src/slack/message-renderer.js";
const { DecisionCard } = await tsImport("../web/src/components/decision-card.tsx", { parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)) }) as typeof import("../web/src/components/decision-card.tsx");
import { WebDecisionService } from "../src/web/decisions.js";
import { SessionAccessService } from "../src/bridge/sessions/access.js";
import { DecisionCommandService } from "../src/bridge/decisions/commands.js";
import { IncomingPreflightService } from "../src/bridge/input/preflight.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { handleSlackTurnWorkflow } from "../src/slack/interactions/turn-workflow.js";
import { handleTelegramTurnWorkflow } from "../src/telegram/interactions/turn-workflow.js";

const prompt = { isBlocking: true, questions: [
  { id: "direction", header: "Direction", question: "Which direction?", isOther: true, isSecret: false,
    options: [{ label: "Go", description: "Continue." }, { label: "Next", description: "List next choices." }] },
  { id: "notes", header: "Notes", question: "Any notes?", isOther: true, isSecret: true, options: null }
] };
const answer = { answers: { direction: { answers: ["Go"] }, notes: { answers: ["synthetic-private-answer"] } } };

function protocolFixture(t: TestContext, resolved = false) {
  const params = { threadId: "thread", turnId: "turn", itemId: "question", autoResolutionMs: null, ...prompt };
  const script = `const r=require('node:readline'); const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    r.createInterface({input:process.stdin}).on('line', line=>{const x=JSON.parse(line);
      if(x.method==='initialize') {
        const q=id=>({id,method:'item/tool/requestUserInput',params:${JSON.stringify(params)}});
        [q(0),q(0),q('other')${resolved ? ",{method:'serverRequest/resolved',params:{threadId:'thread',requestId:0}}" : ""},
          {id:x.id,result:{userAgent:'fixture/0.170.0'}}].forEach(send);
      } else if('result' in x || 'error' in x)send({method:'test/answer',params:x});
      else if(x.id!==undefined)send({id:x.id,result:{thread:{id:'thread',status:{type:'idle'}}}});
    });`;
  const client = new CodexAppServerClient({ codexTransport: "stdio", codexAppServerCommand: process.execPath,
    codexAppServerArgs: ["-e", script], codexSkillExtraRoots: [] } as unknown as AppConfig);
  t.after(() => client.close());
  const requests: AppServerUserInputRequest[] = [], responses: unknown[] = [];
  client.onUserInputRequest(request => requests.push(request));
  client.onNotification(event => { if (event.method === "test/answer") responses.push(event.params); });
  return { client, requests, responses, barrier: () => client.requestKnownMethod("thread/read", { threadId: "thread" }) };
}

test("native questions dedupe original IDs including zero and return structured answers without approval decisions", async t => {
  const f = protocolFixture(t); await f.client.connect();
  assert.equal(f.requests.length, 2);
  const request = f.requests[0]!;
  assert.deepEqual(f.client.readUserInputRequest(request.requestId), prompt);
  await assert.rejects(f.client.resolveApproval(request.requestId, "accept", USER_INPUT_METHOD), /unavailable/);
  await assert.rejects(f.client.resolveUserInput(request.requestId, { answers: { direction: { answers: ["Go"] } } }), /every question/);
  assert.equal(f.client.isApprovalPending(request.requestId), true, "invalid answers do not consume the pending request");
  await f.client.resolveUserInput(request.requestId, answer);
  await assert.rejects(f.client.resolveUserInput(request.requestId, answer), /no longer active/);
  await f.client.resolveUserInput(f.requests[1]!.requestId, null);
  await f.barrier();
  assert.deepEqual(f.responses, [{ id: 0, result: answer }, { id: "other", result: { answers: {} } }]);
});

test("resolved requests and reconnects invalidate old local question identities", async t => {
  const f = protocolFixture(t, true); await f.client.connect();
  const old = f.requests[0]!;
  assert.equal(f.client.readUserInputRequest(old.requestId), undefined);
  await assert.rejects(f.client.resolveUserInput(old.requestId, answer), /no longer active/);
  const other = f.requests[1]!;
  await f.client.close(); await f.client.connect();
  assert.notEqual(f.requests[3]!.requestId, other.requestId);
  await assert.rejects(f.client.resolveUserInput(other.requestId, answer), /no longer active/);
});

test("question parsing rejects duplicate IDs and answers use original IDs with no invented defaults", () => {
  assert.throws(() => parseUserInputPrompt({ ...prompt, questions: [prompt.questions[0], prompt.questions[0]] }), /duplicate/);
  assert.throws(() => validateUserInputAnswers(prompt, { answers: {} }), /every question/);
  assert.throws(() => validateUserInputAnswers(prompt, { answers: { direction: { answers: [""] }, notes: { answers: ["text"] } } }), /required/);
  const fixed = { ...prompt, questions: [{ ...prompt.questions[0]!, isOther: false }, prompt.questions[1]!] };
  assert.throws(() => validateUserInputAnswers(fixed, { answers: { direction: { answers: ["custom"] }, notes: { answers: ["text"] } } }), /available option/);
  assert.deepEqual(validateUserInputAnswers(prompt, answer), answer.answers);
});

async function serviceFixture(t: TestContext) {
  const store = new BridgeStore(":memory:"); t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "thread", pathKey: "/work", currentCwd: "/work" });
  store.claimSession(session.id, "web:local");
  const pending = await store.createOrReplacePendingDecision({ sessionId: session.id, telegramChatId: "web:local", approvalId: "local-token",
    kind: USER_INPUT_METHOD, title: "Answer questions", summary: "Which direction?\nAny notes?", requiresUserInput: true });
  const decision = (await store.resolveDecision(pending.id, "awaitingInput"))!;
  const writes: unknown[] = [], sent: unknown[] = [];
  let active = true;
  const client = { readUserInputRequest: () => active ? prompt : undefined, isApprovalPending: () => active,
    resolveUserInput: async (_id: string, content: unknown) => { assert.equal(active, true); writes.push(content); active = false; } };
  const service = new UserInputService({ store, client, refresh: async (_s, d) => { sent.push(service.present(d)); },
    finish: async d => { sent.push(d); } });
  return { store, session, decision, service, writes, sent, client, expire: () => { active = false; } };
}

test("chat questions collect selections and text, then submit once; no answer is persisted or labelled approved", async t => {
  const f = await serviceFixture(t);
  const first = f.service.present(f.decision);
  const actions = userQuestionActions(first);
  assert.deepEqual(actions.map(action => action.label), ["Go", "Next", "Write an answer", "Skip questions"]);
  for (const action of actions) assert.ok(Buffer.byteLength(action.callback) <= 64);
  const pick = parseUserQuestionAction(actions[0]!.callback)!;
  assert.equal((await f.service.act(pick, "slack:other")).ok, false);
  assert.equal((await f.service.act(pick, "web:local")).ok, true);
  assert.deepEqual(f.writes, []);
  assert.equal((await f.service.text(f.decision, "synthetic-private-answer", "web:local")).ok, true);
  const ready = f.service.present(f.decision);
  assert.deepEqual(ready.userInput!.answeredQuestionIds, ["direction", "notes"]);
  assert.equal(JSON.stringify(ready).includes("synthetic-private-answer"), false);
  const submit = parseUserQuestionAction(userQuestionActions(ready)[0]!.callback)!;
  const results = await Promise.all([f.service.act(submit, "web:local"), f.service.act(submit, "web:local")]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.deepEqual(f.writes, [answer]);
  assert.equal((await f.store.getDecision(f.decision.id))!.state, "answered");
  assert.equal(JSON.stringify(await f.store.getDecision(f.decision.id)).includes("synthetic-private-answer"), false);
  assert.deepEqual(await f.store.listRecentMessages(f.session.id, 10), []);
});

test("question controls stay distinct from approvals, and expired requests cannot regain a form", async t => {
  const f = await serviceFixture(t);
  const decision = f.service.present(f.decision);
  const spec = createDecisionMessageSpec(f.session, decision, userQuestionActions(decision));
  assert.match(JSON.stringify(spec.body), /Next: List next choices/);
  assert.deepEqual(describeDecision(decision).availableActions, ["cancel"]);
  for (const rendered of [renderSlackMessageSpec("slack:T:C", spec, null), renderTelegramMessageSpec(spec)])
    assert.equal(JSON.stringify(rendered).includes("Approve"), false);
  const html = renderToStaticMarkup(createElement(DecisionCard, { message: spec, current: true, enabled: true, busy: false, onAction: async () => {} }));
  assert.match(html, /Submit answers/); assert.match(html, /type="password"/);
  assert.equal(html.includes("JSON object"), false); assert.equal(html.includes("checked="), false);
  f.expire();
  assert.equal((await f.service.submit(f.decision.id, answer, "web:local")).ok, false);
  assert.equal(f.service.present(f.decision).userInput, undefined);
  assert.deepEqual(f.writes, []);
});

test("chat adapters route native selections to the question service without sending ordinary Go text", async t => {
  const f = await serviceFixture(t);
  const action = userQuestionActions(f.service.present(f.decision))[0]!.callback;
  const service = { handleUserQuestion: (chat: string, action: Parameters<UserInputService["act"]>[0]) => f.service.act(action, chat) };
  const acknowledgements: string[] = [];
  assert.equal(await handleSlackTurnWorkflow({ action, context: { platform: "slack", conversationId: "web:local", surfaceId: "web:local" },
    messageText: null, openQueueModal: async () => {}, service: service as never,
    transport: { sendMessageSpec: async () => { assert.fail("selection updates the existing card"); } } as never }), true);
  assert.deepEqual(f.service.present(f.decision).userInput!.answeredQuestionIds, ["direction"]);
  assert.deepEqual(f.writes, []);
  assert.equal(await handleTelegramTurnWorkflow({ action, callbackId: "callback", context: { platform: "telegram", conversationId: "not-owner", surfaceId: "not-owner" },
    acknowledge: async text => { acknowledgements.push(text ?? ""); }, service: service as never, responder: {} as never }), true);
  assert.match(acknowledgements[0]!, /Acquire this session/);
  assert.deepEqual(f.writes, []);
});

test("Web uses the existing decision endpoint for typed answers and returns an answered receipt", async t => {
  const f = await serviceFixture(t);
  const commands = new DecisionCommandService({ store: f.store, userInput: f.service, codexClient: {} as never,
    sessionOwnershipService: {} as never, decisionDelivery: {} as never, createMcpInputPromptSpec: () => { throw new Error("not MCP"); }, sendLongSpec: async () => {} });
  const web = new WebDecisionService({ access: new SessionAccessService(f.store), store: f.store, commands,
    isRuntimeConnected: () => true, isApprovalPending: () => f.client.isApprovalPending(),
    presentDecision: d => f.service.present(d), runDispatch: async (_session, operation) => operation() });
  const snapshot = await web.read("thread", undefined, () => {});
  assert.equal(snapshot.snapshot.decisions[0]!.decision!.interaction, "user-input");
  assert.deepEqual(snapshot.snapshot.decisions[0]!.decision!.userInput!.questions, prompt.questions);
  assert.deepEqual(snapshot.snapshot.decisions[0]!.body, [], "the native form owns Web question content");
  const receipt = await web.act({ threadId: "thread", decisionId: f.decision.id, action: "submit", content: answer }, () => {});
  assert.equal(receipt.accepted, true); assert.equal(receipt.state, "answered");
  assert.deepEqual(f.writes, [answer]);
});

test("saved answers can be edited before the single final submission", async t => {
  const f = await serviceFixture(t);
  await f.service.act({ decisionId: f.decision.id, type: "pick", question: 0, option: 0 }, "web:local");
  await f.service.text(f.decision, "initial notes", "web:local");
  await f.service.act({ decisionId: f.decision.id, type: "edit", question: 0 }, "web:local");
  assert.equal(f.service.present(f.decision).userInput!.activeQuestionId, "direction");
  await f.service.act({ decisionId: f.decision.id, type: "pick", question: 0, option: 1 }, "web:local");
  const result = await f.service.act({ decisionId: f.decision.id, type: "submit" }, "web:local");
  assert.equal(result.ok, true);
  assert.deepEqual(f.writes, [{ answers: { direction: { answers: ["Next"] }, notes: { answers: ["initial notes"] } } }]);
});

test("skipping sends an empty answer; pending handoff preserves the owner and lost ownership rejects answers", async t => {
  const f = await serviceFixture(t);
  const result = await f.service.submit(f.decision.id, null, "web:local");
  assert.equal(result.ok, true); assert.deepEqual(f.writes, [null]);
  assert.equal((await f.store.getDecision(f.decision.id))!.state, "cancelled");
  const other = await serviceFixture(t);
  const handoff = other.store.requestSessionHandoff(other.session.id, "slack:new-owner", true);
  assert.equal(handoff.pending, true);
  assert.equal((await other.service.submit(other.decision.id, answer, "slack:new-owner")).ok, false);
  assert.equal((await other.service.submit(other.decision.id, answer, "web:local")).ok, true);
  const lost = await serviceFixture(t);
  lost.store.markSessionExternalUnknown(lost.session.id);
  assert.equal((await lost.service.submit(lost.decision.id, answer, "web:local")).ok, false);
  assert.deepEqual(lost.writes, []);
});

test("answer write uncertainty disables the request without retry; display failure preserves a successful receipt", async t => {
  const f = await serviceFixture(t);
  let count = 0;
  f.client.resolveUserInput = async () => { count++; throw new Error("pipe closed"); };
  const result = await f.service.submit(f.decision.id, answer, "web:local");
  assert.equal(result.ok, false); assert.match(result.message, /outcome is unknown/);
  assert.equal((await f.store.getDecision(f.decision.id))!.state, "stale");
  await f.service.submit(f.decision.id, answer, "web:local"); assert.equal(count, 1);
  const other = await serviceFixture(t);
  const service = new UserInputService({ store: other.store, client: other.client, refresh: async () => {},
    finish: async () => { throw new Error("display failed"); } });
  assert.equal((await service.submit(other.decision.id, answer, "web:local")).ok, true);
  assert.equal((await other.store.getDecision(other.decision.id))!.state, "answered");
  const unsaved = await serviceFixture(t);
  unsaved.store.resolveDecision = async () => { throw new Error("receipt storage failed"); };
  assert.equal((await unsaved.service.submit(unsaved.decision.id, answer, "web:local")).ok, true);
  assert.deepEqual(unsaved.writes, [answer]);
  assert.equal((await unsaved.service.submit(unsaved.decision.id, answer, "web:local")).ok, false);
  assert.equal(unsaved.writes.length, 1);
});

test("chat text answers an active native question before MCP JSON parsing or ordinary model turns", async t => {
  const f = await serviceFixture(t);
  const preflight = new IncomingPreflightService({ store: f.store, codexClient: {} as never,
    answerUserQuestion: (decision, text, source) => f.service.text(decision, text, source),
    sessionOwnershipService: { getSessionOwnershipPrompt: async () => null } as never,
    ensureChatAllowed: async () => {}, isRuntimeConnected: () => true, getActiveSession: async () => f.session,
    recoverSlackDmActiveSession: async () => null, getSessionDirectory: () => "/work",
    createIncomingPromptSpec: (kind, text) => createMessage({ kind, scope: "global", body: [{ type: "text", text }] }),
    createMcpInputPromptSpec: () => { throw new Error("Native questions must not use MCP JSON"); },
    sendLongSpec: async () => {}, syncBatchDecisionMessageForSessionId: async () => {}, renderSessionMenu: async () => { throw new Error("No menu"); } });
  for (const text of ["Go", "ordinary text answer"]) {
    const result = await preflight.run({ telegramChatId: "web:local", telegramMessageId: "input", text });
    assert.equal(result.kind, "response");
    if (result.kind === "response") assert.equal(result.response.routed, true);
  }
  assert.deepEqual(f.writes, [], "collecting input does not respond to the RPC automatically");
  await f.service.act({ decisionId: f.decision.id, type: "submit" }, "web:local");
  assert.deepEqual(f.writes, [{ answers: { direction: { answers: ["Go"] }, notes: { answers: ["ordinary text answer"] } } }]);
});
