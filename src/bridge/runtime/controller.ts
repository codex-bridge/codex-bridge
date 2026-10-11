export type RuntimeState =
  | "connecting"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "failed";

const ALLOWED_TRANSITIONS: Record<RuntimeState, ReadonlySet<RuntimeState>> = {
  connecting: new Set(["connected", "failed"]),
  connected: new Set(["disconnecting", "failed"]),
  disconnecting: new Set(["disconnected", "failed"]),
  disconnected: new Set(["connecting"]),
  failed: new Set(["connecting", "disconnected"])
};

export function isRuntimeConnected(state: RuntimeState): boolean {
  return state === "connected";
}

export function isRuntimeTransitioning(state: RuntimeState): boolean {
  return state === "connecting" || state === "disconnecting";
}

export function transitionRuntimeState(current: RuntimeState, next: RuntimeState): RuntimeState {
  if (current === next) return current;
  if (!ALLOWED_TRANSITIONS[current].has(next)) {
    throw new Error(`Invalid runtime state transition: ${current} -> ${next}`);
  }
  return next;
}

/** Owns the Codex runtime lifecycle state used by the Bridge. */
export class RuntimeController {
  private currentState: RuntimeState = "disconnected";

  get state(): RuntimeState {
    return this.currentState;
  }

  isConnected(): boolean {
    return isRuntimeConnected(this.currentState);
  }

  isTransitioning(): boolean {
    return isRuntimeTransitioning(this.currentState);
  }

  transition(next: RuntimeState): void {
    this.currentState = transitionRuntimeState(this.currentState, next);
  }

  // COMPATIBILITY(TEST): existing service tests seed lifecycle state directly.
  replaceForCompatibility(next: RuntimeState): void {
    this.currentState = next;
  }
}
