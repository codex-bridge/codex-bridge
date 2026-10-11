import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/codex/client.js";
import { AuthReconnectCoordinator } from "../src/codex/auth-reconnect.js";
import { ThreadRuntimeState } from "../src/codex/thread-runtime-state.js";
import type { AppConfig } from "../src/config/index.js";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture() {
  const sent: unknown[] = [];
  const tokens = new Map<string, { id: string | number; method: string }>();
  const state = {
    approvalTokens: tokens,
    connection: {
      isInitialized: () => true,
      sendResponse: async (id: string | number, result: unknown) => {
        sent.push({ id, result });
      }
    },
    connect: async () => { throw new Error("must not reconnect to answer approval"); }
  };
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, state);
  return { client, sent, tokens };
}
const method = "item/commandExecution/requestApproval";

test("approval uses original string RPC id and is single use", async () => {
  const { client, sent, tokens } = fixture();
  tokens.set("opaque", { id: "rpc-17", method });
  await client.resolveApproval("opaque", "accept", method);
  assert.deepEqual(sent, [{ id: "rpc-17", result: { decision: "accept" } }]);
  await assert.rejects(client.resolveApproval("opaque", "accept", method), /original connection/);
  assert.equal(sent.length, 1);
});

test("old approval cannot answer a reused RPC id on a new connection", async () => {
  const { client, sent, tokens } = fixture();
  tokens.set("old", { id: 1, method });
  tokens.clear();
  tokens.set("new", { id: 1, method });
  await assert.rejects(client.resolveApproval("old", "accept", method), /original connection/);
  await assert.rejects(client.resolveApproval("new", "accept", "item/fileChange/requestApproval"), /original connection/);
  assert.deepEqual(sent, []);
  await client.resolveApproval("new", "decline", method);
  assert.deepEqual(sent, [{ id: 1, result: { decision: "decline" } }]);
});

test("permission approval grants only the requested profile with the selected scope", async () => {
  const { client, sent, tokens } = fixture();
  const permissionMethod = "item/permissions/requestApproval";
  const requested = {
    network: { hosts: ["api.example.com"] },
    fileSystem: { paths: ["/tmp/export"] }
  };
  tokens.set("turn", { id: "rpc-turn", method: permissionMethod });
  await client.resolveApproval("turn", "accept", permissionMethod, { permissions: requested });
  tokens.set("session", { id: "rpc-session", method: permissionMethod });
  await client.resolveApproval("session", "acceptForSession", permissionMethod, { permissions: requested });
  tokens.set("decline", { id: "rpc-decline", method: permissionMethod });
  await client.resolveApproval("decline", "decline", permissionMethod, { permissions: requested });
  assert.deepEqual(sent, [
    { id: "rpc-turn", result: { permissions: requested, scope: "turn" } },
    { id: "rpc-session", result: { permissions: requested, scope: "session" } },
    { id: "rpc-decline", result: { permissions: {}, scope: "turn" } }
  ]);
});

test("MCP elicitation responses use the complete 0.158 response shape", async () => {
  const { client, sent, tokens } = fixture();
  const elicitationMethod = "mcpServer/elicitation/request";
  tokens.set("cancel", { id: "rpc-cancel", method: elicitationMethod });
  await client.resolveApproval("cancel", "cancel", elicitationMethod);
  tokens.set("accept", { id: "rpc-accept", method: elicitationMethod });
  await client.resolveApproval("accept", "accept", elicitationMethod, { value: "confirmed" });

  assert.deepEqual(sent, [
    { id: "rpc-cancel", result: { action: "cancel", content: null, _meta: null } },
    {
      id: "rpc-accept",
      result: { action: "accept", content: { value: "confirmed" }, _meta: null }
    }
  ]);
});

test("menu read-only status never falls back to thread resume", async () => {
  const methods: string[] = [];
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    connect: async () => {},
    request: async (method: string) => { methods.push(method); throw new Error("unknown method thread/read"); }
  });
  await assert.rejects(client.readThreadStatus("thread", "/tmp", { readOnly: true }));
  assert.deepEqual(methods, ["thread/read"]);
});

