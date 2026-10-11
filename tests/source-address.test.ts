import assert from "node:assert/strict";
import test from "node:test";

import { parseSourceAddress, WEB_SOURCE_ID } from "../src/shared/source-address.js";

test("source addresses preserve Telegram and Slack binding metadata", () => {
  for (const sourceId of ["123456", "-100123456", "telegram:123", "chat-1"]) {
    assert.deepEqual(parseSourceAddress(sourceId), {
      platform: "telegram", botKey: "telegram", channelId: null, threadId: null
    });
  }
  assert.deepEqual(parseSourceAddress("slack:T:C"), {
    platform: "slack", botKey: "slack", channelId: "C", threadId: null
  });
  assert.deepEqual(parseSourceAddress("slack:T:C:123.456%3Athread"), {
    platform: "slack", botKey: "slack", channelId: "C", threadId: "123.456%3Athread"
  });
  assert.deepEqual(parseSourceAddress("slack:T:C:123:456"), {
    platform: "slack", botKey: "slack", channelId: "C", threadId: "123:456"
  });
});

test("Web bindings identify the stable service source, not a browser window", () => {
  assert.equal(WEB_SOURCE_ID, "web:local");
  assert.deepEqual(parseSourceAddress("web:local"), {
    platform: "web", botKey: "web", channelId: null, threadId: null
  });
  assert.deepEqual(parseSourceAddress("web:bridge-2"), {
    platform: "web", botKey: "web", channelId: null, threadId: null
  });
});

test("malformed reserved Web addresses cannot fall through to Telegram", () => {
  for (const sourceId of ["web:", "web:local:window-1", "web: local", "web:local\n"]) {
    assert.throws(() => parseSourceAddress(sourceId), /Invalid Web source address/);
  }
});
