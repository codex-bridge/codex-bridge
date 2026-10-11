import { randomUUID } from "node:crypto";

export interface WebWindowLease {
  readonly windowId: string;
  readonly token: string;
  /** Aborted when this grant is released or replaced; adapters can close its streams. */
  readonly signal: AbortSignal;
}

export type WebWindowAcquireResult =
  | { acquired: true; lease: WebWindowLease; replacedWindowId: string | null }
  | { acquired: false; holderWindowId: string };

/** One in-memory instance per Bridge service, independent of session ownership. */
export class WebWindowLeaseManager {
  private current: { lease: WebWindowLease; controller: AbortController } | null = null;

  getHolderWindowId(): string | null {
    return this.current?.lease.windowId ?? null;
  }

  /** Only explicit connection/takeover actions call acquire; reconnect uses resume. */
  acquire(windowId: string, options: { takeover?: boolean } = {}): WebWindowAcquireResult {
    if (!windowId.trim()) throw new Error("A Web window ID is required.");
    const previous = this.current;
    if (previous && !options.takeover) {
      return { acquired: false, holderWindowId: previous.lease.windowId };
    }

    const controller = new AbortController();
    const lease: WebWindowLease = Object.freeze({ windowId, token: randomUUID(), signal: controller.signal });
    this.current = { lease, controller };
    previous?.controller.abort("taken_over");
    return { acquired: true, lease, replacedWindowId: previous?.lease.windowId ?? null };
  }

  isHolder(windowId: string, token: string): boolean {
    return this.current !== null && this.current.lease.windowId === windowId && this.current.lease.token === token;
  }

  /** Never creates a grant, including after release or a Bridge restart. */
  resume(windowId: string, token: string): WebWindowLease | null {
    return this.isHolder(windowId, token) ? this.current!.lease : null;
  }

  /** Page restoration consumes a token once; cloned tabs cannot share its authority. */
  restore(windowId: string, token: string): WebWindowLease | null {
    if (!this.isHolder(windowId, token)) return null;
    const previous = this.current!;
    const controller = new AbortController();
    const lease: WebWindowLease = Object.freeze({ windowId, token: randomUUID(), signal: controller.signal });
    this.current = { lease, controller };
    previous.controller.abort("restored");
    return lease;
  }

  release(windowId: string, token: string): boolean {
    if (!this.isHolder(windowId, token)) return false;
    const previous = this.current!;
    this.current = null;
    previous.controller.abort("released");
    return true;
  }
}
