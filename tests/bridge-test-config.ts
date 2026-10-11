import type { AppConfig } from "../src/config/index.js";

export function testConfig(databasePath: string): AppConfig {
  return {
    telegramBotToken: "test",
    telegramAllowedChatIds: null,
    slackEnabled: false,
    slackBotToken: null,
    slackAppToken: null,
    slackSigningSecret: null,
    slackSocketClientPingTimeoutMs: 15_000,
    slackSocketServerPingTimeoutMs: 45_000,
    bridgeCallbackSecret: null,
    slackAllowedChannelIds: null,
    bridgeDbFile: databasePath,
    codexTransport: "stdio",
    codexAppServerCommand: "codex",
    codexAppServerArgs: ["app-server"],
    codexAppServerWsUrl: null,
    codexModel: null,
    codexEffort: "medium",
    codexSummary: "auto",
    codexApprovalPolicy: "on-request",
    codexSandboxMode: "workspaceWrite",
    codexWritableRoots: [],
    codexNetworkAccess: false,
    codexPermissionMode: "default",
    codexPersonality: "pragmatic",
    codexServiceName: "codex-bridge",
    codexSkillExtraRoots: [],
    codexAutoCompactOnIncompatibleHistory: false
  };
}
