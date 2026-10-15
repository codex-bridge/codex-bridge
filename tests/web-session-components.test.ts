import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { sessionControls } from "../web/src/lib/session-controls.ts";
import type { SessionEntry } from "../web/src/lib/protocol.ts";
import type { WorkbenchState } from "../web/src/lib/workbench.ts";

const options = { parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)) };
const { SessionHeader } = await tsImport("../web/src/components/session-header.tsx", options) as
  typeof import("../web/src/components/session-header.tsx");
const { SessionDetails } = await tsImport("../web/src/components/session-details.tsx", options) as
  typeof import("../web/src/components/session-details.tsx");
const { SessionBindingActions } = await tsImport("../web/src/components/session-binding-actions.tsx", options) as
  typeof import("../web/src/components/session-binding-actions.tsx");
const entry: SessionEntry = { threadId: "thread-a", sessionId: "session-a", name: "Project A", directory: "/projects/a",
  archived: false, updatedAt: null, provider: "example", connection: "active", capabilities: { releaseToCodex: true },
  ownership: { state: "active", ownerSourceId: "web:local", pendingSourceId: null, version: 2 } };
const state: WorkbenchState = { connection: "connected", occupied: false, catalog: { directories: [], sessions: [entry] },
  catalogFresh: true, selected: entry.threadId, viewableSessionId: entry.sessionId, ready: true, loading: false,
  catalogError: null, operation: null, feedback: null, timelines: {}, drafts: {}, attachments: {}, queues: {} };
const unexpected = () => assert.fail("render must not invoke a session action");
const props = { selected: entry.threadId, entry, connection: state.connection, catalogFresh: true,
  controls: sessionControls(state), feedback: null, onBind: unexpected, onRelease: unexpected };

test("session header preserves title, directory and no-selection help without opening details", () => {
  const html = renderToStaticMarkup(createElement(SessionHeader, { ...props, onTool: unexpected }));
  assert.match(html, /<h2>Project A<\/h2>/u);
  assert.match(html, /title="\/projects\/a">\/projects\/a/u);
  assert.match(html, /aria-label="Session tools"/u);
  assert.match(html, /aria-label="Session details"[^>]*aria-haspopup="dialog" aria-expanded="false"/u);
  assert.doesNotMatch(html, /role="dialog"|Release to external Codex/u);
  for (const [selected, expected] of [[null, "Select a session"], ["missing", "Locate session"]] as const) {
    const missing = renderToStaticMarkup(createElement(SessionHeader, {
      ...props, selected, entry: undefined, controls: sessionControls({ ...state, selected }), onTool: unexpected
    }));
    assert.ok(missing.includes(`<h2>${expected}</h2>`));
    assert.equal(missing.includes('aria-label="Session selection help"'), selected === null);
    assert.equal(missing.includes('aria-label="Session details"'), selected !== null);
  }
});

test("session details show only protocol-backed identity, connection and ownership data", () => {
  const longPath = "/projects/" + "long-directory/".repeat(30);
  const html = renderToStaticMarkup(createElement(SessionDetails, {
    ...props, entry: { ...entry, directory: longPath }, onClose: unexpected
  }));
  assert.match(html, /data-variant="drawer" role="dialog" aria-modal="true"/u);
  assert.match(html, /aria-label="Close session details"/u);
  assert.ok(html.includes(longPath));
  for (const [label, value] of [["Thread ID", "thread-a"], ["Codex session ID", "session-a"], ["Provider", "example"],
    ["Service connection", "Connected"], ["Codex connection", "Loaded"], ["Owner", "web:local"],
    ["Ownership state", "active"], ["Waiting source", "None"]]) {
    assert.ok(html.includes(`<dt>${label}</dt><dd>${value}</dd>`));
  }
  assert.match(html, />Release to external Codex<\/button>/u);
  assert.doesNotMatch(html, /Token|Cost|Changed files|stale/u);
});

test("unavailable and stale details do not claim known loaded or ownership status", () => {
  for (const connection of ["idle", "connecting", "offline", "revoked", "connected"] as const) {
    const current = { ...state, connection, catalogFresh: connection !== "connected" };
    const html = renderToStaticMarkup(createElement(SessionDetails, {
      ...props, connection, catalogFresh: current.catalogFresh, controls: sessionControls(current), onClose: unexpected
    }));
    assert.match(html, /information is last reported and may be stale/u);
    assert.match(html, /<dt>Codex connection<\/dt><dd>Unknown<\/dd>/u);
    assert.match(html, /disabled=""[^>]*>Release to external Codex/u);
  }
  const missing = renderToStaticMarkup(createElement(SessionDetails, {
    ...props, entry: undefined, controls: sessionControls({ ...state, catalog: null }), onClose: unexpected
  }));
  assert.match(missing, /temporarily unavailable/u);
  assert.match(missing, /<dt>Thread ID<\/dt><dd>thread-a<\/dd>/u);
  assert.match(missing, /<dt>Owner<\/dt><dd>Unknown<\/dd>/u);
  assert.doesNotMatch(missing, /Release to external Codex|>Bind session<\/button>/u);
});

test("shared binding controls preserve pending labels and disabled states on both surfaces", () => {
  const pending = { ...entry, ownership: { state: "handoff_pending", ownerSourceId: "tg:other",
    pendingSourceId: "web:local", version: 3 } };
  for (const busy of [false, true]) {
    const current = { ...state, catalog: { directories: [], sessions: [pending] },
      operation: busy ? { kind: "binding" as const, threadId: "thread-a" } : null };
    const controls = sessionControls(current);
    const bindingHtml = renderToStaticMarkup(createElement(SessionBindingActions, { controls, onBind: unexpected }));
    assert.ok(bindingHtml.includes(`>${busy ? "Working…" : "Request again"}</button>`));
    assert.match(bindingHtml, />Cancel wait<\/button>/u);
    assert.equal((bindingHtml.match(/disabled=""/gu) ?? []).length, busy ? 2 : 0);
    for (const component of [SessionHeader, SessionDetails]) {
      const html = renderToStaticMarkup(createElement(component, {
        ...props, entry: pending, controls, onTool: unexpected, onClose: unexpected
      }));
      assert.ok(html.includes(bindingHtml));
    }
  }
});

test("details keep operation outcomes visible and disable release after ownership transfers", () => {
  const transferred = { ...entry, ownership: { state: "active", ownerSourceId: "slack:other", pendingSourceId: null, version: 3 } };
  const controls = sessionControls({ ...state, catalog: { directories: [], sessions: [transferred] } });
  for (const tone of ["neutral", "error"] as const) {
    const html = renderToStaticMarkup(createElement(SessionDetails, {
      ...props, entry: transferred, controls, onClose: unexpected,
      feedback: { source: "operation", surface: "conversation", tone, message: "Operation receipt", threadId: "thread-a" }
    }));
    assert.ok(html.includes(`<p role="${tone === "error" ? "alert" : "status"}">Operation receipt</p>`));
    assert.match(html, /disabled=""[^>]*>Release to external Codex/u);
    assert.match(html, /<dt>Owner<\/dt><dd>slack:other<\/dd>/u);
    assert.match(html, />Bind session<\/button>/u);
  }
});
