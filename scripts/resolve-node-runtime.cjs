const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

function resolveNodeRuntime(projectDir, {
  env = process.env,
  platform = process.platform,
  currentExecPath = process.execPath,
  currentVersion = process.versions.node,
  run = execFileSync
} = {}) {
  const version = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")).volta?.node;
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
    throw new Error("An exact volta.node version is required in package.json.");
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  const volta = env.VOLTA_HOME
    ? paths.join(env.VOLTA_HOME, "bin", platform === "win32" ? "volta.exe" : "volta")
    : "volta";
  const options = { cwd: projectDir, env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] };
  let interpreter;
  try {
    interpreter = run(volta, ["which", "node"], options).trim();
  } catch {
    // Non-Volta installations can use an already-correct launcher, never an old daemon runtime.
    if (currentVersion !== version) {
      throw new Error(`Cannot resolve Node ${version}. Install it with Volta or launch PM2 with that Node version.`);
    }
    interpreter = currentExecPath;
  }
  if (!paths.isAbsolute(interpreter)) {
    throw new Error("The resolved Node interpreter must be an absolute path.");
  }
  if (run(interpreter, ["--version"], options).trim() !== `v${version}`) {
    throw new Error(`The resolved Node interpreter does not match package.json (${version}).`);
  }
  const pathKey = platform === "win32"
    ? Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path"
    : "PATH";
  return {
    interpreter,
    // An old PM2 daemon must not put its own Node ahead of the selected runtime.
    env: { [pathKey]: [paths.dirname(interpreter), env[pathKey]].filter(Boolean).join(paths.delimiter) }
  };
}

module.exports = { resolveNodeRuntime };
