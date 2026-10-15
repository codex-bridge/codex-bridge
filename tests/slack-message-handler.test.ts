import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeSlackMessagePort } from "../src/bridge/contracts.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import { createSlackMessageHandler } from "../src/slack/message-handler.js";
import type { SlackDownloadedAttachment, SlackAttachmentMetadata } from "../src/slack/attachments.js";
import type { SlackMessageTransport } from "../src/slack/transport.js";
import { testConfig } from "./bridge-test-config.js";

test("Slack root restart commands retain their conversation context", async () => {
  const calls: string[] = [];
  const reply: MessageSpec = { kind: "system", title: "Codex · /workspace/project", body: [], actions: [] };
  const handler = createSlackMessageHandler({
    config: testConfig(join(tmpdir(), "unused-restart-test.sqlite")),
    getBotUserId: () => null,
    service: {
      ensureChatAllowed: async () => {},
      restartServiceMessage: async (chatId: string) => { calls.push(chatId); return reply; }
    } as unknown as BridgeSlackMessagePort,
    transport: {
      sendMessageSpec: async (chatId: string, message: MessageSpec) => {
        calls.push(`send:${chatId}`);
        assert.equal(message, reply);
        return null;
      }
    } as unknown as SlackMessageTransport
  });
  await handler.handleText({
    channelId: "D1", channelType: "im", teamId: "T1", messageId: "msg-restart", rawText: "/bot_restart"
  });
  assert.deepEqual(calls, ["slack:T1:D1", "send:slack:T1:D1"]);
});

test("Slack confirms an image only after Codex accepts it; a failed receipt does not roll back delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-slack-image-ack-"));
  const path = join(directory, "image.png");
  await writeFile(path, "png");
  const attachment: SlackDownloadedAttachment = {
    createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
    id: "F1", kind: "image", mimeType: "image/png", name: "image.png", path, size: 3
  };
  const sent: string[] = [];
  let accept!: () => void;
  const pending = new Promise<void>((resolve) => { accept = resolve; });
  const service = {
    ensureChatAllowed: async () => {},
    getActiveSessionContext: async () => undefined,
    handleIncomingUserPayload: async () => { await pending; return { routed: true }; }
  } as unknown as BridgeSlackMessagePort;
  const transport = {
    sendMessageSpec: async (_chatId: string, spec: MessageSpec) => {
      sent.push(renderLegacyMessage(spec));
      throw new Error("receipt unavailable");
    }
  } as unknown as SlackMessageTransport;
  const handler = createSlackMessageHandler({
    config: testConfig(join(directory, "bridge.sqlite")), getBotUserId: () => null, service, transport
  });
  try {
    const handling = handler.handleText({
      attachments: [attachment], channelId: "D1", channelType: "im", messageId: "msg-1", rawText: "inspect",
      teamId: "T1"
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, []);
    accept();
    await handling;
    assert.match(sent[0] ?? "", /Codex input accepted; attachments received: 1 image/);
    const metadata = JSON.parse(await readFile(`${path}.json`, "utf8")) as SlackAttachmentMetadata;
    assert.equal(metadata.status, "sent-to-codex");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Slack does not acknowledge an image when its route rejects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-slack-image-failed-"));
  const path = join(directory, "image.png");
  await writeFile(path, "png");
  const attachment: SlackDownloadedAttachment = {
    createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
    id: "F2", kind: "image", mimeType: "image/png", name: "image.png", path, size: 3
  };
  const sent: string[] = [];
  const service = {
    ensureChatAllowed: async () => {},
    getActiveSessionContext: async () => undefined,
    handleIncomingUserPayload: async () => { throw new Error("Codex request failed"); }
  } as unknown as BridgeSlackMessagePort;
  const transport = {
    sendMessageSpec: async (_chatId: string, spec: MessageSpec) => {
      sent.push(renderLegacyMessage(spec));
      return null;
    }
  } as unknown as SlackMessageTransport;
  const handler = createSlackMessageHandler({
    config: testConfig(join(directory, "bridge.sqlite")), getBotUserId: () => null, service, transport
  });
  try {
    await handler.handleText({
      attachments: [attachment], channelId: "D1", channelType: "im", messageId: "msg-2", rawText: "inspect",
      teamId: "T1"
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /Could not confirm attachment delivery/);
    assert.doesNotMatch(sent[0] ?? "", /Received 1 image|request accepted/);
    const metadata = JSON.parse(await readFile(`${path}.json`, "utf8")) as SlackAttachmentMetadata;
    assert.equal(metadata.status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
