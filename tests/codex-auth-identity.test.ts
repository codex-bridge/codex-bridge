import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { getCodexAuthFilePath, getCodexEnvFilePath, readCodexAuthIdentity } from "../src/codex/auth-identity.js";

test("auth identity ignores token refresh fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-auth-identity-"));
  const file = join(directory, "auth.json");
  writeFileSync(file, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { account_id: "account-a", access_token: "first" }
  }));
  const first = readCodexAuthIdentity(file);

  writeFileSync(file, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { account_id: "account-a", access_token: "refreshed" }
  }));
  assert.equal(readCodexAuthIdentity(file), first);
});

test("auth identity changes when the account changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-auth-identity-"));
  const file = join(directory, "auth.json");
  writeFileSync(file, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { account_id: "account-a" }
  }));
  const first = readCodexAuthIdentity(file);

  writeFileSync(file, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { account_id: "account-b" }
  }));
  assert.notEqual(readCodexAuthIdentity(file), first);
});

test("auth identity supports the top-level account id fallback", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-auth-identity-"));
  const file = join(directory, "auth.json");
  writeFileSync(file, JSON.stringify({ auth_mode: "api-key", account_id: "account-a" }));
  assert.equal(readCodexAuthIdentity(file), "api-key\taccount-a");
});

test("auth path follows CODEX_HOME", () => {
  assert.equal(
    getCodexAuthFilePath({ CODEX_HOME: "/tmp/custom-codex" }),
    "/tmp/custom-codex/auth.json"
  );
  assert.equal(
    getCodexEnvFilePath({ CODEX_HOME: "/tmp/custom-codex" }),
    "/tmp/custom-codex/.env"
  );
});
