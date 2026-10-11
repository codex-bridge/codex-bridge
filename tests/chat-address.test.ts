import assert from "node:assert/strict";
import test from "node:test";

import { getSessionSelectorChatId, parseSlackChatId } from "../src/bridge/chat-address.js";

test("parses Slack root and thread chat addresses", () => {
  assert.deepEqual(parseSlackChatId("slack:T123:C123"), {
    teamId: "T123",
    channelId: "C123",
    threadTs: null
  });
  assert.deepEqual(parseSlackChatId("slack:T123:C123:111.222%3Athread"), {
    teamId: "T123",
    channelId: "C123",
    threadTs: "111.222:thread"
  });
  assert.equal(parseSlackChatId("telegram:123"), null);
});

test("selector chat address collapses only Slack thread addresses to their root", () => {
  assert.equal(getSessionSelectorChatId("slack:T123:C123:111.222"), "slack:T123:C123");
  assert.equal(getSessionSelectorChatId("slack:T123:D123"), "slack:T123:D123");
  assert.equal(getSessionSelectorChatId("123456"), "123456");
});
