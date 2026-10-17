import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { SessionAccessError, SessionAccessService } from "../src/bridge/sessions/access.js";
import { SessionBindingService } from "../src/bridge/sessions/binding.js";
import { DecisionCommandService } from "../src/bridge/decisions/commands.js";
import { DecisionDeliveryService } from "../src/bridge/decisions/delivery.js";
import { SessionDecisionOperationQueue } from "../src/bridge/decisions/session-operation-queue.js";
import { createBatchDecisionMessageSpec, createDecisionMessageSpec, getExecpolicyAmendment,
  isBatchableDecision } from "../src/bridge/decisions/formatters.js";
import { WebDecisionError, WebDecisionService } from "../src/web/decisions.js";
import { WebMessageTransport, type WebMessageDelivery } from "../src/web/transport.js";
import type { DecisionAction, DecisionRecord } from "../src/shared/types.js";

async function fixture(t: TestContext) {
  const store = new BridgeStore(":memory:");
  t.after(() => store.close());
  const session = await store.upsertDiscoveredSession({ telegramChatId: "web:local", codexThreadId: "thread", pathKey: "/work" });
  store.claimSession(session.id, "web:local");
  const tokens = new Set<string>();
  let connected = true;
  let afterAnswer: () => Promise<void> = async () => {};
  const runtime = { isRuntimeConnected: () => connected, isApprovalPending: (id: string) => tokens.has(id) };
  const transport = new WebMessageTransport(store, runtime);
  const events: WebMessageDelivery[] = [];
  transport.subscribe((event) => events.push(event));
  const binding = new SessionBindingService({ store, inFlightTurnIdByThread: new Map(), getSessionDirectory: () => "/work", notify: async () => {} });
  binding.subscribe((event) => transport.observeBinding(event));
  const delivery = new DecisionDeliveryService({ store, sessionOperationQueue: new SessionDecisionOperationQueue(),
    getSessionDirectory: (target) => target.currentCwd ?? target.pathKey,
    requireMessageTransport: () => transport, isBatchableDecision, createDecisionMessageSpec, createBatchDecisionMessageSpec,
    getExecpolicyAmendment, sendMessageSpec: (source, spec) => transport.sendMessageSpec(source, spec),
    editMessageSpec: (source, id, spec) => transport.editMessageSpec(source, id, spec) });
  const answers: Array<{ id: string; action: DecisionAction; kind: string | null; content: unknown }> = [];
  const commands = new DecisionCommandService({ store, decisionDelivery: delivery,
    codexClient: { resolveApproval: async (id, action, kind, content) => {
      assert.ok(tokens.delete(id), "the original request can be answered only once");
      answers.push({ id, action, kind, content });
      await afterAnswer();
    } }, sessionOwnershipService: { getSessionOwnershipPrompt: async () => { assert.fail("Web must not implicitly claim"); } },
    createMcpInputPromptSpec: () => { assert.fail("Web must edit its original card"); },
    sendLongSpec: async () => { assert.fail("Web must not send a chat-only prompt"); } });
  const api = new WebDecisionService({ store, commands, access: new SessionAccessService(store), ...runtime,
    runDispatch: (target, operation) => binding.runDispatch(target, operation) });
  let sequence = 0;
  async function create(overrides: Partial<Parameters<BridgeStore["createOrReplacePendingDecision"]>[0]> = {}) {
    const record = await store.createOrReplacePendingDecision({ sessionId: session.id, telegramChatId: "web:local",
      approvalId: `opaque-rpc-${sequence++}`, kind: "item/commandExecution/requestApproval", title: "Run command",
      summary: "command: yarn test", requiresUserInput: false, ...overrides });
    tokens.add(record.approvalId);
    await delivery.sendDecisionMessage(session, record);
    return (await store.getDecision(record.id))!;
  }
  return { store, session, api, tokens, answers, events, commands, delivery, binding, transport, create,
    disconnect: () => { connected = false; }, afterAnswer: (callback: () => Promise<void>) => { afterAnswer = callback; } };
}

