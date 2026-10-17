import assert from "node:assert/strict";
import test from "node:test";

import type { ProgressPhaseMessageRecord, ProgressPhaseOperationGroup, ProgressPhaseState } from "../src/shared/types.js";
import { createProgressPhaseSummarySpec, formatProgressMessageLines } from "../src/bridge/renderers/progress.js";
import { createMessage } from "../src/bridge/messages/factory.js";
import {
  TEMPORARY_MESSAGE_BODY_MAX_LENGTH,
  truncateTemporaryMessageSpec
} from "../src/bridge/messages/temporary.js";
import { extractProgressEvent, extractStatusUpdate, extractTurnLifecycleEvent } from "../src/codex/notification-events.js";
import {
  extractProgressChanges,
  extractProgressInput,
  extractProgressTarget,
  extractProgressToolName
} from "../src/codex/extractors/progress.js";

test("truncates temporary message bodies by one character limit without line rules", () => {
  const spec = createMessage({
    scope: "global",
    kind: "progress",
    body: [{ type: "text", text: "€".repeat(TEMPORARY_MESSAGE_BODY_MAX_LENGTH + 50) }]
  });
  const truncated = truncateTemporaryMessageSpec(spec);

  assert.equal(Array.from(truncated.body[0]?.type === "text" ? truncated.body[0].text : "").length, TEMPORARY_MESSAGE_BODY_MAX_LENGTH);
  assert.match(truncated.body[0]?.type === "text" ? truncated.body[0].text : "", /…$/);
});

test("preserves failed and interrupted turn terminal states", () => {
  const failed = extractTurnLifecycleEvent({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", status: "failed" } }
  });
  const interrupted = extractTurnLifecycleEvent({
    method: "turn/completed",
    params: { threadId: "thread", turn: { id: "turn", status: "cancelled" } }
  });

  assert.equal(failed?.terminalState, "failed");
  assert.equal(interrupted?.terminalState, "interrupted");
});

test("renders official MCP server and tool fields with a semantic element description", () => {
  const item = {
    type: "mcpToolCall",
    server: "playwright",
    tool: "browser_click",
    arguments: {
      target: "f1e348",
      element: "agent1@example.test · AGENT1 candidate"
    }
  };

  const toolName = extractProgressToolName(item);
  const input = extractProgressInput(item);
  assert.equal(toolName, "playwright.browser_click");
  assert.equal(extractProgressTarget(item), "agent1@example.test · AGENT1 candidate");
  assert.equal(input, "element=agent1@example.test · AGENT1 candidate");
  assert.deepEqual(
    formatProgressMessageLines({
      directory: "/Users/example/workspace/projects/api-service",
      event: {
        label: "Called",
        toolName,
        target: extractProgressTarget(item),
        input,
        changes: null,
        failed: false,
        text: "clicked"
      }
    }),
    [
      "Called · .../projects/api-service",
      "playwright.browser_click",
      "element=agent1@example.test · AGENT1 candidate"
    ]
  );
});

test("shows MCP scalar argument values instead of only argument keys", () => {
  const item = {
    type: "mcpToolCall",
    server: "playwright",
    tool: "browser_network_request",
    arguments: { index: 1, part: "request-body" }
  };

  assert.equal(extractProgressToolName(item), "playwright.browser_network_request");
  assert.equal(extractProgressInput(item), "index=1 part=request-body");
});

test("normalizes called progress titles into tool names", () => {
  const item = {
    type: "mcp",
    title: "Called · playwright.browser_network_requests",
    arguments: { index: 1, part: "response-body" }
  };
  const toolName = extractProgressToolName(item);

  assert.equal(toolName, "playwright.browser_network_requests");
  assert.deepEqual(
    formatProgressMessageLines({
      directory: "/Users/example/workspace/projects/api-service",
      event: {
        label: "Called",
        toolName,
        target: extractProgressTarget(item),
        input: extractProgressInput(item),
        changes: null,
        failed: false,
        text: "called"
      }
    }),
    [
      "Called · .../projects/api-service",
      "playwright.browser_network_requests",
      "index=1 part=response-body"
    ]
  );
});

test("keeps an opaque target only when no semantic argument is available", () => {
  assert.equal(
    extractProgressInput({
      type: "mcpToolCall",
      server: "playwright",
      tool: "browser_click",
      arguments: { target: "f1e348" }
    }),
    "target=f1e348"
  );
});

