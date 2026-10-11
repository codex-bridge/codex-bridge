import { resolve } from "node:path";

import { verifyConfig } from "./scenarios/config.js";
import { verifyProtocol } from "./scenarios/protocol.js";
import { verifyProviderSwitch } from "./scenarios/provider-switch.js";
import { verifySessionInventory } from "./scenarios/session-inventory.js";
import { verifySessionRefresh } from "./scenarios/session-refresh.js";
import type { BridgeStore } from "../../src/store/index.js";
import { verifyThread } from "./scenarios/thread.js";
import type { VerificationClient, VerificationOptions, VerificationReport, VerificationScenarioName } from "./types.js";
import { verificationScenarioNames } from "./types.js";

const defaultOptions: VerificationOptions = {
  scenario: "session-inventory",
  cwd: process.cwd(),
  threadId: null,
  sourceId: null,
  refreshApplyMode: "none",
  refreshRepeatCount: 1,
  provider: null,
  json: false,
  verbose: false,
  maxSamples: 5
};

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function isScenario(value: string): value is VerificationScenarioName {
  return (verificationScenarioNames as readonly string[]).includes(value);
}

export function verificationUsage(): string {
  return [
    "Usage:",
    "  yarn verify:codex --scenario <name> [options]",
    "",
    "Scenarios:",
    "  config              Verify effective config/read values.",
    "  session-inventory   Compare all/provider-filtered active and archived threads.",
    "  session-refresh     Validate the full session-refresh result for one Bridge source.",
    "  thread              Verify one thread/read response; requires --thread-id.",
    "  provider-switch     Verify the current post-switch provider; use --provider to assert it.",
    "  protocol            Verify read-only Bridge RPC surfaces.",
    "",
    "Options:",
    "  --cwd <path>        Target project directory (default: current directory).",
    "  --thread-id <id>    Thread id for the thread scenario.",
    "  --source <id>       Slack or Telegram source id; required by session-refresh.",
    "  --apply             Run session-refresh against a temporary database copy.",
    "  --apply-production  Run session-refresh against the current Bridge database.",
    "  --repeat <n>        Repeat session-refresh validation (1-5; default: 1).",
    "  --provider <name>   Expected/effective provider for assertions and filtering.",
    "  --max-samples <n>   Unknown-provider thread/read samples (default: 5, max: 20).",
    "  --json              Emit a machine-readable report.",
    "  --verbose           Write app-server diagnostics to stderr.",
    "  --help              Show this help.",
    "",
    "All scenarios are read-only by default. --apply uses a temporary database copy; --apply-production modifies Bridge state."
  ].join("\n");
}

export function parseVerificationOptions(argv: string[]): VerificationOptions {
  const options = { ...defaultOptions };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--scenario": {
        const value = readValue(argv, index, arg);
        if (!isScenario(value)) throw new Error(`Unknown scenario: ${value}.`);
        options.scenario = value;
        index += 1;
        break;
      }
      case "--cwd":
        options.cwd = resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--thread-id":
        options.threadId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--source":
        options.sourceId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--apply":
        if (options.refreshApplyMode !== "none") throw new Error("Choose only one refresh apply mode.");
        options.refreshApplyMode = "sandbox";
        break;
      case "--apply-production":
        if (options.refreshApplyMode !== "none") throw new Error("Choose only one refresh apply mode.");
        options.refreshApplyMode = "production";
        break;
      case "--repeat": {
        const value = Number(readValue(argv, index, arg));
        if (!Number.isInteger(value) || value < 1 || value > 5) {
          throw new Error("--repeat must be an integer from 1 to 5.");
        }
        options.refreshRepeatCount = value;
        index += 1;
        break;
      }
      case "--provider":
        options.provider = readValue(argv, index, arg);
        index += 1;
        break;
      case "--max-samples": {
        const value = Number(readValue(argv, index, arg));
        if (!Number.isInteger(value) || value < 0 || value > 20) {
          throw new Error("--max-samples must be an integer from 0 to 20.");
        }
        options.maxSamples = value;
        index += 1;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
        throw new Error(verificationUsage());
      default:
        throw new Error(`Unknown option: ${arg}.`);
    }
  }
  if (options.refreshApplyMode !== "none" && options.scenario !== "session-refresh") {
    throw new Error("--apply is available only for the session-refresh scenario.");
  }
  if (options.refreshApplyMode === "production" && options.refreshRepeatCount > 2) {
    throw new Error("--apply-production supports at most two refreshes.");
  }
  return options;
}

export async function runVerification(
  client: VerificationClient,
  options: VerificationOptions,
  store: BridgeStore | null = null
): Promise<VerificationReport> {
  switch (options.scenario) {
    case "config":
      return verifyConfig(client, options);
    case "session-inventory":
      return verifySessionInventory(client, options);
    case "session-refresh":
      if (!store) throw new Error("session-refresh requires a Bridge database.");
      return verifySessionRefresh(client, options, store);
    case "thread":
      return verifyThread(client, options);
    case "provider-switch":
      return verifyProviderSwitch(client, options);
    case "protocol":
      return verifyProtocol(client, options);
  }
}
