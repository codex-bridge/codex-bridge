import assert from "node:assert/strict";
import test from "node:test";

import { AppServerConnection, AppServerRpcError } from "../src/codex/app-server-connection.js";

test("RPC errors retain request method, code, data, and the original message", async () => {
  const script = `
    const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') {
        console.log(JSON.stringify({id: request.id, result: {}}));
      } else if (request.method === 'thread/read') {
        console.log(JSON.stringify({id: request.id, error: {
          code: -32004, message: 'thread not found', data: {threadId: 'missing', reason: 'not_loaded'}
        }}));
      } else if (request.method === 'thread/resume') {
        console.log(JSON.stringify({id: request.id, error: {message: 'resume failed'}}));
      }
    });
  `;
  const connection = new AppServerConnection({
    args: ["-e", script],
    command: process.execPath,
    onDisconnected: () => {},
    onInitialized: () => {},
    onNotification: () => {},
    onServerRequest: () => {},
    readEnvironment: async () => ({}),
    transport: "stdio"
  });

  try {
    await connection.connect();
    await assert.rejects(connection.request("thread/read", { threadId: "missing" }), (error: unknown) => {
      assert.ok(error instanceof AppServerRpcError);
      assert.equal(error.message, "thread not found");
      assert.equal(error.method, "thread/read");
      assert.equal(error.code, -32004);
      assert.deepEqual(error.data, { threadId: "missing", reason: "not_loaded" });
      return true;
    });
    await assert.rejects(connection.request("thread/resume", { threadId: "missing" }), (error: unknown) => {
      assert.ok(error instanceof AppServerRpcError);
      assert.equal(error.message, "resume failed");
      assert.equal(error.method, "thread/resume");
      assert.equal(error.code, undefined);
      assert.equal(error.data, undefined);
      return true;
    });
  } finally {
    await connection.close("Test completed.");
  }
});
