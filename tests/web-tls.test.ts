import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { request } from "node:https";
import { WebServer } from "../src/web/server.js";

test("TLS listener uses the real HTTPS origin and never trusts forwarded origin headers", async (t) => {
  const openssl = process.env.OPENSSL_BIN || "openssl";
  if (spawnSync(openssl, ["version"]).status !== 0) { t.skip("OpenSSL is required for the development TLS integration check."); return; }
  const directory = await mkdtemp(join(tmpdir(), "bridge-test-tls-"));
  const script = new URL("../scripts/web-dev-tls.mjs", import.meta.url);
  execFileSync(process.execPath, [script.pathname, "127.0.0.1", directory], { env: { ...process.env, OPENSSL_BIN: openssl } });
  assert.throws(() => execFileSync(process.execPath, [script.pathname, "127.0.0.1", directory], { stdio: "pipe" }), /already exist/);
  const server = new WebServer({ host: "127.0.0.1", port: 0,
    tls: { certFile: join(directory, "cert.pem"), keyFile: join(directory, "key.pem") } });
  const address = await server.start();
  t.after(() => server.stop());
  const base = `https://127.0.0.1:${address.port}`;
  const get = (origin?: string, extra: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
    const req = request(`${base}/api/web/health`, { rejectUnauthorized: false,
      headers: { ...(origin ? { Origin: origin } : {}), ...extra } }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.once("error", reject); req.end();
  });
  assert.equal(await get(base), 200);
  assert.equal(await get(base.replace("https:", "http:")), 403);
  assert.equal(await get("https://foreign.example", { "X-Forwarded-Proto": "https" }), 403);
  assert.equal(await get(base, { Host: "localhost:1" }), 403);
});

test("invalid TLS paths fail closed instead of silently falling back to HTTP", () => {
  assert.throws(() => new WebServer({ host: "127.0.0.1", port: 0,
    tls: { certFile: "/missing/bridge-test-cert.pem", keyFile: "/missing/bridge-test-key.pem" } }), /ENOENT/);
});
