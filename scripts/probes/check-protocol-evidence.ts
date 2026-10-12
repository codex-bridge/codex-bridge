import { APP_SERVER_METHODS, APP_SERVER_PROTOCOL_PROBE } from "../../src/codex/protocol-registry.js";
import { APP_SERVER_PROTOCOL_EVIDENCE } from "../../src/codex/protocol-evidence.js";
import { scanProductionReferences } from "./protocol-evidence.js";

const references = await scanProductionReferences(process.cwd(), new Set(APP_SERVER_METHODS.map((entry) => entry.method)));
if (APP_SERVER_PROTOCOL_EVIDENCE.version !== APP_SERVER_PROTOCOL_PROBE.codexCliVersion) {
  throw new Error("Protocol evidence and registry versions differ. Run yarn protocol:evidence:refresh --live.");
}
if (JSON.stringify(references) !== JSON.stringify(APP_SERVER_PROTOCOL_EVIDENCE.productionReferences)) {
  throw new Error("Protocol production references are stale. Run yarn protocol:evidence:refresh.");
}
console.log(`Protocol evidence matches production references (${Object.keys(references).length} methods).`);
