import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeRuntimePort, BridgeTurnControlPort } from "../src/bridge/contracts.js";
import { handleTurnAction } from "../src/bridge/interactions/handlers/turns.js";
import { RuntimeCommandService, type RuntimeCommandDependencies } from "../src/bridge/runtime/commands.js";
import { RuntimeController } from "../src/bridge/runtime/controller.js";
import { createMessage } from "../src/bridge/messages/factory.js";

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
  }
});

test("restart does not schedule a restart when context lookup fails", async () => {
  const service = new RuntimeCommandService(dependencies({
    getActiveSessionContext: async () => { throw new Error("lookup failed"); }
  }));
  await assert.rejects(service.restart("chat-1"), /lookup failed/);
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
  assert.equal((await service.connect("chat-1")).title, "Codex · /workspace/project");
  assert.equal((await service.disconnect("chat-1")).title, "Codex · /workspace/project");
  assert.deepEqual(calls, ["chat-1", "chat-1"]);
});

test("restart buttons use the conversation rather than the selector surface", async () => {
  for (const platform of ["slack", "telegram"] as const) {
    const calls: string[] = [];
    const reply = createMessage({ kind: "system", titleLabel: "Codex" });
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
