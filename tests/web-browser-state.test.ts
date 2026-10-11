import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSessionLocation, TabWindowGrantStore } from "../web/src/lib/browser-state.ts";

test("session URLs roundtrip opaque IDs and retain unrelated query/hash; back navigation is read-only", () => {
  const location = { href: "http://127.0.0.1:8787/?other=keep#anchor" };
  const writes: string[] = [];
  const listeners = new Set<() => void>();
  const browser = { location: location as Location, history: { pushState: (_: unknown, __: string, url: URL) => {
    location.href = url.href; writes.push(url.href);
  } } as unknown as History, addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
  removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); } };
  const route = new BrowserSessionLocation(browser as unknown as Window);
  assert.equal(route.read(), null);
  const id = "thread /?#café";
  route.write(id);
  assert.equal(route.read(), id);
  assert.equal(new URL(location.href).searchParams.get("other"), "keep");
  assert.equal(new URL(location.href).hash, "#anchor");
  route.write(id);
  assert.equal(writes.length, 1);
  let selected: string | null = id;
  const unsubscribe = route.subscribe(() => { selected = route.read(); });
  location.href = "http://127.0.0.1:8787/?session=prior";
  for (const listener of listeners) listener();
  assert.equal(selected, "prior");
  assert.equal(writes.length, 1);
  unsubscribe(); assert.equal(listeners.size, 0);
  route.write(null); assert.equal(route.read(), null);
});

test("tab grants are consumed once, limited to credentials and optional when storage fails", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const store = new TabWindowGrantStore(storage);
  const grant = { windowId: "tab", token: "test-token" };
  store.save({ ...grant, extra: "not stored" } as typeof grant);
  const key = [...data.keys()][0]!;
  assert.deepEqual(JSON.parse(data.get(key)!), grant);
  assert.deepEqual(store.take(), grant);
  assert.equal(store.take(), null);
  for (const raw of ["broken", "null", "[]", "{}", '{"windowId":"tab","token":1}',
    '{"windowId":"bad id","token":"test"}', "x".repeat(1025)]) {
    data.set(key, raw); assert.equal(store.take(), null); assert.equal(data.size, 0);
  }
  store.save(grant); store.clear(); assert.equal(store.take(), null);
  const disabled = new TabWindowGrantStore({ getItem: () => { throw new Error("disabled"); },
    setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("disabled"); } });
  disabled.save(grant); disabled.clear(); assert.equal(disabled.take(), null);
});
