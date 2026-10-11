import assert from "node:assert/strict";
import test from "node:test";

import {
  compareCodexVersions,
  parseCodexVersion,
  readCodexVersion
} from "../src/codex/version-reader.js";
import {
  VersionUpdateNotifier,
  type CodexVersionUpdate
} from "../src/bridge/notifications/version-update.js";
import type { SessionRecord } from "../src/shared/types.js";

const session = {
  id: "session-1",
  telegramChatId: "chat-1",
  codexThreadId: "thread-1"
} as SessionRecord;

function fakeTimer() {
  let callback: (() => void) | null = null;
  let unrefCount = 0;
  let clearCount = 0;
  const timer = { unref: () => { unrefCount += 1; } } as ReturnType<typeof setInterval>;
  return {
    schedule: (next: () => void) => {
      callback = next;
      return timer;
    },
    clear: () => { clearCount += 1; },
    callback: () => callback,
    unrefCount: () => unrefCount,
    clearCount: () => clearCount
  };
}

test("Codex version reader accepts only stable numeric versions", async () => {
  assert.equal(parseCodexVersion("codex-cli 0.158.0\n"), "0.158.0");
  assert.equal(parseCodexVersion("codex-cli 0.159.0-beta.1"), null);
  assert.equal(parseCodexVersion("unexpected"), null);
  assert.equal(compareCodexVersions("0.159.0", "0.158.9"), 1);
  assert.equal(compareCodexVersions("0.158.0", "0.158.0"), 0);
  assert.equal(compareCodexVersions("0.157.9", "0.158.0"), -1);

  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await readCodexVersion("/opt/homebrew/bin/codex", async (command, args) => {
    calls.push({ command, args });
    return { stdout: "codex-cli 0.158.0", stderr: "" };
  });
  assert.equal(result, "0.158.0");
  assert.deepEqual(calls, [{ command: "/opt/homebrew/bin/codex", args: ["--version"] }]);
});

test("version update waits for a root turn and collapses pending versions", async () => {
  const versions = ["0.158.0", "0.158.0", "0.157.9", null, "0.159.0", "0.160.0"];
  const delivered: CodexVersionUpdate[] = [];
  const timers = fakeTimer();
  const notifier = new VersionUpdateNotifier({
    readVersion: async () => versions.shift() ?? null,
    deliver: async (_session, update) => { delivered.push(update); },
    scheduleInterval: timers.schedule,
    clearScheduledInterval: timers.clear
  });

  await notifier.start();
  assert.equal(timers.unrefCount(), 1);
  await notifier.checkNow();
  await notifier.checkNow();
  await notifier.checkNow();
  assert.deepEqual(delivered, []);
  await notifier.checkNow();
  await notifier.checkNow();
  assert.deepEqual(delivered, []);
  assert.equal(await notifier.deliverAfterRootTurn(null), false);

  const results = await Promise.all([
    notifier.deliverAfterRootTurn(session),
    notifier.deliverAfterRootTurn(session)
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.deepEqual(delivered, [{ baseline: "0.158.0", latest: "0.160.0" }]);
  assert.equal(timers.clearCount(), 1);
});

test("failed version delivery remains pending, successful delivery is process-global", async () => {
  const versions = ["0.158.0", "0.159.0", "0.160.0"];
  const attempts: CodexVersionUpdate[] = [];
  const timers = fakeTimer();
  let fail = true;
  const notifier = new VersionUpdateNotifier({
    readVersion: async () => versions.shift() ?? null,
    deliver: async (_session, update) => {
      attempts.push(update);
      if (fail) throw new Error("temporary transport failure");
    },
    scheduleInterval: timers.schedule,
    clearScheduledInterval: timers.clear
  });

  await notifier.start();
  await notifier.checkNow();
  assert.equal(await notifier.deliverAfterRootTurn(session), false);
  fail = false;
  assert.equal(await notifier.deliverAfterRootTurn(session), true);
  await notifier.checkNow();
  assert.equal(await notifier.deliverAfterRootTurn(session), false);
  assert.deepEqual(attempts, [
    { baseline: "0.158.0", latest: "0.159.0" },
    { baseline: "0.158.0", latest: "0.159.0" }
  ]);

  const restartedAttempts: CodexVersionUpdate[] = [];
  const restarted = new VersionUpdateNotifier({
    readVersion: async () => versions.shift() ?? null,
    deliver: async (_session, update) => { restartedAttempts.push(update); }
  });
  await restarted.checkNow();
  versions.push("0.161.0");
  await restarted.checkNow();
  assert.equal(await restarted.deliverAfterRootTurn(session), true);
  assert.deepEqual(restartedAttempts, [{ baseline: "0.160.0", latest: "0.161.0" }]);
});

test("version checks do not overlap and stopped timers do not fire", async () => {
  let resolveRead: ((value: string) => void) | null = null;
  let readCount = 0;
  const timers = fakeTimer();
  const notifier = new VersionUpdateNotifier({
    readVersion: () => {
      readCount += 1;
      if (readCount > 1) return Promise.resolve("0.158.0");
      return new Promise((resolve) => { resolveRead = resolve; });
    },
    deliver: async () => undefined,
    scheduleInterval: timers.schedule,
    clearScheduledInterval: timers.clear
  });

  const first = notifier.checkNow();
  const second = notifier.checkNow();
  assert.equal(first, second);
  assert.equal(readCount, 1);
  assert.ok(resolveRead);
  (resolveRead as (value: string) => void)("0.158.0");
  await first;

  await notifier.start();
  assert.ok(timers.callback());
  notifier.stop();
  assert.equal(timers.clearCount(), 1);
});
