import assert from "node:assert/strict";
import test from "node:test";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import { emptyPhaseAggregate } from "../src/bridge/progress/lifecycle.js";
import { createProgressPhaseSummarySpec } from "../src/bridge/renderers/progress.js";
import { renderLegacyMessage } from "../src/bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../src/bridge/messages/types.js";
import type { ProgressPhaseMessageRecord } from "../src/shared/types.js";
import { renderSlackMessageSpec, renderSlackMessageSpecChunks } from "../src/slack/message-renderer.js";
import { SlackMessageTransport } from "../src/slack/transport.js";
import { renderTelegramMessageSpec } from "../src/telegram/message-renderer.js";

function summary(overrides: Partial<ProgressPhaseMessageRecord> = {}): MessageSpec {
  const record: ProgressPhaseMessageRecord = {
    id: "phase-1", sessionId: "session-1", codexThreadId: "thread-1", turnId: "turn-1",
    phaseSeq: 1, phaseKind: "run", sourceId: "slack:T:C", platformMessageId: "1.0001",
    directory: "/workspace/project", text: "", updateCount: 0, aggregate: emptyPhaseAggregate(),
    state: "phase_complete", failureReason: null, deliveryState: "pending", correctionMessageId: null,
    startedAt: 1, finishedAt: 2, updatedAt: 2,
    ...overrides
  };
  return createProgressPhaseSummarySpec({ directory: record.directory, record });
}

function contextText(blocks: KnownBlock[]): string {
  return blocks.map((block) => {
    assert.equal(block.type, "context");
    if (block.type !== "context") throw new Error("Expected context block");
    return block.elements.map((element) => {
      assert.equal(element.type, "plain_text");
      if (element.type !== "plain_text") throw new Error("Expected literal text");
      assert.equal(element.emoji, false);
      assert.ok(Array.from(element.text).length <= 3_000);
      return element.text;
    }).join("");
  }).join("");
}

test("Slack phase summaries keep titles, ordered details and failures in subdued context", () => {
  const aggregate = emptyPhaseAggregate();
  aggregate.run = { updates: 2, succeeded: 1, failed: 1 };
  aggregate.operations = [
    { name: "basic-memory.bm_read", count: 1 },
    { name: "basic-memory.bm_edit", count: 1, failed: true }
  ];
  aggregate.fileEdits = [{
    itemId: "edit-1", status: "completed", files: [
      { path: "/workspace/project/README.md", added: 8, removed: 1, lineStatsAvailable: true },
      { path: "/workspace/project/docs/next-actions.md", added: 4, removed: 0, lineStatsAvailable: true }
    ]
  }];
  const cases = [
    { phaseKind: "run" as const, expected: ["Run · /workspace/project",
      "Run ×3 · Unreported ×1 · Reported successes ×1 · Reported failures ×1",
      "Reason: timeout", "Task continued"] },
    { phaseKind: "called" as const, expected: ["Called · /workspace/project",
      "basic-memory.bm_read ×1 → basic-memory.bm_edit ×1 (failed)", "Error: timeout"] },
    { phaseKind: "edited" as const, expected: ["Edited · /workspace/project",
      "README.md (+8 -1)", "docs/next-actions.md (+4 -0)"] }
  ];
  for (const { phaseKind, expected } of cases) {
    const spec = summary({ aggregate, phaseKind,
      state: phaseKind === "edited" ? "phase_complete" : "step_failed", failureReason: "timeout" });
    const rendered = contextText(renderSlackMessageSpec("slack:T:C", spec, null));
    assert.equal(rendered, expected.join("\n"));
    assert.equal(renderLegacyMessage(spec), rendered);
  }
});

test("Slack context preserves literal punctuation, newlines and Unicode within text limits", () => {
  const spec = { ...summary(), title: "Edited · /workspace/<project>&_*",
    body: [{ type: "text" as const, text: "file_*<&>.md (+8 -1)\n" + "🧪".repeat(6_500) }] };
  const blocks = renderSlackMessageSpec("slack:T:C", spec, null);
  assert.equal(blocks.length, 3);
  assert.equal(contextText(blocks), renderLegacyMessage(spec));

  const chunks = renderSlackMessageSpecChunks({ ...spec,
    body: [{ type: "text", text: "line_*<&>\n".repeat(2_000) }] });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(contextText(renderSlackMessageSpec("slack:T:C", chunk, null)), renderLegacyMessage(chunk));
  }
});