test("Web restores all pending and awaiting-input cards chronologically without raw RPC or chat controls", async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  const b = await f.create({ kind: "mcpServer/elicitation/request", requiresUserInput: true, summary: "fields: value" });
  const c = await f.create({ kind: "mcpServer/elicitation/request", requiresUserInput: true, summary: "fields: other" });
  await f.store.resolveDecision(b.id, "awaitingInput");
  await f.store.resolveDecision(c.id, "awaitingInput");
  const result = await f.api.read("thread", undefined, () => {});
  result.assertCurrent();
  assert.deepEqual(result.snapshot.decisions.map((item) => item.decision!.id), [a, b, c]
    .sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id)).map((item) => item.id));
  assert.equal(result.snapshot.decisions.filter((item) => item.decision!.inputAllowed).length, 2);
  const json = JSON.stringify(result.snapshot);
  for (const forbidden of ["opaque-rpc", "telegramChatId", "telegramMessageId", "callbackData", "rollout"]) assert.equal(json.includes(forbidden), false);
  assert.ok(result.snapshot.decisions.every((item) => item.actions.length === 0));
  assert.equal(await f.store.getActiveSession("web:local"), null);
});

test("MCP accept waits without answering; valid JSON submission edits the same card to approved", async (t) => {
  const f = await fixture(t);
  const d = await f.create({ kind: "mcpServer/elicitation/request", requiresUserInput: true, summary: "fields: value" });
  const input = { threadId: "thread", decisionId: d.id };
  assert.deepEqual(await f.api.act({ ...input, action: "accept" }, () => {}), { accepted: true, decisionId: d.id, state: "awaitingInput" });
  assert.equal(f.answers.length, 0);
  assert.equal(f.events.at(-1)!.event.message!.decision!.inputAllowed, true);
  for (const content of [{}, [], null, Object.create({ value: "inherited" })]) {
    const result = await f.api.act({ ...input, action: "submit", content: content as Record<string, unknown> }, () => {});
    assert.equal(result.accepted, false);
    assert.equal(f.answers.length, 0);
  }
  const content = { value: "answer", nested: { safe: true } };
  assert.deepEqual(await f.api.act({ ...input, action: "submit", content }, () => {}), { accepted: true, decisionId: d.id, state: "approved" });
  assert.deepEqual(f.answers, [{ id: d.approvalId, action: "accept", kind: d.kind, content }]);
  const edits = f.events.filter((event) => event.event.message?.decision?.id === d.id);
  assert.equal(new Set(edits.map((event) => event.event.messageId)).size, 1);
  assert.deepEqual(edits.map((event) => event.event.message!.decision!.state), ["pending", "awaitingInput", "approved"]);
  assert.deepEqual(edits.at(-1)!.event.message!.decision!.availableActions, []);
  assert.match(edits.at(-1)!.event.message!.title, /^Approved · /);
});

