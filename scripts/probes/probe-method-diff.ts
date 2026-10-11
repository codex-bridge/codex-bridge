import { spawn } from "node:child_process";
import readline from "node:readline";

import { APP_SERVER_METHODS, APP_SERVER_PROTOCOL_PROBE } from "../../src/codex/protocol-registry.js";

type JsonRpcResponse = {
  id: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

function parseArgs(): string[] {
  const raw = process.env.CODEX_APP_SERVER_ARGS;
  if (!raw) {
    return ["app-server"];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("CODEX_APP_SERVER_ARGS must be a JSON string array.");
  }
  return parsed;
}

function extractExpectedMethods(message: string): string[] {
  const match = message.match(/expected one of (.+)$/s);
  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^`|`$/g, ""))
    .filter(Boolean)
    .sort();
}

async function main(): Promise<void> {
  const command = process.env.CODEX_APP_SERVER_CMD ?? "/opt/homebrew/bin/codex";
  const args = parseArgs();
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  const rl = readline.createInterface({ input: child.stdout });
  const responses = new Map<number | string | null, JsonRpcResponse>();
  const waiters = new Map<number | string | null, (response: JsonRpcResponse) => void>();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const response = JSON.parse(trimmed) as JsonRpcResponse;
    if (!("id" in response)) {
      return;
    }
    const waiter = waiters.get(response.id);
    if (waiter) {
      waiters.delete(response.id);
      waiter(response);
    } else {
      responses.set(response.id, response);
    }
  });

  let nextId = 1;
  const request = (method: string, params: unknown = {}): Promise<JsonRpcResponse> => {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    child.stdin.write(`${payload}\n`);
    const existing = responses.get(id);
    if (existing) {
      responses.delete(id);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr=${stderr.join("").trim()}`));
      }, 10_000);
      waiters.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  };
  const notify = (method: string, params: unknown = {}): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  try {
    const initialized = await request("initialize", {
      clientInfo: {
        name: "codex_bridge_probe",
        title: "Codex Bridge Protocol Probe",
        version: "0.1.0"
      },
      capabilities: {
        optOutNotificationMethods: ["item/agentMessage/delta"]
      }
    });
    if (initialized.error) {
      throw new Error(`initialize failed: ${initialized.error.message ?? "unknown error"}`);
    }
    notify("initialized");
    const unknown = await request("__codex_bridge_probe_unknown_method__", {});
    const message = unknown.error?.message ?? "";
    const runtimeRequestMethods = extractExpectedMethods(message);
    if (runtimeRequestMethods.length === 0) {
      throw new Error(`Could not parse unknown-method response: ${message}`);
    }

    const registryRequestMethods = APP_SERVER_METHODS
      .filter((method) => method.kind === "request")
      .map((method) => method.method)
      .sort();
    const registrySet = new Set(registryRequestMethods);
    const runtimeSet = new Set(runtimeRequestMethods);
    const missingInRegistry = runtimeRequestMethods.filter((method) => !registrySet.has(method));
    const notInRuntime = registryRequestMethods.filter((method) => !runtimeSet.has(method));

    console.log(
      JSON.stringify(
        {
          probe: APP_SERVER_PROTOCOL_PROBE,
          command,
          args,
          runtimeRequestCount: runtimeRequestMethods.length,
          registryRequestCount: registryRequestMethods.length,
          missingInRegistry,
          registryRequestsNotInRuntime: notInRuntime
        },
        null,
        2
      )
    );
    if (missingInRegistry.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    child.stdin.end();
    child.kill();
    rl.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
