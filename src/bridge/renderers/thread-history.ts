import type { ThreadHistoryEntry } from "../../codex/thread-history.js";
import { createProgressMessageSpec } from "./progress.js";
import { createMessage } from "../messages/factory.js";
import { renderLegacyMessage } from "../messages/legacy-adapter.js";
import type { MessageSpec } from "../messages/types.js";

export type ThreadHistoryReplayBlock = {
  entry: ThreadHistoryEntry | null;
  text: string;
  messageSpec: MessageSpec | null;
};

export type ThreadHistoryReplay = {
  blocks: ThreadHistoryReplayBlock[];
  truncated: boolean;
};

export function buildThreadHistoryReplay(input: {
  directory: string;
  entries: ThreadHistoryEntry[];
  maxBlocks?: number;
  maxChars?: number;
}): ThreadHistoryReplay {
  const maxBlocks = input.maxBlocks ?? 20;
  const maxChars = input.maxChars ?? 12_000;
  if (maxBlocks < 2 || maxChars < 200) {
    throw new Error("Thread history replay limits are too small.");
  }
  const blocks = collapseAdjacentCalledEntries(input.entries).map((entry) => {
    const messageSpec = createThreadHistoryEntrySpec({ directory: input.directory, entry });
    return { entry, messageSpec, text: renderLegacyMessage(messageSpec) };
  });
  const totalChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (blocks.length <= maxBlocks && totalChars <= maxChars) {
    return { blocks, truncated: false };
  }

  const noticeSpec = createMessage({
    kind: "system",
    session: { id: null, directory: input.directory },
    body: [{ type: "text", text: `History truncated to the latest ${maxBlocks} blocks / ${maxChars} characters.` }]
  });
  const notice: ThreadHistoryReplayBlock = {
    entry: null,
    messageSpec: noticeSpec,
    text: renderLegacyMessage(noticeSpec)
  };
  const selected: ThreadHistoryReplayBlock[] = [];
  let remainingChars = Math.max(0, maxChars - notice.text.length);
  for (let index = blocks.length - 1; index >= 0 && selected.length < maxBlocks - 1; index -= 1) {
    const block = blocks[index]!;
    if (block.text.length <= remainingChars) {
      selected.push(block);
      remainingChars -= block.text.length;
      continue;
    }
    if (remainingChars >= 80) {
      // COMPATIBILITY(MESSAGE_FACTORY): truncated blocks keep legacy text because their spec body no longer matches the sliced text.
      selected.push({
        entry: block.entry,
        messageSpec: null,
        text: `${block.text.slice(0, remainingChars - 4).trimEnd()}\n...`
      });
    }
    break;
  }
  return {
    blocks: [notice, ...selected.reverse()],
    truncated: true
  };
}

export function collapseAdjacentCalledEntries(entries: ThreadHistoryEntry[]): ThreadHistoryEntry[] {
  const collapsed: ThreadHistoryEntry[] = [];
  for (const entry of entries) {
    if (isCalledEntry(entry) && isCalledEntry(collapsed.at(-1))) {
      collapsed[collapsed.length - 1] = entry;
    } else {
      collapsed.push(entry);
    }
  }
  return collapsed;
}

function isCalledEntry(entry: ThreadHistoryEntry | undefined): boolean {
  return Boolean(
    entry?.kind === "progress" &&
    !entry.event.changes?.length &&
    (entry.event.label.startsWith("Called") || entry.event.label === "Explored")
  );
}

export function renderThreadHistoryEntry(input: {
  directory: string;
  entry: ThreadHistoryEntry;
}): string {
  return renderLegacyMessage(createThreadHistoryEntrySpec(input));
}

export function createTranscriptMessageSpec(input: {
  directory: string;
  role: "user" | "assistant" | "system";
  text: string;
}): MessageSpec {
  return createMessage({
    kind: input.role === "user" ? "user" : input.role === "assistant" ? "codex" : "system",
    session: { id: null, directory: input.directory },
    body: [{ type: input.role === "assistant" ? "markdown" : "text", text: input.text.trim() }]
  });
}

export function createThreadHistoryEntrySpec(input: {
  directory: string;
  entry: ThreadHistoryEntry;
}): MessageSpec {
  const { directory, entry } = input;
  if (entry.kind === "message") {
    return createTranscriptMessageSpec({ directory, role: entry.role, text: entry.text });
  }
  if (entry.kind === "progress") {
    return createProgressMessageSpec({ directory, event: entry.event });
  }
  if (entry.kind === "compaction") {
    return createMessage({
      kind: "compact-completed",
      session: { id: null, directory }
    });
  }

  const body: Array<{ type: "text"; text: string }> = [
    { type: "text", text: `Turn ${formatTurnStatus(entry.status)}` }
  ];
  if (entry.durationMs !== null) {
    body.push({ type: "text", text: `Elapsed ${formatDuration(entry.durationMs)}` });
  }
  if (entry.error) {
    body.push({ type: "text", text: `Error ${entry.error}` });
  }
  return createMessage({
    kind: "system",
    session: { id: null, directory },
    body
  });
}

function formatTurnStatus(status: Extract<ThreadHistoryEntry, { kind: "turn" }>["status"]): string {
  return status === "inProgress" ? "in progress" : status;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
