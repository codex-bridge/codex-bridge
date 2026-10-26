import { config as loadDotenv } from "dotenv";
import { isIP } from "node:net";

const dotenvPaths = process.env.DOTENV_CONFIG_PATHS
  ?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (dotenvPaths && dotenvPaths.length > 0) {
  for (const path of dotenvPaths) {
    loadDotenv({ path, override: false });
  }
} else {
  loadDotenv({
    path: process.env.DOTENV_CONFIG_PATH?.trim() || undefined,
    override: process.env.DOTENV_OVERRIDE !== "false"
  });
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  return raw === "true";
}

function optionalMilliseconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number of milliseconds.`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) {
    throw new Error(`${name} must be between 1000 and 120000 milliseconds.`);
  }
  return value;
}

function parseAllowedChatIds(raw: string | undefined): Set<string> | null {
  if (!raw?.trim()) {
    return null;
  }

  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

export interface AppConfig {
  /** Undefined keeps existing chat-only configurations unchanged. */
  web?: { host: string; port: number; tls?: { certFile: string; keyFile: string } };
  telegramBotToken: string;
  telegramAllowedChatIds: Set<string> | null;
  slackEnabled: boolean;
  slackBotToken: string | null;
  slackAppToken: string | null;
  slackSigningSecret: string | null;
  slackSocketClientPingTimeoutMs: number;
  slackSocketServerPingTimeoutMs: number;
  bridgeCallbackSecret: string | null;
  slackAllowedChannelIds: Set<string> | null;
  slackAudioTranscriptionModel?: string;
  openaiApiKey?: string | null;
  bridgeDbFile: string;
  codexTransport: "stdio" | "websocket";
  codexAppServerCommand: string;
  codexAppServerArgs: string[];
  codexAppServerWsUrl: string | null;
  codexServiceName: string;
  codexAutoCompactOnIncompatibleHistory: boolean;
}

export type CodexRuntimeConfig = Pick<
  AppConfig,
  | "codexTransport"
  | "codexAppServerCommand"
  | "codexAppServerArgs"
  | "codexAppServerWsUrl"
  | "codexServiceName"
  | "codexAutoCompactOnIncompatibleHistory"
>;

function parseJsonArray(raw: string | undefined, name: string): string[] {
  if (!raw?.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return parsed;
}

function parseCodexAppServerArgs(raw: string | undefined): string[] {
  const args = parseJsonArray(raw, "CODEX_APP_SERVER_ARGS");
  const resolved = args.length > 0 ? args : ["app-server"];
  const forbidden = resolved.find((arg) =>
    arg === "-c" ||
    arg === "--config" ||
    arg.startsWith("--config=") ||
    arg === "--enable" ||
    arg.startsWith("--enable=") ||
    arg === "--disable" ||
    arg.startsWith("--disable=")
  );
  if (forbidden) {
    throw new Error(
      `CODEX_APP_SERVER_ARGS cannot override Codex configuration (${forbidden}). Use Codex config.toml instead.`
    );
  }
  return resolved;
}

export function loadCodexRuntimeConfig(): CodexRuntimeConfig {
  const transport = optional("CODEX_TRANSPORT", "stdio");
  if (transport !== "stdio" && transport !== "websocket") {
    throw new Error("CODEX_TRANSPORT must be either stdio or websocket.");
  }

  return {
    codexTransport: transport,
    codexAppServerCommand: optional("CODEX_APP_SERVER_CMD", "codex"),
    codexAppServerArgs: parseCodexAppServerArgs(process.env.CODEX_APP_SERVER_ARGS),
    codexAppServerWsUrl: process.env.CODEX_APP_SERVER_WS_URL?.trim() || null,
    codexServiceName: optional("CODEX_SERVICE_NAME", "codex-bridge"),
    codexAutoCompactOnIncompatibleHistory: optionalBoolean(
      "CODEX_AUTO_COMPACT_ON_INCOMPATIBLE_HISTORY",
      false
    )
  };
}

export function loadConfig(): AppConfig {
  const codexRuntime = loadCodexRuntimeConfig();
  const webEnabledRaw = process.env.WEB_ENABLED?.trim();
  if (webEnabledRaw && webEnabledRaw !== "true" && webEnabledRaw !== "false") {
    throw new Error("WEB_ENABLED must be true or false.");
  }
  let web: AppConfig["web"];
  if (webEnabledRaw === "true") {
    const host = optional("WEB_HOST", "127.0.0.1");
    const rawPort = optional("WEB_PORT", "8787");
    if (host !== "localhost" && !isIP(host)) {
      throw new Error("WEB_HOST must be an IP address or localhost.");
    }
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("WEB_PORT must be an integer between 1 and 65535.");
    }
    const certFile = process.env.WEB_TLS_CERT_FILE?.trim();
    const keyFile = process.env.WEB_TLS_KEY_FILE?.trim();
    if (Boolean(certFile) !== Boolean(keyFile)) throw new Error("WEB_TLS_CERT_FILE and WEB_TLS_KEY_FILE must be configured together.");
    web = { host, port, ...(certFile && keyFile ? { tls: { certFile, keyFile } } : {}) };
  }

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const slackEnabled = optionalBoolean("SLACK_ENABLED", false);
  const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim() || null;
  const slackAppToken = process.env.SLACK_APP_TOKEN?.trim() || null;
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET?.trim() || null;
  const bridgeCallbackSecret = process.env.BRIDGE_CALLBACK_SECRET?.trim() || null;
  if (!telegramBotToken && !slackEnabled && !web) {
    throw new Error("At least one chat adapter or Web entry must be configured: TELEGRAM_BOT_TOKEN, SLACK_ENABLED=true, or WEB_ENABLED=true.");
  }
  if (slackEnabled && (!slackBotToken || !slackAppToken || !slackSigningSecret)) {
    throw new Error("SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET are required when SLACK_ENABLED=true.");
  }

  return {
    ...(web ? { web } : {}),
    telegramBotToken,
    telegramAllowedChatIds: parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    slackEnabled,
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    slackSocketClientPingTimeoutMs: optionalMilliseconds(
      "SLACK_SOCKET_CLIENT_PING_TIMEOUT_MS",
      15_000
    ),
    slackSocketServerPingTimeoutMs: optionalMilliseconds(
      "SLACK_SOCKET_SERVER_PING_TIMEOUT_MS",
      45_000
    ),
    bridgeCallbackSecret,
    slackAllowedChannelIds: parseAllowedChatIds(process.env.SLACK_ALLOWED_CHANNEL_IDS),
    slackAudioTranscriptionModel: optional("SLACK_AUDIO_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"),
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || null,
    bridgeDbFile: optional("BRIDGE_DB_FILE", "./workspaces/bridge.sqlite"),
    ...codexRuntime
  };
}
