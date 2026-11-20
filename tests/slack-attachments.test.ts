import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { describeSlackAttachmentFailure, downloadSlackAttachments } from "../src/slack/attachments.js";

const file = { id: "F_TEST", name: "image.png", mimetype: "image/png",
  url_private_download: "https://files.slack.com/files-pri/example?private=hidden" };

async function storage(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bridge-slack-download-"));
  const previous = process.env.SLACK_ATTACHMENT_DIR;
  process.env.SLACK_ATTACHMENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.SLACK_ATTACHMENT_DIR;
    else process.env.SLACK_ATTACHMENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("Slack connection failures preserve their cause code without blaming scopes or exposing private URLs", async t => {
  const root = await storage(t);
  const cause = Object.assign(new Error(`Private request ${file.url_private_download} Bearer hidden-token`), { code: "UND_ERR_CONNECT_TIMEOUT" });
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed", { cause }); });
  await assert.rejects(downloadSlackAttachments([file], "hidden-token"), error => {
    const failure = describeSlackAttachmentFailure(error);
    assert.deepEqual(failure.diagnostics, { phase: "network", fileId: "F_TEST", httpStatus: null, causeCode: "UND_ERR_CONNECT_TIMEOUT" });
    assert.match(failure.message, /network error.*UND_ERR_CONNECT_TIMEOUT/);
    assert.doesNotMatch(JSON.stringify(failure), /files:read|reinstall|private=hidden|hidden-token|files\.slack\.com/);
    return true;
  });
  assert.deepEqual(await readdir(root), []);
});

test("Slack HTTP failures keep their actual status and distinguish access, availability and rate limiting", async t => {
  const root = await storage(t);
  let status = 401;
  t.mock.method(globalThis, "fetch", async () => new Response("Private response body", { status }));
  for (status of [401, 403, 404, 410, 429, 500]) {
    await assert.rejects(downloadSlackAttachments([file], "test-token"), error => {
      const failure = describeSlackAttachmentFailure(error);
      assert.deepEqual(failure.diagnostics, { phase: "http", fileId: "F_TEST", httpStatus: status, causeCode: null });
      assert.match(failure.message, new RegExp(`HTTP ${status}`));
      if (status === 401 || status === 403) assert.match(failure.message, /bot token and file access/);
      else if (status === 404 || status === 410) assert.match(failure.message, /still available to this bot/);
      else if (status === 429) assert.match(failure.message, /rate-limited/);
      assert.doesNotMatch(JSON.stringify(failure), /Private response body|reinstall|files:read/);
      return true;
    });
  }
  assert.deepEqual(await readdir(root), []);
});

test("a broken response stream remains a download-network failure", async t => {
  await storage(t);
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
    controller.error(Object.assign(new Error("response interrupted"), { code: "ECONNRESET" }));
  } })));
  await assert.rejects(downloadSlackAttachments([file], "test-token"), error => {
    const failure = describeSlackAttachmentFailure(error);
    assert.equal(failure.diagnostics.phase, "network");
    assert.equal(failure.diagnostics.causeCode, "ECONNRESET");
    return true;
  });
});

test("local save failures are not reported as Slack network or permission failures", async t => {
  const root = await storage(t), blocked = join(root, "not-a-directory");
  await writeFile(blocked, "occupied");
  process.env.SLACK_ATTACHMENT_DIR = blocked;
  t.mock.method(globalThis, "fetch", async () => new Response("downloaded bytes"));
  await assert.rejects(downloadSlackAttachments([file], "test-token"), error => {
    const failure = describeSlackAttachmentFailure(error);
    assert.equal(failure.diagnostics.phase, "storage");
    assert.ok(failure.diagnostics.causeCode);
    assert.match(failure.message, /downloaded.*saving it locally/);
    assert.doesNotMatch(failure.message, /files:read|reinstall|bot token/);
    return true;
  });
});

test("Slack DM downloads still save attachment bytes and metadata using the bot authorization", async t => {
  await storage(t);
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, file.url_private_download);
    assert.deepEqual(options.headers, { Authorization: "Bearer test-token" });
    return new Response("image bytes");
  });
  const attachments = await downloadSlackAttachments([file], "test-token", { chatId: "slack:T:D", messageId: "upload",
    receivedAt: new Date("2026-11-20T00:00:00Z") });
  assert.equal(attachments.length, 1);
  assert.equal(await readFile(attachments[0]!.path, "utf8"), "image bytes");
  const metadata = JSON.parse(await readFile(`${attachments[0]!.path}.json`, "utf8"));
  assert.equal(metadata.chatId, "slack:T:D");
  assert.equal(metadata.messageId, "upload");
  assert.equal(metadata.status, "downloaded");
  assert.equal(metadata.sizeBytes, 11);
});

test("unknown attachment failures use a neutral message without exposing raw error contents", () => {
  const failure = describeSlackAttachmentFailure(new Error("private details Bearer hidden-token"));
  assert.equal(failure.diagnostics.phase, "unknown");
  assert.match(failure.message, /Check the Bridge logs/);
  assert.doesNotMatch(JSON.stringify(failure), /hidden-token|files:read|reinstall/);
});
