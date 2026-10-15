import { relative } from "node:path";

import type { AppServerProgressFileChange } from "../../codex/client.js";
import { createEditedMessage, createMessage, createProgressMessage } from "../messages/factory.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import type { MessageBodyPart, MessageSpec } from "../messages/types.js";
import { formatSessionMarker } from "../../shared/session-tag.js";
import type {
  ProgressFailureReason,
  ProgressPhaseMessageRecord,
  ProgressPhaseState
} from "../../shared/types.js";
import { phaseTitle } from "../progress/lifecycle.js";

export type ProgressRenderEvent = {
  label: string;
  toolName: string | null;
  target: string | null;
  input: string | null;
  changes: AppServerProgressFileChange[] | null;
  failed: boolean;
  text: string;
  failureReason?: ProgressFailureReason | null;
};

export function formatProgressMessageLines(input: {
  directory: string;
  event: ProgressRenderEvent;
}): string[] {
  return renderLegacyMessage(createProgressMessageSpec(input)).split("\n");
}

export function createProgressMessageSpec(input: {
  directory: string;
  event: ProgressRenderEvent;
  // Opt in for active cards; history replay keeps file statistics only.
  includeDiffPreview?: boolean;
}): MessageSpec {
  const session = { id: null, directory: input.directory };
  if (input.event.label === "System") {
    return createMessage({
      kind: "system",
      titleLabel: "System",
      session,
      body: input.event.failed
        ? [{ type: "text", text: `Failed · ${formatFailureReason(input.event.failureReason)}` }]
        : []
    });
  }
  if (input.event.changes?.length) {
    return createFileChangeProgressMessage({
      changes: input.event.changes,
      directory: input.directory,
      session,
      includeDiffPreview: input.includeDiffPreview
    });
  }

  const subject = formatProgressSubject(input.event);
  const body = [{ type: "text" as const, text: subject }];
  if (input.event.input && input.event.input !== subject) {
    body.push({ type: "text", text: input.event.input });
  }
  if (input.event.failed) {
    const lines = input.event.label === "Run"
      ? completedRunLines(input.event.failureReason)
      : [`Step failed · ${formatFailureReason(input.event.failureReason)}`];
    body.push(...lines.map((text) => ({ type: "text" as const, text })));
  }
  return createProgressMessage({
    directory: input.directory,
    label: input.event.label,
    failed: input.event.failed,
    body
  });
}

export function createProgressPhaseSummarySpec(input: {
  directory: string;
  record: ProgressPhaseMessageRecord;
}): MessageSpec {
  return createMessage({
    kind: input.record.state === "failed" ? "failed" : "progress",
    titleLabel: phaseTitle(input.record.phaseKind),
    session: { id: null, directory: input.directory },
    body: summaryLines(input.record).map((text) => ({ type: "text" as const, text }))
  });
}

function summaryLines(record: ProgressPhaseMessageRecord): string[] {
  const aggregate = record.aggregate;
  const outcome = phaseOutcomeLine(record.state, record.failureReason);
  const lines = record.phaseKind === "run" && (record.state === "step_failed" || record.state === "failed")
    ? completedRunLines(record.failureReason)
    : outcome ? [outcome] : [];
  if (record.phaseKind === "run") {
    const { updates, succeeded, failed } = aggregate.run;
    // A persisted card already has one successfully sent preview; updates counts later edits.
    const displayedUpdates = updates + 1;
    lines.push(`Run ×${displayedUpdates} · Reported successes ×${succeeded} · Reported failures ×${failed}`);
    if (record.state === "step_failed") lines.push("Task continued");
    return lines;
  }
  if (record.phaseKind === "edited") {
    if (aggregate.fileEdits) {
      for (const edit of aggregate.fileEdits) {
        for (const file of edit.files) {
          const detail = edit.status === "completed"
            ? file.lineStatsAvailable ? ` (+${file.added} -${file.removed})` : ""
            : edit.status === "failed" ? " · Failed" : " · Unconfirmed";
          lines.push(`${formatProgressPath(file.path, record.directory)}${detail}`);
        }
      }
      return lines.length ? lines : ["File edit details unavailable."];
    }
    const files = Object.entries(aggregate.files);
    const totals = files.reduce((result, [, change]) => ({
      added: result.added + change.added,
      removed: result.removed + change.removed
    }), { added: 0, removed: 0 });
    const allLineStatsAvailable = files.every(([, change]) =>
      change.lineStatsAvailable ?? (change.added !== 0 || change.removed !== 0)
    );
    if (files.length > 0) {
      const counts = allLineStatsAvailable ? ` (+${totals.added} -${totals.removed})` : "";
      lines.push(`${files.length} file${files.length === 1 ? "" : "s"}${counts}.`);
      lines.push(...files.slice(0, 3).map(([path]) => path));
      if (files.length > 3) lines.push(`+${files.length - 3} more files`);
    }
    return lines.length ? lines : [eventCountLine(aggregate.eventCount)];
  }
  if (record.phaseKind === "explored") {
    const categories = Object.entries(aggregate.explored);
    if (categories.length > 0) {
      lines.push(categories.map(([name, count]) => `${name} ×${count}`).join(" · "));
    }
    return lines.length ? lines : [eventCountLine(aggregate.eventCount)];
  }
  if (record.phaseKind === "called" && aggregate.operations.length > 0) {
    lines.push(aggregate.operations.map(({ name, count }) => `${name} ×${count}`).join(" → "));
  }
  return lines.length ? lines : [eventCountLine(aggregate.eventCount)];
}

