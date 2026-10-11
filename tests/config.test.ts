import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config/index.js";

const envKeys = [
  "WEB_ENABLED",
  "WEB_HOST",
  "WEB_PORT",
  "SLACK_ALLOWED_CHANNEL_IDS",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_ENABLED",
  "SLACK_SOCKET_CLIENT_PING_TIMEOUT_MS",
  "SLACK_SOCKET_SERVER_PING_TIMEOUT_MS",
  "SLACK_SIGNING_SECRET",
  "BRIDGE_CALLBACK_SECRET",
  "CODEX_APP_SERVER_ARGS",
  "CODEX_APPROVAL_POLICY",
  "CODEX_EFFORT",
  "CODEX_MODEL",
  "CODEX_NETWORK_ACCESS",
  "CODEX_PERMISSION_MODE",
  "CODEX_PERSONALITY",
  "CODEX_SANDBOX_MODE",
  "CODEX_SKILL_EXTRA_ROOTS",
  "CODEX_SUMMARY",
  "CODEX_WRITABLE_ROOTS",
  "TELEGRAM_ALLOWED_CHAT_IDS",
  "TELEGRAM_BOT_TOKEN"
];

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loads Slack-only chat adapter configuration", () => {
  const config = withEnv(
    {
      SLACK_ALLOWED_CHANNEL_IDS: "C123,G456",
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      BRIDGE_CALLBACK_SECRET: "callback-secret",
      SLACK_ENABLED: "true",
      SLACK_SIGNING_SECRET: "secret"
    },
    () => loadConfig()
  );

  assert.equal(config.telegramBotToken, "");
  assert.equal(config.slackEnabled, true);
  assert.equal(Object.hasOwn(config, "codexPermissionMode"), false);
  assert.equal(Object.hasOwn(config, "codexEffort"), false);
  assert.equal(config.slackBotToken, "xoxb-test");
  assert.equal(config.slackAppToken, "xapp-test");
  assert.equal(config.slackSigningSecret, "secret");
  assert.equal(config.slackSocketClientPingTimeoutMs, 15_000);
  assert.equal(config.slackSocketServerPingTimeoutMs, 45_000);
  assert.equal(config.bridgeCallbackSecret, "callback-secret");
  assert.deepEqual(config.slackAllowedChannelIds, new Set(["C123", "G456"]));
});

test("loads bounded Slack Socket Mode heartbeat timeouts", () => {
  const config = withEnv(
    {
      SLACK_ENABLED: "true",
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "secret",
      SLACK_SOCKET_CLIENT_PING_TIMEOUT_MS: "20000",
      SLACK_SOCKET_SERVER_PING_TIMEOUT_MS: "60000"
    },
    () => loadConfig()
  );

  assert.equal(config.slackSocketClientPingTimeoutMs, 20_000);
  assert.equal(config.slackSocketServerPingTimeoutMs, 60_000);
});

test("rejects invalid Slack Socket Mode heartbeat timeouts", () => {
  assert.throws(
    () => withEnv({
      TELEGRAM_BOT_TOKEN: "telegram-token",
      SLACK_SOCKET_CLIENT_PING_TIMEOUT_MS: "999"
    }, () => loadConfig()),
    /SLACK_SOCKET_CLIENT_PING_TIMEOUT_MS must be between 1000 and 120000 milliseconds/
  );
});

test("ignores removed Bridge behavior variables", () => {
  const config = withEnv(
    {
      CODEX_APPROVAL_POLICY: "never",
      CODEX_EFFORT: "high",
      CODEX_MODEL: "bridge-model",
      CODEX_NETWORK_ACCESS: "true",
      CODEX_PERMISSION_MODE: "full-access",
      CODEX_PERSONALITY: "friendly",
      CODEX_SANDBOX_MODE: "dangerFullAccess",
      CODEX_SKILL_EXTRA_ROOTS: '["/tmp/skills"]',
      CODEX_SUMMARY: "detailed",
      CODEX_WRITABLE_ROOTS: '["/tmp"]',
      TELEGRAM_BOT_TOKEN: "telegram-token"
    },
    () => loadConfig()
  );

  for (const key of [
    "codexApprovalPolicy",
    "codexEffort",
    "codexModel",
    "codexNetworkAccess",
    "codexPermissionMode",
    "codexPersonality",
    "codexSandboxMode",
    "codexSkillExtraRoots",
    "codexSummary",
    "codexWritableRoots"
  ]) {
    assert.equal(Object.hasOwn(config, key), false);
  }
});

test("requires at least one chat adapter", () => {
  assert.throws(
    () => withEnv({}, () => loadConfig()),
    /At least one chat adapter/
  );
});

test("keeps Telegram-only configuration valid", () => {
  const config = withEnv(
    {
      TELEGRAM_ALLOWED_CHAT_IDS: "123,456",
      TELEGRAM_BOT_TOKEN: "telegram-token"
    },
    () => loadConfig()
  );

  assert.equal(config.telegramBotToken, "telegram-token");
  assert.equal(config.slackEnabled, false);
  assert.equal(config.web, undefined);
  assert.deepEqual(config.telegramAllowedChatIds, new Set(["123", "456"]));
});

test("allows Web-only startup and defaults to loopback", () => {
  const config = withEnv({ WEB_ENABLED: "true" }, () => loadConfig());
  assert.deepEqual(config.web, { host: "127.0.0.1", port: 8787 });
  assert.equal(config.telegramBotToken, "");
  assert.equal(config.slackEnabled, false);
});

test("allows explicit LAN listening without enabling chat adapters", () => {
  const config = withEnv({ WEB_ENABLED: "true", WEB_HOST: "0.0.0.0", WEB_PORT: "9090" }, () => loadConfig());
  assert.deepEqual(config.web, { host: "0.0.0.0", port: 9090 });
});

test("rejects invalid Web enablement and listening configuration", () => {
  assert.throws(() => withEnv({ WEB_ENABLED: "yes" }, () => loadConfig()), /WEB_ENABLED/);
  assert.throws(() => withEnv({ WEB_ENABLED: "true", WEB_HOST: "example.com" }, () => loadConfig()), /WEB_HOST/);
  for (const port of ["0", "65536", "12.5", "1e3", "abc"]) {
    assert.throws(() => withEnv({ WEB_ENABLED: "true", WEB_PORT: port }, () => loadConfig()), /WEB_PORT/);
  }
});

test("disabled Web configuration neither opens an entry nor affects chat-only startup", () => {
  const config = withEnv({ TELEGRAM_BOT_TOKEN: "test", WEB_ENABLED: "false", WEB_PORT: "bad" }, () => loadConfig());
  assert.equal(config.web, undefined);
  assert.throws(() => withEnv({ WEB_ENABLED: "false" }, () => loadConfig()), /At least one chat adapter/);
});

test("rejects Codex configuration overrides in app-server arguments", () => {
  assert.throws(
    () => withEnv({
      CODEX_APP_SERVER_ARGS: '["app-server","-c","model=\\"bridge-model\\""]',
      TELEGRAM_BOT_TOKEN: "telegram-token"
    }, () => loadConfig()),
    /cannot override Codex configuration/
  );
});
