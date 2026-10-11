import { createVerificationReport } from "../report.js";
import type { VerificationClient, VerificationOptions, VerificationReport } from "../types.js";

export async function verifyProtocol(
  client: VerificationClient,
  options: VerificationOptions
): Promise<VerificationReport> {
  const startedAt = Date.now();
  // Establish one app-server before the independent read-only requests fan out.
  await client.connect();
  const [snapshot, active, archived] = await Promise.all([
    client.readCodexConfigSnapshot(options.cwd),
    client.listThreadsForCwd(options.cwd),
    client.listArchivedThreadsForCwd(options.cwd)
  ]);
  const usedMethods = client.listKnownMethods({ status: "used" }).map((entry) => entry.method);
  return createVerificationReport({
    scenario: "protocol",
    cwd: options.cwd,
    checks: [
      { name: "config/read", ok: Boolean(snapshot.model), detail: "Effective config returned." },
      { name: "thread/list active", ok: true, detail: `${active.length} active threads returned.` },
      { name: "thread/list archived", ok: true, detail: `${archived.length} archived threads returned.` }
    ],
    data: {
      usedMethodCount: usedMethods.length,
      usedMethods,
      model: snapshot.model,
      provider: snapshot.modelProvider ?? "built-in default"
    }
  }, startedAt);
}