test("shows a tool call when app-server only provides start metadata", () => {
  const event = extractProgressEvent({
    method: "item/started",
    params: {
      threadId: "thread-1",
      item: {
        type: "mcpToolCall",
        server: "serena",
        tool: "list_memories",
        arguments: {}
      }
    }
  });

  assert.ok(event);
  assert.equal(event.label, "Called");
  assert.equal(event.toolName, "serena.list_memories");
  assert.equal(event.text, "Tool call started.");
});

test("keeps a tool call visible when completion has no output payload", () => {
  const event = extractProgressEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: {
        type: "mcpToolCall",
        server: "serena",
        tool: "list_memories",
        arguments: {}
      }
    }
  });

  assert.ok(event);
  assert.equal(event.toolName, "serena.list_memories");
  assert.equal(event.text, "Tool call observed.");
});

test("does not classify view_image paths as file changes", () => {
  const event = extractProgressEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: {
        type: "toolCall",
        toolName: "view_image",
        path: "/workspace/project/image.png",
        arguments: { path: "/workspace/project/image.png" }
      }
    }
  });

  assert.ok(event);
  assert.equal(event.label, "Called");
  assert.equal(event.changes, null);
});

test("does not classify read-only MCP paths as file changes", () => {
  const event = extractProgressEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: {
        type: "mcpToolCall",
        server: "filesystem",
        tool: "read_file",
        path: "/workspace/project/src/index.ts",
        arguments: { path: "/workspace/project/src/index.ts" }
      }
    }
  });

  assert.ok(event);
  assert.equal(event.label, "Called");
  assert.equal(event.changes, null);
});

test("unknown item types cannot imply a file edit or command from their spelling", () => {
  const unknownEdit = { type: "previewEdit", path: "/workspace/project/src/index.ts", diff: "@@\n+new" };
  assert.equal(extractProgressEvent({
    method: "item/completed",
    params: { threadId: "thread-1", item: unknownEdit }
  }), null);
  assert.equal(extractStatusUpdate({
    method: "item/started",
    params: { threadId: "thread-1", item: unknownEdit }
  })?.label, null);

  const namedUnknown = extractProgressEvent({
    method: "item/completed",
    params: { threadId: "thread-1", item: {
      type: "previewEdit",
      toolName: "mcp__editor.inspect",
      path: "/workspace/project/src/index.ts",
      diff: "@@\n+new"
    } }
  });
  assert.equal(namedUnknown?.label, "Called");
  assert.equal(namedUnknown?.changes, null);
  assert.notEqual(namedUnknown?.action, "write");
});

test("typed context compaction is status activity, not a progress tool", () => {
  const notification = { method: "item/started", params: {
    threadId: "thread-1", item: { type: "ContextCompaction" }
  } };
  assert.equal(extractStatusUpdate(notification)?.activity, "contextCompaction");
  assert.equal(extractStatusUpdate(notification)?.label, "Compacting");
  assert.equal(extractProgressEvent(notification), null);
});

test("keeps apply_patch path changes classified as edited", () => {
  const event = extractProgressEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: {
        type: "toolCall",
        toolName: "apply_patch",
        path: "/workspace/project/src/index.ts",
        diff: "@@\n-old\n+new"
      }
    }
  });

  assert.ok(event);
  assert.equal(event.label, "Edited");
  assert.deepEqual(event.changes, [{
    path: "/workspace/project/src/index.ts",
    type: "toolCall",
    added: 1,
    removed: 1,
    lineStatsAvailable: true,
    diffPreview: "@@\n-old\n+new"
  }]);
});

test("shows a command execution from its start metadata", () => {
  const event = extractProgressEvent({
    method: "item/started",
    params: {
      threadId: "thread-1",
      item: {
        type: "commandExecution",
        command: "yarn lint",
        cwd: "/workspace/project"
      }
    }
  });

  assert.ok(event);
  assert.equal(event.label, "Run");
  assert.equal(event.toolName, "yarn lint");
  assert.equal(event.input, "cwd=/workspace/project");
  assert.equal(event.text, "Tool call started.");
});

test("shows a current file change item as an edited preview", () => {
  const event = extractProgressEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: {
        type: "fileChange",
        status: "completed",
        changes: [{
          path: "/Users/example/workspace/src/project/src/index.ts",
          kind: "update",
          diff: "@@\n-old\n+new"
        }]
      }
    }
  });

  assert.ok(event);
  assert.equal(event.label, "Edited");
  assert.deepEqual(event.changes, [{
    path: "/Users/example/workspace/src/project/src/index.ts",
    type: "update",
    added: 1,
    removed: 1,
    lineStatsAvailable: true,
    diffPreview: "@@\n-old\n+new"
  }]);
});