test("Web decision actions use trusted command amendment and permission data; MCP waiting can decline or cancel", async (t) => {
  const cases: Array<{ kind: string; summary: string; action: DecisionAction; state: DecisionRecord["state"]; effective?: DecisionAction; content?: unknown; waiting?: boolean }> = [
    { kind: "item/commandExecution/requestApproval", summary: 'execpolicyAmendment: ["yarn","test"]\navailableDecisions: acceptWithExecpolicyAmendment, decline', action: "acceptForSession", effective: "acceptWithExecpolicyAmendment", content: { execpolicyAmendment: ["yarn", "test"] }, state: "approvedForSession" },
    { kind: "item/permissions/requestApproval", summary: 'permissions: {"network":{"enabled":true}}', action: "accept", content: { permissions: { network: { enabled: true } } }, state: "approved" },
    { kind: "item/fileChange/requestApproval", summary: "grantRoot: /work", action: "decline", state: "rejected" },
    { kind: "mcpServer/elicitation/request", summary: "fields: value", action: "cancel", state: "cancelled", waiting: true },
    { kind: "mcpServer/elicitation/request", summary: "fields: value", action: "decline", state: "rejected", waiting: true }
  ];
  for (const row of cases) {
    const f = await fixture(t);
    const d = await f.create({ kind: row.kind, summary: row.summary, requiresUserInput: !!row.waiting });
    if (row.waiting) await f.store.resolveDecision(d.id, "awaitingInput");
    assert.equal((await f.api.act({ threadId: "thread", decisionId: d.id, action: row.action }, () => {})).state, row.state);
    assert.deepEqual(f.answers, [{ id: d.approvalId, action: row.effective ?? row.action, kind: row.kind, content: row.content }]);
  }
});

test("unsupported kinds, restricted actions, terminal cards and premature input never answer", async (t) => {
  const f = await fixture(t);
  for (const overrides of [{ kind: "unknown/request" }, { summary: "availableDecisions: decline" },
    { kind: "mcpServer/elicitation/request", requiresUserInput: true }]) {
    const d = await f.create(overrides);
    const action = overrides.requiresUserInput ? "submit" : "accept";
    await assert.rejects(f.api.act({ threadId: "thread", decisionId: d.id, action, ...(action === "submit" ? { content: {} } : {}) } as never,
      () => {}), new WebDecisionError("invalid_action"));
  }
  const terminal = await f.create();
  await f.store.resolveDecision(terminal.id, "approved");
  await assert.rejects(f.api.act({ threadId: "thread", decisionId: terminal.id, action: "accept" }, () => {}), new WebDecisionError("invalid_action"));
  assert.deepEqual(f.answers, []);
});

test("foreign targets, unowned sessions and stale leases do not select, claim or mutate", async (t) => {
  const f = await fixture(t);
  const other = await f.store.upsertDiscoveredSession({ telegramChatId: "123", codexThreadId: "other", pathKey: "/other" });
  const foreign = await f.create({ sessionId: other.id });
  await assert.rejects(f.api.act({ threadId: "thread", decisionId: foreign.id, action: "accept" }, () => {}), new WebDecisionError("unavailable"));
  await assert.rejects(f.api.read("other", undefined, () => {}), new SessionAccessError("not_owner"));
  const d = await f.create();
  await assert.rejects(f.api.act({ threadId: "thread", decisionId: d.id, action: "accept", leaseVersion: 0 }, () => {}), new SessionAccessError("stale"));
  assert.equal((await f.store.getDecision(d.id))!.state, "pending");
  // A normal handoff cannot skip pending approvals. Retire it first to test
  // the ownership guard against a previously displayed card.
  await f.store.resolveDecision(d.id, "stale");
  f.store.requestSessionHandoff(f.session.id, "123", true);
  await assert.rejects(f.api.act({ threadId: "thread", decisionId: d.id, action: "accept" }, () => {}), new SessionAccessError("not_owner"));
  assert.deepEqual(f.answers, []);
  assert.equal((await f.store.getDecision(d.id))!.state, "stale");
  assert.equal(await f.store.getActiveSession("web:local"), null);
});

test("lost token and disconnected runtime disable controls without inventing an approved result", async (t) => {
  for (const mode of ["token", "runtime"] as const) {
    const f = await fixture(t);
    const d = await f.create();
    if (mode === "token") f.tokens.delete(d.approvalId); else f.disconnect();
    const card = (await f.api.read("thread", undefined, () => {})).snapshot.decisions[0]!;
    assert.equal(card.decision!.state, mode === "token" ? "stale" : "pending");
    assert.equal(card.decision!.unavailableReason, mode === "token" ? "original_request_inactive" : "runtime_disconnected");
    assert.deepEqual(card.decision!.availableActions, []);
    await assert.rejects(f.api.act({ threadId: "thread", decisionId: d.id, action: "accept" }, () => {}), new WebDecisionError(mode === "token" ? "inactive" : "disconnected"));
    assert.equal((await f.store.getDecision(d.id))!.state, "pending");
    assert.deepEqual(f.answers, []);
  }
});

