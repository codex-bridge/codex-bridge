import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import type { CatalogActions } from "../web/src/lib/catalog-actions.ts";

// Use the frontend JSX settings without changing the backend test loader.
const options = { parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)) };
const { WorkbenchShell } = await tsImport("../web/src/components/workbench-shell.tsx", options) as
  typeof import("../web/src/components/workbench-shell.tsx");
const { ServiceConnectionControl } = await tsImport("../web/src/components/service-connection-control.tsx", options) as
  typeof import("../web/src/components/service-connection-control.tsx");
const { SessionCatalog } = await tsImport("../web/src/components/session-catalog.tsx", options) as
  typeof import("../web/src/components/session-catalog.tsx");

test("workbench shell composes navigation and conversation without introducing another layout wrapper", () => {
  const html = renderToStaticMarkup(createElement(WorkbenchShell, {
    navigation: createElement("aside", { "aria-label": "Directories and sessions" }, "Navigation"),
    children: createElement("header", null, "Conversation tools")
  }));
  assert.equal(html, '<main class="workbench"><aside aria-label="Directories and sessions">Navigation</aside>' +
    '<section class="conversation" aria-label="Conversation"><header>Conversation tools</header></section></main>');
});

for (const [connection, label, action, disabled, warning] of [
  ["idle", "Disconnected", "Connect to service", false, false],
  ["connecting", "Connecting", "Connecting…", true, false],
  ["offline", "Network offline", "Connect to service", false, true],
  ["revoked", "Connection expired", "Connect to service", false, true]
] as const) {
  test(`service connection control preserves the ${connection} state`, () => {
    const html = renderToStaticMarkup(createElement(ServiceConnectionControl, {
      connection, occupied: false, onConnect: () => assert.fail("rendering must not connect")
    }));
    assert.match(html, /class="connection-expanded"/u);
    assert.ok(html.includes(`data-tone="${warning ? "warning" : "neutral"}">${label}</p>`));
    assert.ok(html.includes(`>${action}</button>`));
    assert.equal(html.includes('disabled=""'), disabled);
    assert.match(html, /It does not claim any session/u);
  });
}

test("service connection takeover is explicit and cannot be submitted while connecting", () => {
  for (const connection of ["idle", "offline", "revoked", "connecting"] as const) {
    const html = renderToStaticMarkup(createElement(ServiceConnectionControl, {
      connection, occupied: true, onConnect: () => assert.fail("rendering must not take over")
    }));
    assert.equal(html.includes("Take over service connection"), connection !== "connecting");
    assert.equal(html.includes('disabled=""'), connection === "connecting");
  }
});

test("connected service control is compact and does not offer another connect or takeover action", () => {
  const html = renderToStaticMarkup(createElement(ServiceConnectionControl, {
    connection: "connected", occupied: true, onConnect: () => assert.fail("rendering must not reconnect")
  }));
  assert.match(html, /class="connection-status connection-status-compact"/u);
  assert.match(html, />Connected<\/p>/u);
  assert.doesNotMatch(html, /connection-expanded|Take over service connection|>Connect to service</u);
});

test("catalog places the supplied connection control without owning its actions", () => {
  const actions = new Proxy({} as CatalogActions, { get: () => assert.fail("rendering must not invoke catalog actions") });
  for (const connection of ["idle", "connected"] as const) {
    const html = renderToStaticMarkup(createElement(SessionCatalog, {
      actions, catalog: null, catalogFresh: false, catalogError: null, connection,
      serviceConnection: createElement("span", null, "Connection slot"),
      selected: null, busy: false, operation: null, directoryFeedback: null
    }));
    assert.equal(html.split("Connection slot").length - 1, 1);
    if (connection === "connected") {
      assert.match(html, /class="sidebar-utilities"><span>Connection slot<\/span>/u);
    } else {
      assert.match(html, /<\/div><span>Connection slot<\/span>/u);
    }
    assert.doesNotMatch(html, /Connect to service|Take over service connection/u);
  }
});
