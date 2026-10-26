import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("notification worker addresses the originating tab only and does not reopen a closed page", async () => {
  const handlers = new Map<string, (event: any) => void>();
  const focused: string[] = [], messages: unknown[] = [], clientIds: string[] = [];
  let alive = true;
  const client = { type: "window", id: "client-a", focus: async () => { focused.push("client-a"); },
    postMessage: (value: unknown) => messages.push(value) };
  const worker = { addEventListener: (name: string, handler: (event: any) => void) => { handlers.set(name, handler); },
    skipWaiting: () => {}, clients: { claim: async () => {}, get: async (id: string) => {
      assert.equal(id, "client-a"); return alive ? client : undefined;
    } } };
  runInNewContext(await readFile(new URL("../web/public/notifications-worker.js", import.meta.url), "utf8"), { self: worker });
  handlers.get("message")!({ data: { type: "bridge-notification-client" }, source: client,
    ports: [{ postMessage: (id: string) => clientIds.push(id) }] });
  assert.deepEqual(clientIds, ["client-a"]);
  let pending: Promise<void> = Promise.resolve(), closed = 0;
  const click = () => handlers.get("notificationclick")!({ notification: {
    data: { clientId: "client-a", threadId: "thread-b" }, close: () => { closed++; }
  }, waitUntil: (value: Promise<void>) => { pending = value; } });
  click(); await pending;
  assert.deepEqual(focused, ["client-a"]);
  assert.equal(JSON.stringify(messages), JSON.stringify([{ type: "bridge-notification-open", threadId: "thread-b" }]));
  alive = false; click(); await pending;
  assert.deepEqual(focused, ["client-a"]);
  assert.equal(messages.length, 1);
  assert.equal(closed, 2);
  assert.equal(handlers.has("push"), false);
  assert.equal(handlers.has("fetch"), false);
});