test("concurrent duplicate actions cannot answer twice; revoked competing request never answers", async (t) => {
  for (const revoked of [false, true]) {
    const f = await fixture(t);
    const d = await f.create();
    let entered!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    f.afterAnswer(async () => { entered(); await new Promise<void>((resolve) => { finish = resolve; }); });
    const first = f.api.act({ threadId: "thread", decisionId: d.id, action: "accept" }, () => {});
    await ready;
    let current = true;
    const second = f.api.act({ threadId: "thread", decisionId: d.id, action: "decline" }, () => { if (!current) throw new Error("revoked"); });
    const denied = assert.rejects(second);
    if (revoked) current = false;
    finish();
    assert.equal((await first).accepted, true);
    await denied;
    assert.equal(f.answers.length, 1);
  }
});

test("shared command queue rechecks a waiting Web action before the original response", async (t) => {
  const f = await fixture(t);
  const d = await f.create();
  let entered!: () => void;
  let finish!: () => void;
  let revoked = false;
  let reads = 0;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const commands = new DecisionCommandService({ store: new Proxy(f.store, {
    get(target, key) {
      if (key === "getSessionById") return async (id: string) => {
        if (++reads === 1) { entered(); await new Promise<void>((resolve) => { finish = resolve; }); }
        return target.getSessionById(id);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }), decisionDelivery: f.delivery, codexClient: { resolveApproval: async (id) => { assert.ok(f.tokens.delete(id)); } },
    sessionOwnershipService: { getSessionOwnershipPrompt: async () => null },
    createMcpInputPromptSpec: () => assert.fail("not an MCP request"), sendLongSpec: async () => {} });
  const first = commands.handle(d.id, "accept", "web:local", { sessionId: f.session.id, threadId: "thread", assertCurrent: () => {
    if (revoked) throw new Error("window revoked");
  } });
  const firstDenied = assert.rejects(first, /window revoked/);
  await ready;
  const second = commands.handle(d.id, "decline", "web:local", { sessionId: f.session.id, threadId: "thread", assertCurrent: () => {
    if (revoked) throw new Error("window revoked");
  } });
  const secondDenied = assert.rejects(second, /window revoked/);
  revoked = true;
  finish();
  await firstDenied;
  await secondDenied;
  assert.ok(f.tokens.has(d.approvalId));
  assert.equal((await f.store.getDecision(d.id))!.state, "pending");
});

test("legacy chat decisions still check ownership and active selection", async (t) => {
  const f = await fixture(t);
  let ownershipChecks = 0;
  const commands = new DecisionCommandService({ store: f.store, decisionDelivery: f.delivery,
    codexClient: { resolveApproval: async () => { assert.fail("unselected chat must not answer"); } },
    sessionOwnershipService: { getSessionOwnershipPrompt: async () => { ownershipChecks++; return null; } },
    createMcpInputPromptSpec: () => assert.fail("not an MCP request"), sendLongSpec: async () => {} });
  const d = await f.create();
  assert.equal((await commands.handle(d.id, "accept", "web:local")).ok, false);
  assert.equal(ownershipChecks, 1);
  assert.equal((await f.store.getDecision(d.id))!.state, "stale");
  assert.deepEqual(f.answers, []);
});

test("an upstream response failure never becomes success and its consumed token is not retried", async (t) => {
  const f = await fixture(t);
  const d = await f.create();
  f.afterAnswer(async () => { throw new Error("response outcome unknown"); });
  const input = { threadId: "thread", decisionId: d.id, action: "accept" as const };
  await assert.rejects(f.api.act(input, () => {}), /response outcome unknown/);
  assert.equal((await f.store.getDecision(d.id))!.state, "pending");
  await assert.rejects(f.api.act(input, () => {}), new WebDecisionError("inactive"));
  assert.equal(f.answers.length, 1);
});

test("decision reads and commands reject a native thread reassociation instead of answering an old card", async (t) => {
  const f = await fixture(t);
  const d = await f.create();
  const reader = new WebDecisionService({ access: new SessionAccessService(f.store), commands: f.commands,
    store: { getDecision: (id) => f.store.getDecision(id), listOpenDecisions: async (id) => {
      await f.store.updateSessionThreadId(f.session.id, "new-thread"); return f.store.listOpenDecisions(id);
    } }, isRuntimeConnected: () => true, isApprovalPending: () => true, runDispatch: (_session, operation) => operation() });
  await assert.rejects(reader.read("thread", undefined, () => {}), new SessionAccessError("unavailable"));
  const guard = { sessionId: f.session.id, threadId: "thread", assertCurrent: () => {} };
  assert.equal((await f.commands.handle(d.id, "accept", "web:local", guard)).ok, false);
  const mcp = await f.create({ kind: "mcpServer/elicitation/request", requiresUserInput: true, summary: "fields: value" });
  await f.store.resolveDecision(mcp.id, "awaitingInput");
  assert.equal((await f.commands.submitInput(mcp.id, { value: "answer" }, guard)).ok, false);
  assert.deepEqual(f.answers, []);
});

test("after upstream dispatch, window replacement cannot stop bookkeeping or cause a false refusal", async (t) => {
  const f = await fixture(t);
  const d = await f.create();
  let current = true;
  f.afterAnswer(async () => {
    current = false;
    const request = await f.binding.request("123", f.session.id);
    assert.equal(request.outcome!.pending, true, "shared dispatch fence protects handoff while responding");
  });
  const receipt = await f.api.act({ threadId: "thread", decisionId: d.id, action: "accept" }, () => { if (!current) throw new Error("revoked"); });
  assert.deepEqual(receipt, { accepted: true, decisionId: d.id, state: "approved" });
  assert.equal((await f.store.getDecision(d.id))!.state, "approved");
  assert.equal(f.answers.length, 1);
  assert.equal(f.store.getSessionBindingById(f.store.getSessionLease(f.session.id)!.ownerBindingId!)!.sourceId, "123");
});

test("async snapshot reads and native card preparation cannot deliver after permission revocation", async (t) => {
  const f = await fixture(t);
  const d = await f.create();
  let current = true;
  const guarded = new WebDecisionService({ access: new SessionAccessService(f.store), commands: f.commands,
    store: { getDecision: (id) => f.store.getDecision(id), listOpenDecisions: async (id) => { current = false; return f.store.listOpenDecisions(id); } },
    isRuntimeConnected: () => true, isApprovalPending: (id) => f.tokens.has(id), runDispatch: (_session, operation) => operation() });
  await assert.rejects(guarded.read("thread", undefined, () => { if (!current) throw new Error("revoked"); }), /revoked/);
  const transport = new WebMessageTransport({ getSessionById: (id) => f.store.getSessionById(id),
    getSessionLease: (id) => f.store.getSessionLease(id), getSessionBindingById: (id) => f.store.getSessionBindingById(id),
    getActiveTurnRoute: (id) => f.store.getActiveTurnRoute(id), getDecision: async (id) => {
      f.store.requestSessionHandoff(f.session.id, "123", true); return f.store.getDecision(id);
    } }, { isRuntimeConnected: () => true, isApprovalPending: () => true });
  transport.subscribe(() => assert.fail("revoked card must not reach a subscriber"));
  assert.equal(await transport.sendMessageSpec("web:local", createDecisionMessageSpec(f.session, d, [])), null);
});
