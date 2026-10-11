import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { resolveRebuildCommand } = require("../scripts/rebuild-better-sqlite3.cjs") as {
  resolveRebuildCommand(options: {
    platform: string;
    execPath: string;
    env: NodeJS.ProcessEnv;
  }): { command: string; args: string[] };
};

test("native rebuild uses the Volta npm shim through cmd on Windows", () => {
  assert.deepEqual(resolveRebuildCommand({
    platform: "win32",
    execPath: "C:\\Users\\example\\AppData\\Local\\Volta\\tools\\image\\node\\22.22.0\\node.exe",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
  }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd rebuild better-sqlite3"]
  });
});

test("native rebuild preserves the version-local npm CLI path on Unix", () => {
  assert.deepEqual(resolveRebuildCommand({
    platform: "darwin",
    execPath: "/Users/test/.volta/tools/image/node/22.22.0/bin/node",
    env: {}
  }), {
    command: "/Users/test/.volta/tools/image/node/22.22.0/bin/node",
    args: [
      "/Users/test/.volta/tools/image/node/22.22.0/lib/node_modules/npm/bin/npm-cli.js",
      "rebuild",
      "better-sqlite3"
    ]
  });
});