test("thread settings events supply actual model and effort omitted by thread read", async () => {
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    threadRuntimeState: new ThreadRuntimeState(), notificationListeners: new Set(),
    connect: async () => {},
    request: async () => ({ thread: { id: "t", cwd: "/tmp" } })
  });
  const internal = client as unknown as { handleNotification(event: unknown): void };
  internal.handleNotification({ method: "thread/settings/updated", params: { threadId: "t",
    threadSettings: { model: "actual-model", modelProvider: "openai", effort: "ultra", serviceTier: null } } });
  const status = await client.readThreadStatus("t", "/tmp", { readOnly: true });
  assert.equal(status.model, "actual-model");
  assert.equal(status.reasoningEffort, "ultra");
  internal.handleNotification({ method: "thread/settings/updated", params: { threadId: "t",
    threadSettings: { model: "changed", modelProvider: "openai", effort: null, serviceTier: null } } });
  assert.equal((await client.readThreadStatus("t")).reasoningEffort, null);
});

test("model reroute events update the observed thread model", async () => {
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    threadRuntimeState: new ThreadRuntimeState(), notificationListeners: new Set()
  });
  const internal = client as unknown as { handleNotification(event: unknown): void };
  internal.handleNotification({ method: "thread/settings/updated", params: { threadId: "t",
    threadSettings: { model: "requested-model", modelProvider: "openai", effort: "high" } } });
  internal.handleNotification({ method: "model/rerouted", params: {
    threadId: "t", turnId: "turn", fromModel: "requested-model", toModel: "safe-model", reason: "highRiskCyberActivity"
  } });
  assert.equal(client.getObservedThreadModel("t"), "safe-model");
});

test("thread read exposes Codex activity state for lease reconciliation", async () => {
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    threadRuntimeState: new ThreadRuntimeState(),
    connect: async () => {},
    request: async () => ({ thread: { id: "t", status: { type: "inProgress" } } })
  });

  const status = await client.readThreadStatus("t", "/tmp", { readOnly: true });

  assert.equal(status.activity, "running");
  assert.equal(status.activityType, "inProgress");
});

test("late exit of a closed process cannot invalidate its replacement connection", async () => {
  const script = `
    const readline = require('node:readline');
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
    readline.createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id !== undefined) console.log(JSON.stringify({id:request.id,result:{thread:{id:'t'}}}));
    });
  `;
  const client = new CodexAppServerClient({ codexTransport: "stdio", codexAppServerCommand: process.execPath,
    codexAppServerArgs: ["-e", script], codexSkillExtraRoots: [] } as unknown as AppConfig);
  let lost = 0;
  client.onNotification((event) => { if (event.method === "bridge/connection/lost") lost++; });
  try {
    await client.connect();
    await client.close();
    await client.connect();
    await sleep(200);
    assert.equal(lost, 1);
    const state = client as unknown as { connection: { isInitialized(): boolean } };
    assert.equal(state.connection.isInitialized(), true);
    assert.equal((await client.readThreadStatus("t")).threadId, "t");
  } finally { await client.close(); await sleep(150); }
});

test("auth reconnect announces completion only after the replacement server connects", async () => {
  const sequence: string[] = [];
  const coordinator = new AuthReconnectCoordinator({
    authFilePath: "/tmp/auth.json",
    isIdle: () => true,
    notifyReconnected: () => { sequence.push("bridge/auth/reconnected"); },
    reconnect: async () => { sequence.push("reconnect"); },
    transport: "stdio"
  });
  const internal = coordinator as unknown as {
    authReconnectPending: boolean;
    reconnectAfterAuthChange(): void;
    authReconnectPromise: Promise<void> | null;
  };

  internal.authReconnectPending = true;
  internal.reconnectAfterAuthChange();
  await internal.authReconnectPromise;

  assert.deepEqual(sequence, ["reconnect", "bridge/auth/reconnected"]);
});

