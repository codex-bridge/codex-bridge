const { spawnSync } = require("node:child_process");
const { dirname, join } = require("node:path");

function resolveRebuildCommand({
  platform = process.platform,
  execPath = process.execPath,
  env = process.env
} = {}) {
  if (platform === "win32") {
    return {
      command: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd rebuild better-sqlite3"]
    };
  }

  const nodeBinDir = dirname(execPath);
  const npmCli = join(nodeBinDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return {
    command: execPath,
    args: [npmCli, "rebuild", "better-sqlite3"]
  };
}

function main() {
  const { command, args } = resolveRebuildCommand();
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

module.exports = { resolveRebuildCommand };

if (require.main === module) {
  main();
}
