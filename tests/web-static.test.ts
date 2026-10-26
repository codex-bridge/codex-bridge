import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebServer } from "../src/web/server.js";

test("Web entry declares English as its document language", async () => {
  const entry = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(entry, /<html lang="en">/u);
});

test("built webpage serves same-origin only, without exposing source or API fallbacks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-web-static-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Bridge</title>");
  await writeFile(join(root, "assets", "app.js"), "export const app = true;");
  await writeFile(join(root, "notifications-worker.js"), "/* notification worker */");
  await writeFile(join(root, "assets", ".private.js"), "private");
  await writeFile(join(root, "assets", "source.ts"), "private source");
  const outside = await mkdtemp(join(tmpdir(), "bridge-web-outside-"));
  await writeFile(join(outside, "outside.js"), "outside");
  await symlink(join(outside, "outside.js"), join(root, "assets", "link.js"));
  const server = new WebServer({ host: "127.0.0.1", port: 0, staticRoot: root });
  const address = await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const entry = await fetch(base);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get("content-type")!, /text\/html/);
  assert.match(entry.headers.get("content-security-policy")!, /img-src 'self' blob:/);
  assert.match(entry.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(entry.headers.get("cache-control"), "no-store");
  assert.match(await entry.text(), /Bridge/);
  assert.match((await fetch(`${base}/assets/app.js`)).headers.get("content-type")!, /javascript/);
  const worker = await fetch(`${base}/notifications-worker.js`);
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get("content-type")!, /javascript/);
  assert.equal(worker.headers.get("cache-control"), "no-store");
  for (const path of ["/api/web/nope", "/src/index.ts", "/assets/.private.js", "/assets/source.ts", "/assets/link.js", "/assets/%2eprivate.js", "/assets/%2e%2e%2findex.html", "/assets/%5cindex.html"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get("content-type")!, /json/);
  }
  assert.equal((await fetch(base, { headers: { origin: "http://foreign.test" } })).status, 403);
  assert.equal((await fetch(base, { method: "POST" })).status, 404);
});
