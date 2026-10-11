import assert from "node:assert/strict";
import test from "node:test";
import { LocalComposerDraftStore } from "../web/src/lib/composer-drafts.ts";

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); }
  };
}

test("tab composer text drafts restore per session, clear on empty and stay bounded", () => {
  const state = storage();
  const drafts = new LocalComposerDraftStore(state, undefined, () => 100, () => "tab-one");
  drafts.saveText("a", "alpha");
  drafts.saveText("b", "beta");
  assert.equal(new LocalComposerDraftStore(state, undefined, () => 100, () => "unused").loadText("a"), "alpha");
  assert.equal(drafts.loadText("b"), "beta");
  drafts.saveText("a", "");
  assert.equal(drafts.loadText("a"), "");
  for (let index = 0; index < 25; index++) drafts.saveText(`thread-${index}`, `draft-${index}`);
  const stored = JSON.parse(state.data.get("codex-bridge:composer-text:v1")!);
  assert.equal(stored.length, 20);
  assert.equal(drafts.loadText("thread-4"), "");
  assert.equal(drafts.loadText("thread-24"), "draft-24");
});

test("expired, malformed or disabled composer text storage is pruned without blocking input", () => {
  let now = 1;
  const state = storage();
  const drafts = new LocalComposerDraftStore(state, undefined, () => now, () => "tab-one");
  drafts.saveText("a", "alpha");
  now += 8 * 24 * 60 * 60 * 1000;
  assert.equal(drafts.loadText("a"), "");
  state.setItem("codex-bridge:composer-text:v1", "not json");
  assert.equal(drafts.loadText("a"), "");
  const disabled = new LocalComposerDraftStore({
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("full"); },
    removeItem: () => { throw new Error("blocked"); }
  }, undefined, () => now, () => "tab-two");
  assert.doesNotThrow(() => disabled.saveText("a", "alpha"));
  assert.equal(disabled.loadText("a"), "");
});
