import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_BUILT_IN_PROVIDER, resolveCodexProvider } from "../src/codex/provider.js";

test("normalizes the built-in Codex provider to the thread API provider name", () => {
  assert.equal(resolveCodexProvider(null), CODEX_BUILT_IN_PROVIDER);
  assert.equal(resolveCodexProvider(undefined), CODEX_BUILT_IN_PROVIDER);
  assert.equal(resolveCodexProvider("codex-lb"), "codex-lb");
});
