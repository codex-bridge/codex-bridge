import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeRuntimePort, BridgeTurnControlPort } from "../src/bridge/contracts.js";
import { handleTurnAction } from "../src/bridge/interactions/handlers/turns.js";
import { RuntimeCommandService, type RuntimeCommandDependencies } from "../src/bridge/runtime/commands.js";
import { RuntimeController } from "../src/bridge/runtime/controller.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import { helpAction } from "../src/bridge/messages/actions.js";

function dependencies(overrides: Partial<RuntimeCommandDependencies>): RuntimeCommandDependencies {
  return {
    runtime: new RuntimeController(),
    codexClient: {} as RuntimeCommandDependencies["codexClient"],
    requestRestart: () => { throw new Error("Unexpected restart"); },
    getActiveSessionContext: async () => undefined,
    attachCodexListeners: () => {},
    detachCodexListeners: () => {},
    discoverSessions: async () => {},
    clearDisconnectedState: async () => {},
    getSeedChatIds: () => [],
    ensureSeedChats: async () => {},
    listSessionsForPolling: async () => 0,
    reconcileRecoveredTurnState: async () => {},
    ...overrides
  };
}

test("bootstrap and manual connect register request listeners before initializing Codex", async () => {
  for (const mode of ["bootstrap", "manual"] as const) {
    const events: string[] = [];
    const service = new RuntimeCommandService(dependencies({
      attachCodexListeners: () => { events.push("listen"); },
      codexClient: { connect: async () => { events.push("initialize"); } } as RuntimeCommandDependencies["codexClient"]
    }));
    if (mode === "bootstrap") await service.bootstrap(); else await service.connect("chat");
    assert.deepEqual(events, ["listen", "initialize"]);
  }
});

test("failed initialization detaches early request listeners", async () => {
  for (const mode of ["bootstrap", "manual"] as const) {
    const events: string[] = [];
    const service = new RuntimeCommandService(dependencies({
      attachCodexListeners: () => { events.push("listen"); },
      detachCodexListeners: () => { events.push("detach"); },
      codexClient: { connect: async () => { throw new Error("init failed"); } } as RuntimeCommandDependencies["codexClient"]
    }));
    await assert.rejects(mode === "bootstrap" ? service.bootstrap() : service.connect("chat"), /init failed/);
    assert.deepEqual(events, ["listen", "detach"]);
  }
});

test("restart resolves the initiating conversation before requesting a restart", async () => {
  for (const session of [{ id: "session-1", directory: "/workspace/project" }, undefined]) {
    const calls: string[] = [];
    const service = new RuntimeCommandService(dependencies({
      getActiveSessionContext: async (chatId) => { calls.push(chatId); return session; },
      requestRestart: () => { calls.push("restart"); }
    }));
    const reply = await service.restart("slack:team:channel:thread");
    assert.deepEqual(calls, ["slack:team:channel:thread", "restart"]);
    assert.equal(reply.title, session ? "Codex · /workspace/project" : "Codex");
    assert.deepEqual(reply.body, [{ type: "text", text: "Restart requested.\nThe bot should be back in a few seconds." }]);
    assert.deepEqual(reply.actions, [helpAction()]);
  }
});

test("restart does not schedule a restart when context lookup fails", async () => {
  const service = new RuntimeCommandService(dependencies({
    getActiveSessionContext: async () => { throw new Error("lookup failed"); }
  }));
  await assert.rejects(service.restart("chat-1"), /lookup failed/);
});

test("runtime command replies retain only Help for connected and disconnected states", async () => {
  const service = new RuntimeCommandService(dependencies({
    codexClient: {
      connect: async () => {}, close: async () => {}
    } as RuntimeCommandDependencies["codexClient"],
    requestRestart: () => {}
  }));
  const replies = [
    await service.disconnect("chat"),
    await service.connect("chat"),
    await service.connect("chat"),
    await service.restart("chat"),
    await service.disconnect("chat")
  ];
  for (const reply of replies) assert.deepEqual(reply.actions, [helpAction()]);
});

test("runtime transition replies preserve the initiating session directory", async () => {
  const runtime = new RuntimeController();
  runtime.transition("connecting");
  const calls: string[] = [];
  const service = new RuntimeCommandService(dependencies({
    runtime,
    getActiveSessionContext: async (chatId) => {
      calls.push(chatId);
      return { id: "session-1", directory: "/workspace/project" };
    }
  }));
  for (const reply of [await service.connect("chat-1"), await service.disconnect("chat-1")]) {
    assert.equal(reply.title, "Codex · /workspace/project");
    assert.deepEqual(reply.actions, [helpAction()]);
  }
  assert.deepEqual(calls, ["chat-1", "chat-1"]);
});

test("restart buttons use the conversation rather than the selector surface", async () => {
  for (const platform of ["slack", "telegram"] as const) {
    const calls: string[] = [];
    const reply = createMessage({ scope: "global", kind: "system", titleLabel: "Codex" });
    const service = {
      restartServiceMessage: async (chatId: string) => { calls.push(chatId); return reply; }
    } as unknown as BridgeRuntimePort & BridgeTurnControlPort;
    const delivery = await handleTurnAction(service, {
      platform, conversationId: "conversation-1", surfaceId: "surface-1"
    }, { type: "runtime.restart" });
    assert.deepEqual(calls, ["conversation-1"]);
    assert.deepEqual(delivery, { mode: "send", target: "conversation", message: reply });
  }
});