test("Slack send and edit keep the full summary in Activity fallback text", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const request = async (payload: Record<string, unknown>) => {
    requests.push(payload);
    return { channel: "C", ts: "1.0001" };
  };
  const client = { chat: { postMessage: request, update: request } } as unknown as WebClient;
  const transport = new SlackMessageTransport(client);
  const spec = summary();
  await transport.sendMessageSpec("slack:T:C", spec);
  await transport.editMessageSpec("slack:T:C", "1.0001", spec);
  assert.equal(requests.length, 2);
  for (const payload of requests) {
    assert.equal(payload.text, "Run · /workspace/project\nRun ×1 · Unreported ×1 · Reported successes ×0 · Reported failures ×0");
    assert.equal(contextText(payload.blocks as KnownBlock[]), payload.text);
  }
});

test("Slack updates old rich-text cards in place after a definite block mismatch", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = { chat: {
    update: async (payload: Record<string, unknown>) => {
      requests.push(payload);
      if ((payload.blocks as KnownBlock[])[0]?.type === "context") {
        throw Object.assign(new Error("block_mismatch"), { data: { error: "block_mismatch" } });
      }
      return { ok: true };
    },
    postMessage: async () => assert.fail("must not send a replacement"),
    delete: async () => assert.fail("must not delete the old card")
  } } as unknown as WebClient;
  const spec = summary();
  assert.equal(await new SlackMessageTransport(client).editMessageSpec("slack:T:C", "old-card", spec), true);
  assert.equal(requests.length, 2);
  for (const payload of requests) {
    assert.equal(payload.ts, "old-card");
    assert.equal(payload.text, renderLegacyMessage(spec));
  }
  assert.equal((requests[1]!.blocks as KnownBlock[])[0]?.type, "markdown");
});

test("Slack does not apply the old-card fallback to unknown failures or normal replies", async () => {
  for (const code of ["request_timeout", "block_mismatch"]) {
    let attempts = 0;
    const error = Object.assign(new Error(code), { data: { error: code } });
    const client = { chat: { update: async () => { attempts++; throw error; } } } as unknown as WebClient;
    const spec = code === "block_mismatch" ? { ...summary(), presentation: undefined } : summary();
    await assert.rejects(new SlackMessageTransport(client).editMessageSpec("slack:T:C", "old-card", spec), error);
    assert.equal(attempts, 1);
  }
});

test("Slack activity retains code formatting without creating native Markdown blocks", () => {
  const spec = { ...summary(), body: [
    { type: "text" as const, text: "src/a.ts (+1 -1)" },
    { type: "code" as const, text: "@@\n-old\n+<new>&" },
    { type: "text" as const, text: "src/b.ts (+1 -0)" },
    { type: "code" as const, text: "&".repeat(800) }
  ] };
  const blocks = renderSlackMessageSpec("slack:T:C", spec, null);
  assert.ok(blocks.every((block) => block.type === "context" || block.type === "section"));
  assert.equal(contextText([blocks[0]!]), "Run · /workspace/project\nsrc/a.ts (+1 -1)");
  assert.deepEqual(blocks[1], {
    type: "section", text: { type: "mrkdwn", text: "```\n@@\n-old\n+&lt;new&gt;&amp;\n```", verbatim: true }
  });
  assert.equal(contextText([blocks[2]!]), "src/b.ts (+1 -0)");
  for (const block of blocks) {
    if (block.type === "section") assert.ok(block.text.text.length <= 3_000);
  }
  const fenced = { ...spec, body: [{ type: "code" as const, text: "literal ``` source" }] };
  assert.equal(contextText(renderSlackMessageSpec("slack:T:C", fenced, null)),
    "Run · /workspace/projectliteral ``` source");
});

test("Telegram phase summary presentation remains unchanged in the Slack-first rollout", () => {
  assert.equal(renderTelegramMessageSpec(summary()).html,
    "<b>Run · /workspace/project</b>\nRun ×1 · Unreported ×1 · Reported successes ×0 · Reported failures ×0");
});
