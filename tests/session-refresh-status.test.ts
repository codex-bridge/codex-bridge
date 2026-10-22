import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStore } from "../src/store/index.js";
import { SessionRefreshStatusService, type RefreshStatusEntry } from "../src/bridge/sessions/refresh-status.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";

for (const repost of ["none", "success", "failure"] as const) {
  test(`refresh closure retains the last delivered session context after ${repost} repost`, async () => {
    const store = new BridgeStore(":memory:");
    try {
      const session = await store.upsertDiscoveredSession({
        telegramChatId: "chat", codexThreadId: "thread", pathKey: "/work/original"
      });
      const entries = new Map<string, RefreshStatusEntry>();
      const sent: MessageSpec[] = [];
      const edited: MessageSpec[] = [];
      let deliver = true;
      const service = new SessionRefreshStatusService({
        store: { getSessionLease: () => ({ state: "external_unknown", version: 2 }) as never },
        refreshStatusMessageBySession: entries,
        getSessionDirectory: (value) => value.currentCwd ?? value.pathKey,
        refreshSessionCallback: (id, version) => `refresh:${id}:${version}`,
        sendSpecAndGetLastMessage: async (_chat, spec) => {
          sent.push(spec);
          return deliver ? { messageId: "message", text: "" } : null;
        },
        editMessageSpec: async (_chat, _message, spec) => { edited.push(spec); return deliver; },
        requireMessageTransport: () => { throw new Error("Unexpected fallback"); }
      });
      await service.post("chat", session);
      assert.equal(sent[0]?.title, "Codex · /work/original");
      assert.equal(sent[0]?.session?.id, session.id);
      if (repost !== "none") {
        deliver = repost === "success";
        await service.post("chat", { ...session, currentCwd: "/work/changed" });
      }
      await service.remove("other-chat", session.id);
      assert.equal(entries.size, 1);
      deliver = true;
      await service.remove("chat", session.id);
      const expectedDirectory = repost === "success" ? "/work/changed" : "/work/original";
      assert.equal(edited.at(-1)?.title, `Refresh Status Closed · ${expectedDirectory}`);
      assert.deepEqual(edited.at(-1)?.session, { id: session.id, directory: expectedDirectory });
      assert.deepEqual(edited.at(-1)?.actions, []);
      assert.equal(entries.size, 0);
      const count = edited.length;
      await service.remove("chat", session.id);
      assert.equal(edited.length, count);
    } finally { store.close(); }
  });
}
