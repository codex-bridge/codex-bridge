import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/codex/client.js";
import type { AppConfig } from "../src/config/index.js";

test("unsupported server requests return RPC errors with original IDs and leave the connection usable", { timeout: 10_000 }, async (t) => {
  const methods = [
    "item/tool/requestUserInput", "item/tool/call", "account/chatgptAuthTokens/refresh",
    "attestation/generate", "currentTime/read", "applyPatchApproval", "execCommandApproval", "future/serverRequest"
  ];
  const requests = methods.map((method, index) => ({
    id: index === 0 ? 0 : `rpc-${index}`, method,
    params: { threadId: "thread", turnId: "turn", itemId: "item", questions: [] }
  }));
  const script = `
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if(request.method === 'initialize') {
        send({id:request.id,result:{userAgent:'fixture/0.170.0'}});
      } else if(request.method === 'initialized') {
        for(const request of ${JSON.stringify(requests)}) send(request);
      } else if('error' in request || 'result' in request) {
        send({method:'test/response',params:request});
      } else if(request.id !== undefined) {
        send({id:request.id,result:{thread:{id:'thread',status:{type:'idle'}}}});
      }
    });
  `;
  const client = new CodexAppServerClient({ codexTransport: "stdio", codexAppServerCommand: process.execPath,
    codexAppServerArgs: ["-e", script], codexSkillExtraRoots: [] } as unknown as AppConfig);
  t.after(() => client.close());
  let receivedAll: () => void = () => {};
  const arrived = new Promise<void>((resolve) => { receivedAll = resolve; });
  const responses: unknown[] = [];
  let approvals = 0;
  client.onApprovalRequest(() => { approvals++; });
  client.onNotification((notification) => {
    if(notification.method !== "test/response") return;
    responses.push(notification.params);
    if(responses.length === requests.length) receivedAll();
  });
  await client.connect();
  const [status] = await Promise.all([client.readThreadStatus("thread"), arrived]);
  assert.equal(status.threadId, "thread");
  assert.equal(approvals, 0);
  assert.deepEqual(responses, requests.map(({ id, method }) => ({
    id, error: { code: -32601, message: `Bridge does not support server request: ${method}` }
  })));
});