test("provider config changes reload Codex env on the next idle snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-provider-reconnect-test-"));
  const previousCodexHome = process.env.CODEX_HOME;
  const script = `
    const fs = require('node:fs');
    const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      if (request.method === 'config/read') {
        const provider = fs.readFileSync(process.env.CODEX_CONFIG_PROVIDER_FILE, 'utf8').trim();
        console.log(JSON.stringify({id: request.id, result: {
          config: {model: process.env.CODEX_TEST_PROVIDER, model_provider: provider}
        }}));
        return;
      }
      console.log(JSON.stringify({id: request.id, result: {}}));
    });
  `;
  process.env.CODEX_HOME = directory;
  const previousConfigProviderFile = process.env.CODEX_CONFIG_PROVIDER_FILE;
  process.env.CODEX_CONFIG_PROVIDER_FILE = join(directory, "provider");
  try {
    await writeFile(join(directory, ".env"), "CODEX_TEST_PROVIDER=openai\n");
    await writeFile(join(directory, "provider"), "openai\n");
    const client = new CodexAppServerClient({
      codexTransport: "stdio",
      codexAppServerCommand: process.execPath,
      codexAppServerArgs: ["-e", script]
    } as unknown as AppConfig);
    try {
      const first = await client.readCodexConfigSnapshot("/workspace/project");
      assert.equal(first.modelProvider, "openai");
      assert.equal(first.model, "openai");
      await writeFile(join(directory, "provider"), "codex-lb\n");
      await writeFile(join(directory, ".env"), "CODEX_TEST_PROVIDER=codex-lb\n");
      const second = await client.readCodexConfigSnapshot("/workspace/project");
      assert.equal(second.modelProvider, "codex-lb");
      assert.equal(second.model, "codex-lb");
    } finally {
      await client.close();
    }
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousConfigProviderFile === undefined) delete process.env.CODEX_CONFIG_PROVIDER_FILE;
    else process.env.CODEX_CONFIG_PROVIDER_FILE = previousConfigProviderFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("new thread provider mismatch fails before Bridge persistence", async () => {
  let reconnectCount = 0;
  const client = Object.assign(Object.create(CodexAppServerClient.prototype) as CodexAppServerClient, {
    config: { codexServiceName: "codex-bridge" },
    threadRuntimeState: new ThreadRuntimeState(),
    providerReconnect: {
      markPending: () => {},
      reconnectWhenIdle: async () => { reconnectCount += 1; }
    },
    connect: async () => {},
    readCodexConfigSnapshot: async () => ({
      cwd: "/workspace/project",
      model: "model",
      modelProvider: "openai",
      reasoningEffort: null,
      reasoningSummary: null,
      approvalPolicy: null,
      approvalsReviewer: null,
      sandboxPolicy: null,
      serviceTier: null,
      personality: null,
      origins: {},
      layerVersions: []
    }),
    request: async (method: string) => method === "thread/start"
      ? { thread: { id: "thread-new", modelProvider: "codex-lb" } }
      : {}
  });

  await assert.rejects(client.startThread("/workspace/project"), /provider mismatch after thread start/);
  assert.equal(reconnectCount, 1);
});

test("real RPC approval events remain isolated across process replacement", async () => {
  const script = `
    const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (!request.method) return;
      if (request.id !== undefined) console.log(JSON.stringify({id:request.id,result:{thread:{id:'t'}}}));
      if (request.method === 'thread/read') console.log(JSON.stringify({id:1,
        method:'item/commandExecution/requestApproval',params:{threadId:'child',turnId:'child-turn',command:'pwd'}}));
    });
  `;
  const client = new CodexAppServerClient({ codexTransport: "stdio", codexAppServerCommand: process.execPath,
    codexAppServerArgs: ["-e", script], codexSkillExtraRoots: [] } as unknown as AppConfig);
  const nextApproval = () => new Promise<string>((resolve) => {
    const unsubscribe = client.onApprovalRequest((request) => { unsubscribe(); resolve(request.requestId); });
  });
  try {
    const first = nextApproval();
    await client.readThreadStatus("t");
    const oldToken = await first;
    await client.close();
    const second = nextApproval();
    await client.readThreadStatus("t");
    const newToken = await second;
    assert.notEqual(oldToken, newToken);
    await assert.rejects(client.resolveApproval(oldToken, "accept", method), /original connection/);
    await client.resolveApproval(newToken, "decline", method);
    await assert.rejects(client.resolveApproval(newToken, "decline", method), /original connection/);
  } finally { await client.close(); }
});
