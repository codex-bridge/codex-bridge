import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
type RuntimeOptions = {
  env?: Record<string, string>;
  platform?: string;
  currentVersion?: string;
  currentExecPath?: string;
  run: (command: string, args: string[], options: { cwd: string }) => string;
};
const { resolveNodeRuntime } = require("../scripts/resolve-node-runtime.cjs") as {
  resolveNodeRuntime(directory: string, options: RuntimeOptions): {
    interpreter: string;
    env: Record<string, string>;
  };
};

function fixture(t: test.TestContext, version = "22.23.5") {
  const directory = mkdtempSync(path.join(tmpdir(), "bridge-node-runtime-"));
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ volta: { node: version } }));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("PM2 resolves the project pin and puts its Node before inherited old Node", (t) => {
  const directory = fixture(t);
  const calls: string[][] = [];
  const runtime = resolveNodeRuntime(directory, {
    env: { VOLTA_HOME: "/home/test/.volta", PATH: "/old/node/bin:/usr/bin" },
    platform: "darwin",
    currentVersion: "22.22.0",
    run(command, args, options) {
      assert.equal(options.cwd, directory);
      calls.push([command, ...args]);
      return args[0] === "which" ? "/safe/node/bin/node\n" : "v22.23.5\n";
    }
  });
  assert.equal(runtime.interpreter, "/safe/node/bin/node");
  assert.equal(runtime.env.PATH, "/safe/node/bin:/old/node/bin:/usr/bin");
  assert.deepEqual(calls, [["/home/test/.volta/bin/volta", "which", "node"], ["/safe/node/bin/node", "--version"]]);
});

test("an unavailable Volta never silently falls back to the old daemon Node", (t) => {
  assert.throws(() => resolveNodeRuntime(fixture(t), {
    env: {}, currentVersion: "22.22.0", run() { throw new Error("missing"); }
  }), /Cannot resolve Node 22\.23\.5/);
});

test("without Volta an exact matching launcher remains supported", (t) => {
  const runtime = resolveNodeRuntime(fixture(t), {
    env: { PATH: "/usr/bin" }, platform: "linux",
    currentVersion: "22.23.5", currentExecPath: "/safe/bin/node",
    run(_command, args) {
      if (args[0] === "which") throw new Error("missing");
      return "v22.23.5\n";
    }
  });
  assert.equal(runtime.interpreter, "/safe/bin/node");
  assert.equal(runtime.env.PATH, "/safe/bin:/usr/bin");
});

test("a Volta result with the wrong version is rejected", (t) => {
  assert.throws(() => resolveNodeRuntime(fixture(t), {
    env: {}, platform: "linux",
    run(_command, args) { return args[0] === "which" ? "/old/bin/node" : "v22.22.0"; }
  }), /does not match package\.json/);
});

test("relative interpreter paths and non-exact pins are rejected", (t) => {
  assert.throws(() => resolveNodeRuntime(fixture(t), {
    env: {}, run() { return "node"; }
  }), /absolute path/);
  assert.throws(() => resolveNodeRuntime(fixture(t, "22"), {
    env: {}, run() { throw new Error("must not execute"); }
  }), /exact volta.node/);
});

test("Windows resolves volta.exe and preserves the Path key and separator", (t) => {
  const runtime = resolveNodeRuntime(fixture(t), {
    platform: "win32", env: { VOLTA_HOME: "C:\\Volta", Path: "C:\\old;C:\\Windows" },
    run(command, args) {
      if (args[0] === "which") {
        assert.equal(command, "C:\\Volta\\bin\\volta.exe");
        return "C:\\safe\\node.exe\r\n";
      }
      return "v22.23.5\r\n";
    }
  });
  assert.equal(runtime.env.Path, "C:\\safe;C:\\old;C:\\Windows");
  assert.equal(runtime.env.PATH, undefined);
});

test("the previous security patch is rejected for the new project pin", (t) => {
  assert.throws(() => resolveNodeRuntime(fixture(t), {
    env: {}, currentVersion: "22.23.4", run() { throw new Error("missing"); }
  }), /Cannot resolve Node 22\.23\.5/);
});