test("shows structured file change patch updates without an item wrapper", () => {
  const event = extractProgressEvent({
    method: "item/fileChange/patchUpdated",
    params: {
      threadId: "thread-1",
      itemId: "edit-1",
      changes: [{
        path: "/Users/example/workspace/src/project/src/index.ts",
        kind: "update",
        diff: "@@\n+new"
      }]
    }
  });

  assert.ok(event);
  assert.equal(event.label, "Edited");
  assert.equal(event.text, "File changes updated.");
  assert.deepEqual(event.changes, [{
    path: "/Users/example/workspace/src/project/src/index.ts",
    type: "update",
    added: 1,
    removed: 0,
    lineStatsAvailable: true,
    diffPreview: "@@\n+new"
  }]);
});

test("shows web searches as explored progress with their query", () => {
  const event = extractProgressEvent({
    method: "item/started",
    params: {
      threadId: "thread-1",
      item: {
        type: "webSearch",
        action: "search",
        query: "Codex app-server web search"
      }
    }
  });

  assert.ok(event);
  assert.equal(event.label, "Explored");
  assert.equal(event.target, "Codex app-server web search");
  assert.equal(event.input, "query=Codex app-server web search action=search");
  assert.equal(event.text, "search: Codex app-server web search");
  assert.deepEqual(
    formatProgressMessageLines({
      directory: "/Users/example/workspace/src/project",
      event
    }),
    [
      "Explored · .../src/project",
      "Codex app-server web search",
      "query=Codex app-server web search action=search"
    ]
  );
});

test("retains Explored as the terminal phase title", () => {
  const summary = createProgressPhaseSummarySpec({
    directory: "/Users/example/workspace/src/project",
    record: {
      id: "phase-1",
      sessionId: "session-1",
      codexThreadId: "thread-1",
      turnId: "turn-1",
      phaseSeq: 1,
      phaseKind: "explored",
      sourceId: "chat",
      platformMessageId: "1",
      directory: "/Users/example/workspace/src/project",
      text: "",
      updateCount: 1,
      aggregate: {
        eventCount: 1,
        operations: [],
        files: {},
        run: { updates: 0, succeeded: 0, failed: 0 },
        explored: {}
      },
      state: "phase_complete",
      failureReason: null,
      deliveryState: "synced",
      correctionMessageId: null,
      startedAt: 1,
      finishedAt: 2,
      updatedAt: 2
    }
  });

  assert.equal(summary.title, "Explored · .../src/project");
  assert.deepEqual(summary.body, [
    { type: "text", text: "1 event" }
  ]);
});

