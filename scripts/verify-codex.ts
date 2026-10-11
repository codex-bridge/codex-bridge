import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseVerificationOptions, runVerification, verificationUsage } from "./verify-codex/cli.js";
import { formatVerificationError, renderVerificationReport } from "./verify-codex/report.js";
import { createVerificationClient } from "./verify-codex/runtime.js";
import { applySessionRefresh } from "./verify-codex/session-refresh-apply.js";
import { logger } from "../src/logging/logger.js";
import { BridgeStore } from "../src/store/index.js";

function resolveBridgeDatabasePath(): string {
  return resolve(process.env.BRIDGE_DB_FILE?.trim() || "./workspaces/bridge.sqlite");
}

type SessionRefreshStore = {
  store: BridgeStore;
  cleanup: () => Promise<void>;
};

async function openSessionRefreshStore(
  databasePath: string,
  applyMode: "none" | "sandbox" | "production"
): Promise<SessionRefreshStore> {
  if (applyMode === "none") {
    return { store: new BridgeStore(databasePath, { readonly: true }), cleanup: async () => undefined };
  }
  if (applyMode === "production") {
    return { store: new BridgeStore(databasePath), cleanup: async () => undefined };
  }
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-session-refresh-"));
  const copyPath = join(directory, "bridge.sqlite");
  await BridgeStore.backupDatabase(databasePath, copyPath);
  return {
    store: new BridgeStore(copyPath),
    cleanup: async () => rm(directory, { recursive: true, force: true })
  };
}

function hasSessionRefreshChanges(result: Awaited<ReturnType<typeof applySessionRefresh>>): boolean {
  return result.created.length > 0 ||
    result.archived.length > 0 ||
    result.restored.length > 0 ||
    result.deleted.length > 0 ||
    result.missingCountChanged.length > 0;
}

function refreshReportFingerprint(report: Awaited<ReturnType<typeof runVerification>>): string {
  return JSON.stringify({ checks: report.checks, data: report.data });
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${verificationUsage()}\n`);
    return;
  }
  const options = parseVerificationOptions(process.argv.slice(2));
  if (options.scenario === "session-refresh" && !options.sourceId) {
    throw new Error("--source is required for the session-refresh scenario.");
  }
  logger.configureOutput({ console: options.verbose ? "stderr" : "none", file: false });
  const client = createVerificationClient();
  const sessionRefreshStore = options.scenario === "session-refresh"
    ? await openSessionRefreshStore(resolveBridgeDatabasePath(), options.refreshApplyMode)
    : null;
  try {
    const reports = [];
    const applyResults = [];
    for (let index = 0; index < options.refreshRepeatCount; index += 1) {
      if (options.refreshApplyMode !== "none") {
        applyResults.push(await applySessionRefresh(
          client,
          sessionRefreshStore?.store as BridgeStore,
          options.sourceId as string,
          options.refreshApplyMode
        ));
      }
      reports.push(await runVerification(client, options, sessionRefreshStore?.store ?? null));
    }
    const report = reports.at(-1);
    if (!report) throw new Error("Session-refresh did not produce a verification report.");
    const verificationStable = new Set(reports.map(refreshReportFingerprint)).size === 1;
    const idempotent = applyResults.slice(1).every((result) => !hasSessionRefreshChanges(result));
    if (applyResults.length > 0) {
      report.checks.unshift({ name: "apply", ok: idempotent, detail: `Refresh applied in ${options.refreshApplyMode} mode across ${applyResults.length} run(s).` });
      report.data.apply = applyResults;
    }
    if (options.refreshRepeatCount > 1) {
      report.checks.unshift({ name: "repeat_stability", ok: verificationStable && idempotent, detail: `${options.refreshRepeatCount} refresh verification run(s) ${verificationStable ? "matched" : "differed"}.` });
      report.data.repeat = { count: options.refreshRepeatCount, verificationStable, idempotent };
    }
    report.ok = report.checks.every((check) => check.ok);
    process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : renderVerificationReport(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    sessionRefreshStore?.store.close();
    await sessionRefreshStore?.cleanup();
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`Verification failed: ${formatVerificationError(error)}\n`);
  process.exitCode = 1;
});
