import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCompletedAgentMessage,
  extractTurnLifecycleEvent
} from "../src/codex/notification-events.js";
import { getAppServerMethodCapability } from "../src/codex/protocol-registry.js";

test("Codex 0.162.1 protocol additions remain discoverable without being treated as used", () => {
  const attachment = getAppServerMethodCapability("thread/attachmentOwner/list");
  assert.equal(attachment?.status, "available");
  assert.equal(attachment?.evidence.generatedType, true);
  assert.equal(attachment?.evidence.runtime, "listed");
  assert.equal(attachment?.evidence.productionReferences.length, 0);
  assert.equal(getAppServerMethodCapability("thread/prediction/request")?.evidence.generatedType, true);
  assert.equal(getAppServerMethodCapability("account/bedrock/checkGovCloudRequirements")?.evidence.generatedType, true);
  assert.equal(getAppServerMethodCapability("thread/prediction/updated")?.kind, "notification");
});

test("partial answers stay visible without becoming a terminal turn signal", () => {
  const partial = {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-1",
        type: "agentMessage",
        text: "Partial result",
        phase: "partial_answer"
      }
    }
  };

  assert.deepEqual(extractCompletedAgentMessage(partial), {
    threadId: "thread-1",
    text: "Partial result"
  });
  assert.equal(extractTurnLifecycleEvent(partial), null);
  assert.deepEqual(extractTurnLifecycleEvent({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    }
  }), {
    threadId: "thread-1",
    turnId: "turn-1",
    kind: "completed",
    terminalState: "completed"
  });
});
