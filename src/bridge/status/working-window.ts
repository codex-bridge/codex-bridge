import type { AppServerStatusUpdate } from "../../codex/client.js";
import { formatStatusDetailPreview } from "../renderers/progress.js";

export type WorkingUpdate = Partial<Pick<AppServerStatusUpdate, "detail" | "detailMode">> & {
  /** Semantic urgency supplied by the event owner, never inferred from display text. */
  immediate?: boolean;
};

/** Bounded, ordered observations since the last confirmed Working delivery. */
export class WorkingWindow {
  label = "";
  detail = "";
  revision = 0;
  private changes: Array<{ revision: number; text: string }> = [];
  private omitted = false;

  observe(label: string, update?: WorkingUpdate): boolean {
    const previous = label === this.label ? this.detail : "";
    const detail = label === "Thinking" ? "" : update?.detail
      ? formatStatusDetailPreview(update.detailMode === "append" ? previous + update.detail : update.detail)
      : previous;
    if (label === this.label && detail === this.detail) return false;
    this.label = label;
    this.detail = detail;
    this.revision++;
    const text = update?.immediate && detail ? `${label} (${detail})` : label;
    if (this.changes.at(-1)?.text !== text) this.changes.push({ revision: this.revision, text });
    if (this.changes.length > 12) { this.changes.shift(); this.omitted = true; }
    return true;
  }

  summary(): string {
    const text = (this.omitted ? "… → " : "") + this.changes.map(change => change.text).join(" → ");
    const characters = Array.from(text);
    return characters.length > 240 ? characters.slice(0, 239).join("") + "…" : text;
  }

  acknowledge(revision: number): void {
    this.changes = this.changes.filter(change => change.revision > revision);
    this.omitted = false;
  }
}