test("normal phase summaries omit the completion phrase and retain a nonempty aggregate", () => {
  const record = {
    id: "phase-1",
    sessionId: "session-1",
    codexThreadId: "thread-1",
    turnId: "turn-1",
    phaseSeq: 1,
    phaseKind: "run" as const,
    sourceId: "chat",
    platformMessageId: "1",
    directory: "/workspace/project",
    text: "",
    updateCount: 1,
    aggregate: {
      eventCount: 1,
      operations: [],
      files: {},
      run: { updates: 0, succeeded: 0, failed: 0 },
      explored: {}
    },
    state: "phase_complete" as const,
    failureReason: null,
    deliveryState: "synced" as const,
    correctionMessageId: null,
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2
  };
  const render = (phaseKind: "run" | "called" | "edited" | "explored" | "system") =>
    createProgressPhaseSummarySpec({ directory: record.directory, record: { ...record, phaseKind } });

  assert.deepEqual(render("run").body, [
    { type: "text", text: "Run ×1 · Reported successes ×0 · Reported failures ×0" }
  ]);
  assert.deepEqual(createProgressPhaseSummarySpec({
    directory: record.directory,
    record: {
      ...record,
      aggregate: { ...record.aggregate, run: { updates: 9, succeeded: 3, failed: 0 } }
    }
  }).body, [
    { type: "text", text: "Run ×10 · Reported successes ×3 · Reported failures ×0" }
  ]);
  for (const kind of ["called", "edited", "explored", "system"] as const) {
    assert.deepEqual(render(kind).body, [{ type: "text", text: "1 event" }]);
  }

  assert.deepEqual(createProgressPhaseSummarySpec({
    directory: record.directory,
    record: { ...record, state: "interrupted" }
  }).body, [
    { type: "text", text: "Interrupted" },
    { type: "text", text: "Run ×1 · Reported successes ×0 · Reported failures ×0" }
  ]);

  for (const state of ["step_failed", "failed"] as const) {
    for (const failureReason of [null, "other_failure", "timeout", "permission_denied"] as const) {
      const summary = createProgressPhaseSummarySpec({
        directory: record.directory,
        record: {
          ...record, state, failureReason,
          aggregate: { ...record.aggregate, run: { updates: 0, succeeded: 0, failed: 1 } }
        }
      });
      assert.equal(summary.title, "Run · /workspace/project");
      assert.deepEqual(summary.body, [
        { type: "text", text: "Completed" },
        { type: "text", text: "Run ×1 · Reported successes ×0 · Reported failures ×1" },
        ...(failureReason === "timeout" ? [{ type: "text", text: "Reason: timeout" }] : []),
        ...(failureReason === "permission_denied" ? [{ type: "text", text: "Reason: permission denied" }] : []),
        ...(state === "step_failed" ? [{ type: "text", text: "Task continued" }] : [])
      ]);
      assert.deepEqual(formatProgressMessageLines({
        directory: record.directory,
        event: {
          label: "Run", toolName: "yarn test", input: null, target: null,
          changes: null, failed: true, text: "raw secret stderr", failureReason
        }
      }), [
        "Run · /workspace/project", "yarn test", "Completed",
        ...(failureReason === "timeout" ? ["Reason: timeout"] : []),
        ...(failureReason === "permission_denied" ? ["Reason: permission denied"] : [])
      ]);
    }
  }
});

test("Called summaries keep explicit tool failures in sequence and put the error last", async (t) => {
  const runCode = "playwright.browser_run_code_unsafe";
  const screenshot = "playwright.browser_take_screenshot";
  const cases: Array<{
    name: string;
    operations: ProgressPhaseOperationGroup[];
    state: ProgressPhaseState;
    failureReason: ProgressPhaseMessageRecord["failureReason"];
    expected: string[];
  }> = [
    {
      name: "same-tool failure remains separate from earlier events",
      operations: [{ name: runCode, count: 1 }, { name: runCode, count: 1, failed: true }],
      state: "step_failed", failureReason: "timeout",
      expected: [`${runCode} ×1 → ${runCode} ×1 (failed)`, "Error: timeout"]
    },
    {
      name: "mixed tools preserve order and only the last event is marked",
      operations: [
        { name: runCode, count: 1 },
        { name: screenshot, count: 1 },
        { name: screenshot, count: 1, failed: true }
      ],
      state: "step_failed", failureReason: "other_failure",
      expected: [`${runCode} ×1 → ${screenshot} ×1 → ${screenshot} ×1 (failed)`, "Error: other failure"]
    },
    {
      name: "single failed tool has no leading arrow",
      operations: [{ name: screenshot, count: 1, failed: true }],
      state: "step_failed", failureReason: "permission_denied",
      expected: [`${screenshot} ×1 (failed)`, "Error: permission denied"]
    },
    {
      name: "successful adjacent calls keep their aggregate",
      operations: [{ name: screenshot, count: 2 }],
      state: "phase_complete", failureReason: null,
      expected: [`${screenshot} ×2`]
    },
    {
      name: "turn failure does not imply the last tool failed",
      operations: [{ name: screenshot, count: 2 }],
      state: "failed", failureReason: null,
      expected: [`${screenshot} ×2`, "Error: other failure"]
    },
    {
      name: "legacy or unnamed failed events do not mark an earlier tool",
      operations: [{ name: screenshot, count: 2 }],
      state: "step_failed", failureReason: "timeout",
      expected: [`${screenshot} ×2`, "Error: timeout"]
    },
    {
      name: "missing tool details retain an event count",
      operations: [], state: "step_failed", failureReason: "timeout",
      expected: ["3 events", "Error: timeout"]
    },
    {
      name: "interruption remains distinct from tool failure",
      operations: [{ name: screenshot, count: 2 }],
      state: "interrupted", failureReason: null,
      expected: ["Interrupted", `${screenshot} ×2`]
    }
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const record: ProgressPhaseMessageRecord = {
        id: "phase-1", sessionId: "session-1", codexThreadId: "thread-1", turnId: "turn-1",
        phaseSeq: 1, phaseKind: "called", sourceId: "chat", platformMessageId: "1",
        directory: "/workspace/project", text: "", updateCount: 1,
        aggregate: {
          eventCount: 3, operations: item.operations, files: {},
          run: { updates: 0, succeeded: 0, failed: 0 }, explored: {}
        },
        state: item.state, failureReason: item.failureReason,
        deliveryState: "synced", correctionMessageId: null,
        startedAt: 1, finishedAt: 2, updatedAt: 2
      };
      const before = structuredClone(record);
      const summary = createProgressPhaseSummarySpec({ directory: record.directory, record });
      assert.equal(summary.title, "Called · /workspace/project");
      assert.deepEqual(summary.body, item.expected.map((text) => ({ type: "text", text })));
      assert.deepEqual(record, before);
    });
  }
});