function eventCountLine(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}

function phaseOutcomeLine(state: ProgressPhaseState, reason: ProgressFailureReason | null): string | null {
  switch (state) {
    case "phase_complete": return null;
    case "step_failed": return `Step failed · ${formatFailureReason(reason)}`;
    case "failed": return `Failed · ${formatFailureReason(reason)}`;
    case "interrupted": return "Interrupted";
    case "completed": return "Completed";
    case "active": return "Active";
  }
}

function formatFailureReason(reason: ProgressFailureReason | null | undefined): string {
  return (reason ?? "other_failure").replaceAll("_", " ");
}

function completedRunLines(reason: ProgressFailureReason | null | undefined): string[] {
  return reason && reason !== "other_failure"
    ? ["Completed", `Reason: ${formatFailureReason(reason)}`]
    : ["Completed"];
}

function createFileChangeProgressMessage(input: {
  changes: AppServerProgressFileChange[];
  directory: string;
  session: { id: string | null; directory: string };
  includeDiffPreview?: boolean;
}): MessageSpec {
  const totals = input.changes.reduce(
    (acc, change) => ({
      added: acc.added + change.added,
      removed: acc.removed + change.removed
    }),
    { added: 0, removed: 0 }
  );
  const formatCounts = (change: Pick<AppServerProgressFileChange, "added" | "removed" | "lineStatsAvailable">) =>
    change.lineStatsAvailable ? ` (+${change.added} -${change.removed})` : "";

  const allLineStatsAvailable = input.changes.every((change) => change.lineStatsAvailable);
  const body: MessageBodyPart[] = [];
  if (input.changes.length > 1) {
    body.push({
      type: "text",
      text: `${input.changes.length} files${allLineStatsAvailable ? ` (+${totals.added} -${totals.removed})` : ""}`
    });
  }
  for (const change of input.changes.slice(0, 3)) {
    body.push({ type: "text", text: `${formatProgressPath(change.path, input.directory)}${formatCounts(change)}` });
    if (input.includeDiffPreview && change.diffPreview) body.push({ type: "code", text: change.diffPreview });
  }
  const omitted = input.changes.length - 3;
  if (omitted > 0) {
    body.push({ type: "text", text: `... ${omitted} more file${omitted === 1 ? "" : "s"}` });
  }
  return createEditedMessage({ session: input.session, body });
}

function formatProgressSubject(event: {
  label: string;
  toolName: string | null;
  target: string | null;
  input: string | null;
}): string {
  if (event.label === "Explored") {
    return event.target ?? event.input ?? formatProgressToolName(event.toolName) ?? "search";
  }
  return (
    formatProgressToolName(event.toolName) ??
    event.target ??
    event.input ??
    "progress"
  );
}

function formatProgressToolName(toolName: string | null): string | null {
  if (!toolName) {
    return null;
  }
  const mcpMatch = toolName.match(/^mcp__([^_]+)__([A-Za-z0-9_:-]+)$/);
  if (mcpMatch) {
    return `${mcpMatch[1]}.${mcpMatch[2]}`;
  }
  return toolName;
}

function formatProgressPath(filePath: string, directory: string): string {
  const relativePath = filePath.startsWith("/")
    ? relative(directory, filePath)
    : filePath;
  if (relativePath && !relativePath.startsWith("..")) {
    return relativePath;
  }
  return formatSessionMarker(filePath);
}

export function formatStatusDetailPreview(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const sourceLines = lines.length > 0 ? lines : [raw.replace(/\s+/g, " ").trim()];
  const preview = sourceLines.slice(0, 7).map((line) =>
    line.length > 120 ? `${line.slice(0, 117)}...` : line
  );
  const omitted = Math.max(0, sourceLines.length - preview.length);
  if (omitted > 0) {
    preview.push(`... ${omitted} more line${omitted === 1 ? "" : "s"}`);
  }
  return preview.join("\n");
}
