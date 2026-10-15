import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import type { CatalogActions } from "../web/src/lib/catalog-actions.ts";
import type { SessionCatalogProps } from "../web/src/components/session-catalog.tsx";

const options = { parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)) };
const { DirectorySection } = await tsImport("../web/src/components/directory-section.tsx", options) as
  typeof import("../web/src/components/directory-section.tsx");
const { SessionCatalog } = await tsImport("../web/src/components/session-catalog.tsx", options) as
  typeof import("../web/src/components/session-catalog.tsx");
const { AddDirectoryDialog, SessionManagementDialog } = await tsImport("../web/src/components/session-dialogs.tsx", options) as
  typeof import("../web/src/components/session-dialogs.tsx");
const unexpected = () => assert.fail("rendering must not invoke an action");
const actions: CatalogActions = { refresh: unexpected, select: unexpected, addDirectory: unexpected,
  createSession: unexpected, manageSession: unexpected };
const catalogProps: SessionCatalogProps = { actions, connection: "connected", catalogFresh: true,
  catalogError: null, serviceConnection: null, selected: null, busy: false, operation: null, directoryFeedback: null,
  catalog: { directories: ["/empty"], sessions: [] } };

test("directory sections preserve independent loaded and controlled expansion state", () => {
  const directory = "/projects/" + "long-parent/".repeat(20) + "current";
  for (const expanded of [false, true]) {
    const html = renderToStaticMarkup(createElement(DirectorySection, {
      directory, open: false, expanded, onToggle: unexpected, onCreate: unexpected,
      createDisabled: false, children: createElement("p", null, "Session content")
    }));
    assert.ok(html.includes(`data-open="false" data-expanded="${expanded}"`));
    assert.ok(html.includes(`aria-expanded="${expanded}"`));
    assert.ok(html.includes(`title="${directory}"`));
    assert.match(html, /class="directory-name">current<\/span>/u);
    assert.equal(html.includes("Session content"), expanded);
    assert.match(html, /title="New session"/u);
  }
});

test("directory sections can omit creation and preserve an explicitly disabled create action", () => {
  for (const onCreate of [undefined, unexpected]) {
    const html = renderToStaticMarkup(createElement(DirectorySection, {
      directory: "/empty", open: true, expanded: true, onToggle: unexpected, onCreate,
      createDisabled: true, children: createElement("p", { className: "directory-empty muted" }, "No sessions")
    }));
    assert.match(html, /data-open="true"/u);
    assert.match(html, />No sessions<\/p>/u);
    assert.equal(html.includes('title="New session"'), !!onCreate);
    assert.equal(html.includes('disabled=""'), !!onCreate);
  }
});

test("catalog keeps unavailable, failed and empty inventory states distinct", () => {
  const empty = renderToStaticMarkup(createElement(SessionCatalog, { ...catalogProps, catalog: { directories: [], sessions: [] } }));
  assert.match(empty, /No directories yet\./u);
  const loading = renderToStaticMarkup(createElement(SessionCatalog, { ...catalogProps, catalog: null }));
  assert.match(loading, /Loading directories…/u);
  assert.doesNotMatch(loading, /No directories yet/u);
  const failed = renderToStaticMarkup(createElement(SessionCatalog, { ...catalogProps, catalog: null, catalogError: "unavailable" }));
  assert.match(failed, /Failed to load directories\./u);
  assert.match(failed, />Retry<\/button>/u);
  for (const patch of [{ connection: "offline" as const }, { catalogFresh: false }, { busy: true }]) {
    const html = renderToStaticMarkup(createElement(SessionCatalog, { ...catalogProps, ...patch }));
    assert.match(html, /aria-label="Create a session in \/empty"[^>]*disabled=""/u);
    assert.equal(html.includes("The list below may be stale."), patch.catalogFresh === false);
  }
});

test("catalog renders all registered directory groups in established order without dropping long labels", () => {
  const directories = Array.from({ length: 80 }, (_, index) => `/projects/${String(index).padStart(3, "0")}-${"long-name-".repeat(8)}`);
  const html = renderToStaticMarkup(createElement(SessionCatalog, {
    ...catalogProps, catalog: { directories: [...directories].reverse(), sessions: [] }
  }));
  assert.equal((html.match(/class="directory"/gu) ?? []).length, 80);
  let previous = -1;
  for (const directory of directories) {
    const position = html.indexOf(`aria-label="Expand directory ${directory}"`);
    assert.ok(position > previous, "directory order must not follow the reversed input order");
    previous = position;
  }
});

test("directory and session forms render with only their own operation callbacks", () => {
  const directory = renderToStaticMarkup(createElement(AddDirectoryDialog, {
    onAddDirectory: unexpected, busy: false, operation: null, feedback: null,
    onClose: unexpected, onAdded: unexpected
  }));
  assert.match(directory, /id="directory-path"/u);
  const creation = renderToStaticMarkup(createElement(SessionManagementDialog, {
    onConfirm: unexpected, busy: true, operation: { kind: "session-create" },
    dialog: { kind: "create", directory: "/target-directory" }, onClose: unexpected
  }));
  assert.match(creation, /<code>\/target-directory<\/code>/u);
  assert.match(creation, /disabled=""[^>]*>Working…<\/button>/u);
});
