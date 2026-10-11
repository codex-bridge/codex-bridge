import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupWebAttachments,
  sanitizeWebFileName,
  WebAttachmentStorage
} from "../src/web/attachments.js";
import { ATTACHMENT_PENDING_RETENTION_MS } from "../src/bridge/input/attachment-files.js";

test("Web attachment storage sanitizes names, records lifecycle metadata and cleans expired files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-web-attachment-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new WebAttachmentStorage(root);
  const [attachment] = await storage.save([{
    name: "../screen shot café.png", mimeType: "image/png", sizeBytes: 8,
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  }], { requestId: "request", sessionId: "session", status: "queued" });
  assert.equal(attachment?.kind, "image");
  assert.equal(attachment?.name, "..-screen_shot_caf_.png");
  assert.deepEqual([...(await readFile(attachment!.localPath))],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const metadata = JSON.parse(await readFile(`${attachment!.localPath}.json`, "utf8")) as {
    source: string; requestId: string; sessionId: string; status: string
  };
  assert.deepEqual({ source: metadata.source, requestId: metadata.requestId, sessionId: metadata.sessionId, status: metadata.status },
    { source: "web", requestId: "request", sessionId: "session", status: "queued" });

  const result = await cleanupWebAttachments(root, Date.now() + ATTACHMENT_PENDING_RETENTION_MS + 1_000);
  assert.deepEqual(result, { deleted: 1, scanned: 1 });
  await assert.rejects(access(attachment!.localPath));
});

test("Web attachment storage rejects unsupported and spoofed image uploads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bridge-web-attachment-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new WebAttachmentStorage(root);

  await assert.rejects(storage.save([{
    name: "notes.md", mimeType: "text/markdown", sizeBytes: 4, bytes: new Uint8Array([1, 2, 3, 4])
  }], { requestId: "request", sessionId: "session", status: "queued" }), /Invalid Web attachment/);
  await assert.rejects(storage.save([{
    name: "spoofed.png", mimeType: "image/png", sizeBytes: 4, bytes: new Uint8Array([1, 2, 3, 4])
  }], { requestId: "request", sessionId: "session", status: "queued" }), /Invalid Web attachment/);
});

test("Web attachment filename sanitizing never retains path separators", () => {
  assert.equal(sanitizeWebFileName("../../a\\b.txt"), "..-..-a-b.txt");
  assert.equal(sanitizeWebFileName(""), "attachment");
});
