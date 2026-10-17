import type {
  ProgressPhaseAggregate,
  ProgressPhaseKind,
  ProgressPhaseMessageRecord
} from "../../shared/types.js";
import type { NormalizedPhaseEvent } from "./normalizer.js";

export function emptyPhaseAggregate(): ProgressPhaseAggregate {
  return {
    eventCount: 0,
    operations: [],
    files: {},
    fileEdits: [],
    run: { updates: 0, succeeded: 0, failed: 0 },
    explored: {}
  };
}

export function appendPhaseEvent(
  current: ProgressPhaseAggregate,
  normalized: NormalizedPhaseEvent
): ProgressPhaseAggregate {
  const aggregate: ProgressPhaseAggregate = {
    eventCount: current.eventCount + 1,
    operations: current.operations.map((operation) => ({ ...operation })),
    files: { ...current.files },
    ...(current.fileEdits ? { fileEdits: [...current.fileEdits] } : {}),
    run: { ...current.run },
    explored: { ...current.explored }
  };

  if (normalized.kind === "edited" && aggregate.fileEdits) {
    const { itemId, changes, completed, failed } = normalized.event;
    // Do not invent an operation identity from paths, content, or timestamps.
    if (!itemId) return aggregate;
    const index = aggregate.fileEdits.findIndex((edit) => edit.itemId === itemId);
    const previous = aggregate.fileEdits[index];
    // Late snapshots and duplicate completion notifications cannot reopen an edit.
    if (previous && previous.status !== "pending") return current;
    const edit = {
      itemId,
      status: failed ? "failed" as const : completed === true ? "completed" as const : "pending" as const,
      files: changes?.map(({ path, added, removed, lineStatsAvailable }) => ({ path, added, removed, lineStatsAvailable }))
        ?? previous?.files ?? []
    };
    if (index < 0) aggregate.fileEdits.push(edit);
    else aggregate.fileEdits[index] = edit;
  } else if (normalized.kind === "edited" && normalized.event.changes?.length) {
    // Legacy active phases finish in their original format; new phases use fileEdits.
    for (const change of normalized.event.changes) {
      const previous = aggregate.files[change.path] ?? {
        added: 0,
        removed: 0,
        lineStatsAvailable: false
      };
      const previousLineStatsAvailable = previous.lineStatsAvailable ??
        (previous.added !== 0 || previous.removed !== 0);
      aggregate.files[change.path] = {
        added: previous.added + change.added,
        removed: previous.removed + change.removed,
        lineStatsAvailable: previousLineStatsAvailable || change.lineStatsAvailable
      };
    }
  }

  if (normalized.kind === "called" && normalized.operation) {
    appendAdjacentOperation(aggregate, normalized.operation, normalized.event.failed);
  }

  if (normalized.kind === "explored") {
    const category = normalized.event.action ?? "search";
    aggregate.explored[category] = (aggregate.explored[category] ?? 0) + 1;
  }

  if (normalized.kind === "run" && normalized.event.completed !== false) {
    if (normalized.event.failed) {
      aggregate.run.failed += 1;
    } else {
      aggregate.run.succeeded += 1;
    }
  }

  return aggregate;
}

export function phaseTitle(kind: ProgressPhaseKind): string {
  switch (kind) {
    case "run": return "Run";
    case "called": return "Called";
    case "edited": return "Edited";
    case "explored": return "Explored";
    case "system": return "System";
    // Old records are not reclassified, and should not become a new Progress card.
    case "other": return "Historical activity";
  }
}

export function opensNewPhase(
  active: ProgressPhaseMessageRecord | null,
  normalized: NormalizedPhaseEvent
): boolean {
  return !active || active.phaseKind !== normalized.kind;
}

function appendAdjacentOperation(aggregate: ProgressPhaseAggregate, name: string, failed: boolean): void {
  const last = aggregate.operations.at(-1);
  if (!failed && last?.name === name && !last.failed) {
    last.count += 1;
    return;
  }
  aggregate.operations.push({ name, count: 1, ...(failed ? { failed: true } : {}) });
}
