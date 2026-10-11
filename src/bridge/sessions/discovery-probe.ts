import type { SessionRecord } from "../../shared/types.js";

export type SessionDiscoveryProbeResult =
  | { state: "readable" }
  | { state: "missing"; error: string }
  | { state: "indeterminate"; error: string };

export type ReadThreadStatus = (
  threadId: string,
  cwd?: string,
  options?: { readOnly?: boolean; timeoutMs?: number }
) => Promise<unknown>;

export function isMissingCodexThreadError(message: string): boolean {
  return /not found|unknown thread|no such thread|does not exist/i.test(message);
}

export async function probeSessionDiscoverability(
  readThreadStatus: ReadThreadStatus,
  session: Pick<SessionRecord, "codexThreadId" | "currentCwd" | "pathKey">
): Promise<SessionDiscoveryProbeResult> {
  try {
    await readThreadStatus(session.codexThreadId, session.currentCwd ?? session.pathKey, {
      readOnly: true,
      timeoutMs: 3_000
    });
    return { state: "readable" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return isMissingCodexThreadError(message)
      ? { state: "missing", error: message }
      : { state: "indeterminate", error: message };
  }
}
