import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CodexAppServerClient, type AppServerApprovalRequest } from "../src/codex/client.js";
import type { AppConfig } from "../src/config/index.js";
import { extractAvailableDecisions } from "../src/codex/extractors/approval.js";

function fixture(t: TestContext, resolved = false) {
  const script = `
    const readline = require('node:readline');
    const prompt = id => ({id, method:'item/commandExecution/requestApproval', params:{
      threadId:'thread',turnId:'turn',itemId:'same-item',startedAtMs:1,kind:'humanCommand',
      command:'yarn test',cwd:'/work',reason:'Managed human checkpoint',
      availableDecisions:id === 'rpc-2' ? ['decline'] : null
    }});
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line);
      if(request.method === 'initialize') {
        const c=request.params.capabilities;
        if(!c.experimentalApi || !c.requiredHumanApproval || c.requestAttestation !== false ||
            'approvalPolicy' in request.params) {
          send({id:request.id,error:{code:-32602,message:'Unexpected client capabilities'}});return;
        }
        // Deliver a burst before the initialize response, including a duplicate and a separate callback on the same item.
        const messages=[prompt('rpc-1'),prompt('rpc-1'),prompt('rpc-2')];
        if(${resolved}) messages.push({method:'serverRequest/resolved',params:{threadId:'thread',requestId:'rpc-2'}});
        messages.push({id:request.id,result:{userAgent:'fixture/0.167.1'}});
        process.stdout.write(messages.map(JSON.stringify).join('\\n')+'\\n');
      } else if('result' in request) {
        send({method:'test/answer',params:{id:request.id,result:request.result}});
      } else if(request.id !== undefined) {
        send({id:request.id,result:{thread:{id:'thread',status:{type:'idle'}}}});
      }
    });
  `;
  const client = new CodexAppServerClient({ codexTransport: "stdio", codexAppServerCommand: process.execPath,
    codexAppServerArgs: ["-e", script], codexSkillExtraRoots: [] } as unknown as AppConfig);
  t.after(() => client.close());
  const approvals: AppServerApprovalRequest[] = [];
  const responses: unknown[] = [];
  client.onApprovalRequest((request) => {
    assert.equal(client.isApprovalPending(request.requestId), true, "replayed requests are delivered only after ready");
    approvals.push(request);
  });
  client.onNotification((notification) => {
    if (notification.method === "test/answer") responses.push(notification.params);
  });
  return { client, approvals, responses };
}

test("early human requests wait for readiness, dedupe by RPC id and retain independent callbacks", async (t) => {
  const f = fixture(t);
  await f.client.connect();
  assert.equal(f.approvals.length, 2);
  const [first, second] = f.approvals;
  assert.equal(first!.commandApprovalKind, "humanCommand");
  assert.deepEqual(first!.availableDecisions, null);
  assert.deepEqual(second!.availableDecisions, ["decline"]);
  assert.notEqual(first!.requestId, second!.requestId);
  for (const action of ["acceptForSession", "acceptWithExecpolicyAmendment"] as const) {
    await assert.rejects(f.client.resolveApproval(first!.requestId, action, first!.method), /unavailable/);
  }
  await assert.rejects(f.client.resolveApproval(second!.requestId, "accept", second!.method), /unavailable/);
  await Promise.all([
    f.client.resolveApproval(first!.requestId, "accept", first!.method),
    assert.rejects(f.client.resolveApproval(first!.requestId, "accept", first!.method), /original connection/)
  ]);
  await f.client.resolveApproval(second!.requestId, "decline", second!.method);
  await f.client.readThreadStatus("thread");
  assert.deepEqual(f.responses, [
    { id: "rpc-1", result: { decision: "accept" } }, { id: "rpc-2", result: { decision: "decline" } }
  ]);
});

test("reconnect with reused RPC ids creates fresh human decisions and cannot reuse old answers", async (t) => {
  const f = fixture(t);
  await f.client.connect();
  const old = f.approvals[0]!;
  await f.client.close();
  await f.client.connect();
  assert.equal(f.approvals.length, 4);
  const fresh = f.approvals[2]!;
  assert.notEqual(fresh.requestId, old.requestId);
  await assert.rejects(f.client.resolveApproval(old.requestId, "accept", old.method), /original connection/);
  await f.client.resolveApproval(fresh.requestId, "cancel", fresh.method);
  await f.client.readThreadStatus("thread");
  assert.deepEqual(f.responses, [{ id: "rpc-1", result: { decision: "cancel" } }]);
});

test("an early resolved notification invalidates its request without approving it", async (t) => {
  const f = fixture(t, true);
  await f.client.connect();
  assert.equal(f.approvals.length, 2);
  const resolved = f.approvals[1]!;
  assert.equal(f.client.isApprovalPending(resolved.requestId), false);
  await assert.rejects(f.client.resolveApproval(resolved.requestId, "accept", resolved.method), /original connection/);
  assert.deepEqual(f.responses, []);
});

test("available-decision parsing preserves unspecified, empty and unsupported declarations", () => {
  assert.equal(extractAvailableDecisions(null), null);
  assert.equal(extractAvailableDecisions(undefined), null);
  assert.deepEqual(extractAvailableDecisions([]), []);
  assert.deepEqual(extractAvailableDecisions("accept"), []);
  assert.deepEqual(extractAvailableDecisions(["decline", { acceptWithExecpolicyAmendment: {} }, 1]),
    ["decline", "acceptWithExecpolicyAmendment"]);
});

test("clients without approval handlers do not advertise required human approval", async (t) => {
  const script = `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const r=JSON.parse(line);if(r.id === undefined)return;
      const error=r.params.capabilities.requiredHumanApproval
        ? {code:-32602,message:'No human handler is registered'} : null;
      console.log(JSON.stringify(error ? {id:r.id,error} : {id:r.id,result:{}}));
    });
  `;
  const client = new CodexAppServerClient({ codexTransport: "stdio", codexAppServerCommand: process.execPath,
    codexAppServerArgs: ["-e", script], codexSkillExtraRoots: [] } as unknown as AppConfig);
  t.after(() => client.close());
  await client.connect();
});
