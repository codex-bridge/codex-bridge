import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_SERVER_METHODS, APP_SERVER_PROTOCOL_PROBE } from "../../src/codex/protocol-registry.js";
import { APP_SERVER_PROTOCOL_EVIDENCE } from "../../src/codex/protocol-evidence.js";
import { logger } from "../../src/logging/logger.js";
import { createVerificationClient, createVerificationConfig } from "../verify-codex/runtime.js";
import { extractGeneratedMethods, extractRuntimeMethods, scanProductionReferences } from "./protocol-evidence.js";

logger.configureOutput({ console: "none", file: false });
const schemaIndex = process.argv.indexOf("--schema");
const live = process.argv.includes("--live");
const evidence = structuredClone(APP_SERVER_PROTOCOL_EVIDENCE);
if (evidence.version !== APP_SERVER_PROTOCOL_PROBE.codexCliVersion) {
  if (!live) throw new Error("Baseline changed; run protocol:evidence:refresh --live to replace old evidence");
  evidence.version = APP_SERVER_PROTOCOL_PROBE.codexCliVersion;
  evidence.runtimeRequests = [];
  evidence.liveVerification = {};
}
if (live || schemaIndex >= 0) {
  const config = createVerificationConfig();
  const version = execFileSync(config.codexAppServerCommand, ["--version"], { encoding: "utf8" }).trim().split(" ").at(-1);
  if (version !== APP_SERVER_PROTOCOL_PROBE.codexCliVersion) throw new Error(`CLI version ${version} differs from registry baseline`);
  const directory = schemaIndex >= 0 ? process.argv[schemaIndex + 1] : await mkdtemp(join(tmpdir(), "bridge-protocol-"));
  if (!directory) throw new Error("--schema requires a directory");
  if (schemaIndex < 0) execFileSync(config.codexAppServerCommand, ["app-server", "generate-ts", "--experimental", "--out", directory]);
  for (const [kind, name] of [["request", "ClientRequest"], ["serverRequest", "ServerRequest"], ["notification", "ServerNotification"]] as const) {
    evidence.schemaMethods[kind] = extractGeneratedMethods(await readFile(join(directory, `${name}.ts`), "utf8"));
    if (!evidence.schemaMethods[kind].length) throw new Error(`No ${kind} methods in generated bindings`);
  }
  evidence.includesExperimental = true;
  console.log(`Read generated schemas from ${directory}`);
}
if (live) {
  const client = createVerificationClient();
  try {
    await client.connect();
    // A deliberate unknown-method request enumerates the parser's accepted request names.
    evidence.runtimeRequests = [];
    try {
      await (client as unknown as { request(method: string, params: unknown): Promise<unknown> }).request("__codex_bridge_probe_unknown_method__", {});
    } catch (error) {
      const methods = extractRuntimeMethods(error instanceof Error ? error.message : String(error));
      if (!methods.length) throw new Error("Runtime method discovery returned no methods");
      evidence.runtimeRequests = methods;
    }
    if (!evidence.runtimeRequests.length) throw new Error("Runtime method discovery returned no methods");
    const schemaRequests = new Set(evidence.schemaMethods.request);
    const runtimeRequests = new Set(evidence.runtimeRequests);
    if (evidence.runtimeRequests.some((method) => !schemaRequests.has(method)) ||
      evidence.schemaMethods.request.some((method) => !runtimeRequests.has(method))) {
      throw new Error("Runtime requests differ from generated bindings; review the schema baseline before refreshing");
    }
    const capabilities = await client.readRuntimeCapabilities();
    const verifiedAt = new Date().toISOString().slice(0, 10);
    const verification: Record<string, { version: string; verifiedAt: string; scenario: string }> = evidence.liveVerification;
    for (const [method, result] of [
      ["server/diagnostics", capabilities.diagnostics],
      ["configRequirements/read", capabilities.requirements],
      ["modelProvider/capabilities/read", capabilities.provider]
    ] as const) {
      if (result.state !== "available") throw new Error(`${method} verification returned ${result.state}`);
      verification[method] = { version: evidence.version, verifiedAt, scenario: "read-only capabilities" };
    }
    console.log("Three read-only capability requests passed response validation.");
  } finally { await client.close(); }
}
const methods = new Set([...APP_SERVER_METHODS.map((entry) => entry.method), ...Object.values(evidence.schemaMethods).flat()]);
evidence.productionReferences = await scanProductionReferences(process.cwd(), methods);
evidence.generatedAt = new Date().toISOString().slice(0, 10);
// Mechanical generator output: no credentials, payloads, or absolute source paths are stored.
await writeFile("src/codex/protocol-evidence.generated.json", `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Refreshed protocol evidence (${Object.keys(evidence.productionReferences).length} production method references).`);
