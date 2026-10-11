import type { History, MessageEvent, MessageSpec } from "./protocol";
export type TimelineItem = { id: string; message: MessageSpec; origin: "history" | "live" | "local" | "cache";
  deliveryStatus?: "sending" | "accepted" | "unknown" | "refused"; openDecision?: boolean };
export function hasOpenDecision(item: TimelineItem): boolean {
  return item.openDecision !== false && !!item.message.decision && ["pending", "awaitingInput"].includes(item.message.decision.state);
}
export const TIMELINE_LIMIT = 200;
export function trimTimeline(items: TimelineItem[]): TimelineItem[] { return items.slice(-TIMELINE_LIMIT); }
export function dialogueText(message: MessageSpec): string {
  return message.body.filter((part) => part.type === "text" || part.type === "markdown").map((part) => part.text).join("\n");
}
export function isDialogue(message: MessageSpec): boolean { return message.kind === "user" || message.kind === "codex"; }
export function historyBoundaryIndex(items: TimelineItem[]): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index]?.origin === "history" || items[index]?.origin === "cache") return index;
  }
  return -1;
}
function hasVisibleMessageContent(message: MessageSpec): boolean {
  if (message.decision) return true;
  if (message.actions.length) return true;
  return message.body.some((part) => part.type === "field"
    ? Boolean(part.label.trim() || part.value.trim())
    : Boolean(part.text.trim()));
}
export function restoreHistory(items: TimelineItem[], history: History): TimelineItem[] {
  // Upstream history has no IDs. Anchor only on an exact contiguous sequence of
  // role/text pairs, not a global text set. Keep interleaved stats/cards in place.
  const messages = history.messages.slice(-5);
  const dialogues = items.filter((item) => isDialogue(item.message) && !["sending", "unknown", "refused"].includes(item.deliveryStatus ?? ""));
  let match: { known: number; history: number; size: number } | undefined;
  outer: for (let size = Math.min(dialogues.length, messages.length); size > 0; size--) {
    for (let known = dialogues.length - size; known >= 0; known--) {
      for (let start = 0; start <= messages.length - size; start++) {
        if (dialogues.slice(known, known + size).every((item, index) => messages[start + index]?.text === dialogueText(item.message) &&
            messages[start + index]?.role === (item.message.kind === "user" ? "user" : "assistant"))) {
          match = { known, history: start, size }; break outer;
        }
      }
    }
  }
  const ids = new Set(items.map((item) => item.id));
  const restored: TimelineItem[] = messages.map((message, index) => {
    let id = `history-${index}`;
    while (ids.has(id)) id += "-new";
    ids.add(id);
    return { id, origin: "history", message: { kind: message.role === "user" ? "user" : "codex",
      title: message.role === "user" ? "You" : "Codex", body: [{ type: "markdown", text: message.text }], actions: [] }
    };
  });
  if (!match) return trimTimeline([...restored, ...items.filter((item) => item.origin !== "history" &&
    !(item.origin === "cache" && isDialogue(item.message)))]);
  const matched = new Set(dialogues.slice(match.known, match.known + match.size));
  const first = items.indexOf(dialogues[match.known]!);
  const nextDialogue = dialogues[match.known + match.size];
  const after = nextDialogue ? items.indexOf(nextDialogue) : items.length;
  const keep = (subset: TimelineItem[]) => subset.filter((item) => item.origin !== "history" || matched.has(item));
  return trimTimeline([...keep(items.slice(0, first)), ...restored.slice(0, match.history),
    ...keep(items.slice(first, after)), ...restored.slice(match.history + match.size), ...keep(items.slice(after))]);
}
export function applyMessage(items: TimelineItem[], event: MessageEvent): TimelineItem[] {
  const index = items.findIndex((item) => item.id === event.messageId ||
    (event.message?.decision && item.message.decision?.id === event.message.decision.id));
  if (event.operation === "delete") return items.filter((_, position) => position !== index);
  if (event.operation === "clear-actions") return items.map((item, position) => position !== index ? item :
    { ...item, message: { ...item.message, actions: [], ...(item.message.decision ? { decision: {
      ...item.message.decision, availableActions: [], inputAllowed: false
    } } : {}) } });
  if (!event.message) return items;
  // Visibility follows browser-supported content types, not message titles.
  if (!hasVisibleMessageContent(event.message))
    return index < 0 ? items : items.filter((_, position) => position !== index);
  const next: TimelineItem = { id: event.messageId, message: event.message, origin: "live" };
  // An edit may arrive after reload without its send; showing it is better than
  // silently discarding it. Existing cards retain their exact position.
  return trimTimeline(index < 0 ? [...items, next] : items.map((item, position) => position === index ? next : item));
}
export function mergeDecisions(items: TimelineItem[], decisions: MessageSpec[]): TimelineItem[] {
  const current = new Map(decisions.flatMap((message) => message.decision ? [[message.decision.id, message] as const] : []));
  const next = items.map((item) => {
    const id = item.message.decision?.id;
    if (!id) return item;
    const message = current.get(id);
    if (message) { current.delete(id); return { ...item, message, openDecision: true }; }
    // Open endpoint omits processed cards; do not guess approved/expired.
    return { ...item, openDecision: false, message: { ...item.message, decision: { ...item.message.decision!, availableActions: [], inputAllowed: false } } };
  });
  return trimTimeline([...next, ...[...current].map(([id, message]) => ({ id: `decision-${id}`, message, origin: "live" as const }))]);
}
