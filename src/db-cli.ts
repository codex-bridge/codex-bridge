import path from "node:path";

import { BridgeStore } from "./store/index.js";

type Command =
  | "migrate"
  | "check"
  | "backup"
  | "reset-state"
  | "dedupe-slack-sessions";

function usage(): string {
  return [
    "Usage:",
    "  yarn db:migrate --database <path> [--dry-run] [--backup <path>]",
    "  yarn db:check --database <path>",
    "  yarn db:backup --database <path> --output <path>",
    "  yarn db:reset-state --database <path> [--dry-run]",
    "  yarn db:dedupe-slack-sessions --database <path> [--dry-run|--apply]"
  ].join("\n");
}

function parseArguments(argv: string[]): {
  command: Command;
  databasePath: string;
  dryRun: boolean;
  outputPath?: string;
  migrationBackupPath?: string;
} {
  const [command, ...rest] = argv;
  if (
    command !== "migrate" &&
    command !== "check" &&
    command !== "backup" &&
    command !== "reset-state" &&
    command !== "dedupe-slack-sessions"
  ) {
    throw new Error(usage());
  }

  const values = new Map<string, string>();
  let dryRun = command === "dedupe-slack-sessions";
  let seenDryRun = false;
  let seenApply = false;
  for (let index = 0; index < rest.length;) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--dry-run") {
      if (
        (command !== "migrate" &&
          command !== "reset-state" &&
          command !== "dedupe-slack-sessions") ||
        seenDryRun ||
        seenApply
      ) {
        throw new Error(usage());
      }
      seenDryRun = true;
      dryRun = true;
      index += 1;
      continue;
    }
    if (flag === "--backup") {
      if (command !== "migrate" || !value || values.has(flag)) {
        throw new Error(usage());
      }
      values.set(flag, value);
      index += 2;
      continue;
    }
    if (flag === "--apply") {
      if (command !== "dedupe-slack-sessions" || seenDryRun || seenApply) {
        throw new Error(usage());
      }
      seenApply = true;
      dryRun = false;
      index += 1;
      continue;
    }
    if ((flag !== "--database" && flag !== "--output") || !value || values.has(flag)) {
      throw new Error(usage());
    }
    values.set(flag, value);
    index += 2;
  }
  const databasePath = values.get("--database");
  if (
    !databasePath ||
    (command === "backup" && !values.get("--output")) ||
    (command !== "backup" && values.has("--output"))
    || (command !== "migrate" && values.has("--backup"))
  ) {
    throw new Error(usage());
  }

  return {
    command,
    databasePath: path.resolve(databasePath),
    dryRun,
    outputPath: values.get("--output") ? path.resolve(values.get("--output") as string) : undefined,
    migrationBackupPath: values.get("--backup") ? path.resolve(values.get("--backup") as string) : undefined
  };
}

export async function runDatabaseCli(argv: string[]): Promise<number> {
  const { command, databasePath, dryRun, outputPath, migrationBackupPath } = parseArguments(argv);
  if (command === "backup") {
    const result = await BridgeStore.backupDatabase(databasePath, outputPath as string);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === "migrate" && dryRun) {
    const store = new BridgeStore(databasePath, { readonly: true });
    try {
      process.stdout.write(`${JSON.stringify(store.getMigrationPlan(), null, 2)}\n`);
      return 0;
    } finally {
      store.close();
    }
  }

  const store = new BridgeStore(databasePath, {
    readonly: command === "check",
    migrationBackupPath
  });
  try {
    if (command === "reset-state") {
      const result = store.resetState({ dryRun });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (command === "dedupe-slack-sessions") {
      const result = store.dedupeSlackSessions({ dryRun });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    const result = store.checkDatabase();
    process.stdout.write(`${JSON.stringify({
      ...result,
      ...(command === "migrate" ? {
        migrationBackupPath: store.getLastMigrationBackupPath(),
        migrationBackupIntegrity: store.getLastMigrationBackupIntegrity()
      } : {})
    }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

runDatabaseCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
);
