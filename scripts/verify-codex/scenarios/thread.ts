import { createVerificationReport } from "../report.js";
import type { VerificationClient, VerificationOptions, VerificationReport } from "../types.js";

export async function verifyThread(
  client: Pick<VerificationClient, "readThreadStatus">,
  options: VerificationOptions
): Promise<VerificationReport> {
  if (!options.threadId) throw new Error("--thread-id is required for the thread scenario.");
  const startedAt = Date.now();
  const status = await client.readThreadStatus(options.threadId, options.cwd, {
    readOnly: true,
    timeoutMs: 3_000
  });
  return createVerificationReport({
    scenario: "thread",
    cwd: options.cwd,
    checks: [{
      name: "thread_read",
      ok: status.threadId === options.threadId,
      detail: status.threadId === options.threadId ? "Codex returned the requested thread." : "Codex returned a different thread id."
    }],
    data: {
      threadId: status.threadId,
      threadCwd: status.cwd,
      provider: status.modelProvider,
      model: status.model,
      reasoning: status.reasoningEffort,
      activity: status.activity,
      activityType: status.activityType
    }
  }, startedAt);
}
