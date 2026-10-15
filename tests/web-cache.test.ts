import assert from "node:assert/strict";
import test from "node:test";
import { LocalTimelineCache } from "../web/src/lib/cache.ts";
import { dialogueText, restoreHistory, type TimelineItem } from "../web/src/lib/timeline.ts";

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
const item = (text: string, kind: "codex" | "progress" = "codex"): TimelineItem => ({ id: text, origin: "live",
  message: { title: "Run", kind, actions: [{ id: "secret", label: "x", callback: "private-token" }], body: [{ type: "text", text }] } });
test("local cache persists bounded historical text, never callbacks, decisions or ambiguous sends", () => {
  const s = storage(), cache = new LocalTimelineCache(s);
  cache.save("a", "session-a", [item("good"), { ...item("pending"), deliveryStatus: "sending" }, { ...item("unknown"), deliveryStatus: "unknown" },
    { ...item("approval"), message: { ...item("approval").message, decision: { id: "secret", state: "pending", requestedFields: [], availableActions: ["accept"], requiresUserInput: false, inputAllowed: false } } }]);
  assert.equal(cache.load("a", "session-a").length, 1);
  assert.equal(cache.load("a", "different-session").length, 0);
  const raw = [...s.data.values()].join();
  assert.equal(raw.includes("private-token"), false);
  assert.equal(raw.includes("decision"), false);
  assert.equal(raw.includes("unknown"), false);
  assert.deepEqual(cache.load("a", "session-a")[0]!.message.actions, []);
  for (let index = 0; index < 25; index++) cache.save(`t${index}`, `s${index}`, Array.from({ length: 130 }, (_, n) => item(`message ${n}`)));
  const parsed = JSON.parse([...s.data.values()][0]!);
  assert.equal(parsed.length, 20); assert.equal(parsed[19].items.length, 100);
  assert.ok(new TextEncoder().encode([...s.data.values()][0]!).length <= 512 * 1024);
});
test("expired/malformed/disabled cache is optional and pruned, with a total byte cap", () => {
  let now = 1;
  const s = storage(), cache = new LocalTimelineCache(s, () => now);
  cache.save("a", "s", [item("hello")]); now += 8 * 24 * 60 * 60 * 1000;
  assert.deepEqual(cache.load("a", "s"), []); assert.equal([...s.data.values()][0], "[]");
  s.setItem("codex-bridge:timeline:v2", "invalid json");
  assert.deepEqual(cache.load("a", "s"), []);
  const broken = new LocalTimelineCache({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => {} });
  assert.doesNotThrow(() => broken.save("a", "s", [item("hello")])); assert.deepEqual(broken.load("a", "s"), []);
  s.data.clear();
  cache.save("big", "s", Array.from({ length: 100 }, (_, index) => ({ ...item(`id${index}`), message: {
    ...item("").message, body: [{ type: "text", text: "€".repeat(12000) }] } })));
  assert.ok(new TextEncoder().encode([...s.data.values()][0]!).length <= 512 * 1024);
});
test("cache history requires contiguous overlap; repeated go and unanchored statistics are not invented as dialogue", () => {
  const items = [item("old"), item("go"), item("Runs ×2", "progress"), item("answer")].map((entry) => ({ ...entry, origin: "cache" as const }));
  const history = { threadId: "t", sessionId: "s", leaseVersion: 1, messages: [{ role: "assistant" as const, text: "go" }, { role: "assistant" as const, text: "answer" }] };
  const restored = restoreHistory(items, history);
  assert.deepEqual(restored.map((entry) => entry.id), ["old", "go", "Runs ×2", "answer"]);
  assert.deepEqual(restoreHistory(restored, history).map((entry) => entry.id), restored.map((entry) => entry.id));
  assert.deepEqual(restoreHistory(items, { ...history, messages: [{ role: "assistant", text: "unrelated" }] }).map((entry) => dialogueText(entry.message)), ["unrelated", "Runs ×2"]);
});

test("ambiguous v1 cache is preserved but cannot contaminate current history restoration", () => {
  const s = storage(), cache = new LocalTimelineCache(s);
  const legacy = JSON.stringify([{ threadId: "a", sessionId: "s", savedAt: Date.now(),
    items: [item("Working · Done · 9s"), item("reply")] }]);
  s.setItem("codex-bridge:timeline:v1", legacy);
  assert.deepEqual(cache.load("a", "s"), []);
  const history = { threadId: "a", sessionId: "s", leaseVersion: 1,
    messages: [{ role: "assistant" as const, text: "reply" }] };
  const restored = restoreHistory(cache.load("a", "s"), history);
  cache.save("a", "s", restored);
  assert.deepEqual(cache.load("a", "s").map(entry => dialogueText(entry.message)), ["reply"]);
  assert.equal(s.getItem("codex-bridge:timeline:v1"), legacy);
});
