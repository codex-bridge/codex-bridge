import { CodexAppServerClient } from "../../src/codex/client.js";
import { loadCodexRuntimeConfig, type AppConfig } from "../../src/config/index.js";

export function createVerificationConfig(): AppConfig {
  const codexRuntime = loadCodexRuntimeConfig();
  return {
    telegramBotToken: "",
    telegramAllowedChatIds: null,
    slackEnabled: false,
    slackBotToken: null,
    slackAppToken: null,
    slackSigningSecret: null,
    slackSocketClientPingTimeoutMs: 15_000,
    slackSocketServerPingTimeoutMs: 45_000,
    bridgeCallbackSecret: null,
    slackAllowedChannelIds: null,
    bridgeDbFile: ":memory:",
    ...codexRuntime,
    codexServiceName: `${codexRuntime.codexServiceName}-verify`
  };
}

export function createVerificationClient(): CodexAppServerClient {
  return new CodexAppServerClient(createVerificationConfig());
}
