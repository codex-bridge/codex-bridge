import assert from "node:assert/strict";
import test from "node:test";
import { directoryLabel } from "../web/src/lib/directory-label.js";

test("directoryLabel keeps the basename prominent and shortens deep parents", () => {
  assert.deepEqual(directoryLabel("/Users/example/workspace/projects/demo/codex-bridge"), {
    name: "codex-bridge",
    parent: "…/projects/demo"
  });
  assert.deepEqual(directoryLabel("/Users/example/sample-project/"), {
    name: "sample-project",
    parent: "/Users/example"
  });
  assert.deepEqual(directoryLabel("/"), { name: "/", parent: null });
});
