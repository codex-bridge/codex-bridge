import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { WebNotifications, type NotificationPlatform, type WebAttentionEvent } from "../web/src/lib/notifications.ts";
const { NotificationControl } = await tsImport("../web/src/components/notification-control.tsx", {
  parentURL: import.meta.url, tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url))
}) as typeof import("../web/src/components/notification-control.tsx");

const event: WebAttentionEvent = { id: "turn:one", kind: "turn-ended", sessionId: "session-a", threadId: "a",
  directory: "/project", name: "Project", leaseVersion: 1 };
function fixture(options: { permission?: NotificationPermission; unavailable?: string; stored?: string } = {}) {
  let permission = options.permission ?? "granted";
  let background = true;
  let requested = 0;
  const shown: WebAttentionEvent[] = [], closed: string[] = [];
  const stored = new Map<string, string>();
  if (options.stored) stored.set("codex-bridge:notifications:v1", options.stored);
  const platform: NotificationPlatform = {
    unavailable: options.unavailable ?? null,
    permission: () => permission,
    requestPermission: async () => { requested++; return permission; },
    show: async (value, current) => {
      if (!current()) return null;
      shown.push(value); return () => { closed.push(value.id); };
    }
  };
  const notifications = new WebNotifications(platform, () => background, {
    getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); }
  });
  return { notifications, platform, shown, closed, stored, requested: () => requested,
    background: (value: boolean) => { background = value; }, permission: (value: NotificationPermission) => { permission = value; } };
}

test("notifications require opt-in even when browser permission was already granted", async () => {
  const f = fixture();
  await f.notifications.notify(event, () => true);
  assert.equal(f.shown.length, 0);
  await f.notifications.toggle();
  assert.equal(f.requested(), 1);
  assert.equal(f.notifications.getSnapshot().enabled, true);
  assert.equal(f.stored.get("codex-bridge:notifications:v1"), "true");
  await f.notifications.notify({ ...event, id: "next" }, () => true);
  assert.equal(f.shown.length, 1);
});

test("every approved event kind uses the same background-only, live-only policy", async () => {
  const f = fixture({ stored: "true" });
  const kinds = ["turn-ended", "turn-failed", "approval-required", "input-required", "binding-acquired"] as const;
  for (const kind of kinds) await f.notifications.notify({ ...event, id: kind, kind }, () => true);
  assert.deepEqual(f.shown.map((value) => value.kind), kinds);
  f.background(false);
  await f.notifications.notify({ ...event, id: "foreground" }, () => true);
  f.background(true);
  await f.notifications.notify({ ...event, id: "foreground" }, () => true); // Not replayed on tab change.
  await f.notifications.notify({ ...event, id: "not-current" }, () => false);
  assert.equal(f.shown.length, 5);
});

test("repeated events deduplicate across edits, reconnects and concurrent delivery", async () => {
  const f = fixture({ stored: "true" });
  await Promise.all(Array.from({ length: 5 }, () => f.notifications.notify(event, () => true)));
  await f.notifications.notify(event, () => true);
  assert.equal(f.shown.length, 1);
});

test("withdrawing a session closes its notices and cancels in-flight delivery without touching another session", async () => {
  const f = fixture({ stored: "true" });
  await f.notifications.notify({ ...event, id: "other", sessionId: "session-b" }, () => true);
  let release!: () => void;
  f.platform.show = async (value, current) => {
    await new Promise<void>((resolve) => { release = resolve; });
    if (!current()) return null;
    f.shown.push(value); return () => { f.closed.push(value.id); };
  };
  const sending = f.notifications.notify(event, () => true);
  f.notifications.withdrawSession("session-a");
  release(); await sending;
  assert.deepEqual(f.shown.map((value) => value.id), ["other"]);
  assert.deepEqual(f.closed, []);
  f.notifications.withdrawSession("session-b");
  assert.deepEqual(f.closed, ["other"]);
});

test("lost connection, foregrounding and disabled settings are rechecked after async worker preparation", async () => {
  for (const condition of ["connection", "foreground", "disabled", "disposed"] as const) {
    const f = fixture({ stored: "true" });
    let current = true;
    let release!: () => void;
    f.platform.show = async (value, stillCurrent) => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (stillCurrent()) f.shown.push(value);
      return null;
    };
    const sending = f.notifications.notify(event, () => current);
    if (condition === "connection") current = false;
    if (condition === "foreground") f.background(false);
    if (condition === "disabled") await f.notifications.toggle();
    if (condition === "disposed") f.notifications.dispose();
    release(); await sending;
    assert.equal(f.shown.length, 0, condition);
  }
});

test("permission rejection, revocation and insecure origins fail quietly without repeated prompts", async () => {
  const denied = fixture({ permission: "denied" });
  await denied.notifications.toggle();
  assert.equal(denied.notifications.getSnapshot().enabled, false);
  const insecure = fixture({ unavailable: "HTTPS required" });
  await insecure.notifications.toggle();
  assert.equal(insecure.requested(), 0);
  const enabled = fixture({ stored: "true" });
  await enabled.notifications.notify(event, () => true);
  enabled.permission("denied"); enabled.notifications.refreshPermission();
  assert.equal(enabled.notifications.getSnapshot().enabled, false);
  assert.deepEqual(enabled.closed, [event.id]);
});

test("delivery errors remain local and do not automatically retry", async () => {
  const f = fixture({ stored: "true" });
  let attempts = 0;
  f.platform.show = async () => { attempts++; throw new Error("worker unavailable"); };
  await f.notifications.notify(event, () => true);
  await f.notifications.notify(event, () => true);
  assert.equal(attempts, 1);
  assert.match(f.notifications.getSnapshot().error!, /Notification delivery failed/);
});

test("notification settings are compact, labeled and keyboard-accessible without requiring a connection", () => {
  const f = fixture({ unavailable: "Notifications require HTTPS with a trusted certificate." });
  const html = renderToStaticMarkup(createElement(NotificationControl, { notifications: f.notifications }));
  assert.match(html, /aria-label="Enable notifications"/);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /title="Notifications require HTTPS/);
  assert.doesNotMatch(html, / disabled=/);
});

test("click routing selects a session only; it does not acquire connections or bind sessions", () => {
  const f = fixture();
  const selected: string[] = [];
  f.notifications.onOpen((threadId) => selected.push(threadId));
  f.platform.onOpen?.("other-thread");
  assert.deepEqual(selected, ["other-thread"]);
  f.notifications.dispose();
  f.platform.onOpen?.("closed-thread");
  assert.deepEqual(selected, ["other-thread"]);
});