test("failed Called previews mark the tool and append only the classified error", () => {
  for (const label of ["Called", "Called · playwright.browser_take_screenshot"]) {
    assert.deepEqual(formatProgressMessageLines({
      directory: "/workspace/project",
      event: {
        label, toolName: "mcp__playwright__browser_take_screenshot", input: "filename=preview.png",
        target: null, changes: null, failed: true, text: "raw secret error", failureReason: "timeout"
      }
    }), [
      `${label} · /workspace/project`,
      "playwright.browser_take_screenshot ×1 (failed)",
      "filename=preview.png",
      "Error: timeout"
    ]);
  }
});

test("extracts file change output deltas as edited progress", () => {
  const event = extractProgressEvent({
    method: "item/fileChange/outputDelta",
    params: {
      threadId: "thread-1",
      path: "/Users/example/workspace/src/project/src/a.ts",
      delta: [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@",
        "-old",
        "+new",
        "+next"
      ].join("\n")
    }
  });

  assert.ok(event);
  assert.equal(event.threadId, "thread-1");
  assert.equal(event.label, "Edited");
  assert.deepEqual(event.changes, [
    {
      path: "/Users/example/workspace/src/project/src/a.ts",
      type: null,
      added: 2,
      removed: 1,
      lineStatsAvailable: true
    }
  ]);
  assert.deepEqual(
    formatProgressMessageLines({
      directory: "/Users/example/workspace/src/project",
      event
    }),
    [
      "Edited · .../src/project",
      "src/a.ts (+2 -1)"
    ]
  );
});

test("extracts array-shaped progress file changes", () => {
  assert.deepEqual(
    extractProgressChanges({
      type: "patch",
      changes: [
        {
          path: "src/a.ts",
          diff: [
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@",
            "+new"
          ].join("\n")
        }
      ]
    }),
    [
      {
        path: "src/a.ts",
        type: null,
        added: 1,
        removed: 0,
        lineStatsAvailable: true,
        diffPreview: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n+new"
      }
    ]
  );
});

test("omits zero line counts for explicit binary file changes", () => {
  const event = extractProgressEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      item: {
        type: "fileChange",
        status: "completed",
        changes: [{
          path: "/workspace/project/image.png",
          kind: "update"
        }]
      }
    }
  });

  assert.ok(event);
  assert.deepEqual(event.changes, [{
    path: "/workspace/project/image.png",
    type: "update",
    added: 0,
    removed: 0,
    lineStatsAvailable: false
  }]);
  assert.deepEqual(
    formatProgressMessageLines({ directory: "/workspace/project", event }),
    ["Edited · /workspace/project", "image.png"]
  );

  const summary = createProgressPhaseSummarySpec({
    directory: "/workspace/project",
    record: {
      id: "phase-binary",
      sessionId: "session-1",
      codexThreadId: "thread-1",
      turnId: "turn-1",
      phaseSeq: 1,
      phaseKind: "edited",
      sourceId: "chat",
      platformMessageId: "1",
      directory: "/workspace/project",
      text: "",
      updateCount: 1,
      aggregate: {
        eventCount: 1,
        operations: [],
        files: {
          "image.png": { added: 0, removed: 0, lineStatsAvailable: false }
        },
        run: { updates: 0, succeeded: 0, failed: 0 },
        explored: {}
      },
      state: "phase_complete",
      failureReason: null,
      deliveryState: "synced",
      correctionMessageId: null,
      startedAt: 1,
      finishedAt: 2,
      updatedAt: 2
    }
  });
  assert.deepEqual(summary.body, [
    { type: "text", text: "1 file." },
    { type: "text", text: "image.png" }
  ]);
});
