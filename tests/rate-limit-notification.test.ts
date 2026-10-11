import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import type { BridgeMessageOptions, BridgeMessageTransport } from "../src/bridge/transport.js";
import type { CodexAppServerClient } from "../src/codex/client.js";
import type { AppConfig } from "../src/config/index.js";
import type { SessionRecord } from "../src/shared/types.js";
import { BridgeStore } from "../src/store/index.js";

type TestNotificationSessionContext = { remember: (session: SessionRecord) => void };

function testConfig(databasePath: string): AppConfig {
  return {
    telegramBotToken: "",
    telegramAllowedChatIds: null,
    slackEnabled: true,
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: "secret",
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

test("rate limit warnings are not broadcast to known Slack chats without an active turn target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-warning-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    await store.ensureChat("slack:T123:D123");
    const notificationService = service as unknown as {
      handleAppServerNotification(notification: unknown): Promise<void>;
    };

    await notificationService.handleAppServerNotification({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: {
            leftPercent: 87,
            windowDurationMins: 10080
          },
          secondary: null
        }
      }
    });

    assert.equal(sends.length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate limit warnings are sent only to the current Slack session thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-target-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    await store.ensureChat("slack:T123:CROOT");
    const currentSession = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:333.444",
      codexThreadId: "thread-other",
      pathKey: directory,
      currentCwd: directory,
      displayName: "other",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(currentSession);

    await testService.handleAppServerNotification({
      method: "turn/started",
      params: {
        threadId: "thread-current",
        turn: {
          id: "turn-current"
        }
      }
    });
    await testService.handleAppServerNotification({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: {
            leftPercent: 87,
            windowDurationMins: 10080
          },
          secondary: null
        }
      }
    });

    const warnings = sends.filter((send) => send.text.includes("limit warning"));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.chatId, "slack:T123:CROOT:111.222");
    assert.match(warnings[0]?.text ?? "", /^Codex account · rate limit\n/);
    assert.match(warnings[0]?.text ?? "", /weekly limit warning: 90% left/);
    assert.match(warnings[0]?.text ?? "", /87% left/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("model rate limit warnings keep the matching session title", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-model-target-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const config = testConfig(databasePath);
  const service = new BridgeService(
    config,
    store,
    {
      readCodexConfigSnapshot: async () => ({ model: "gpt-5.3-codex-spark" })
    } as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(session);

    await testService.handleAppServerNotification({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: {
            leftPercent: 100,
            windowDurationMins: 300
          },
          secondary: null
        },
        rateLimitsByLimitId: {
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            limitName: "GPT-5.3-Codex-Spark",
            primary: {
              leftPercent: 87,
              windowDurationMins: 300
            },
            secondary: null
          }
        }
      }
    });

    const warnings = sends.filter((send) => send.text.includes("limit warning"));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.chatId, "slack:T123:CROOT:111.222");
    assert.match(warnings[0]?.text ?? "", /^GPT-5\.3-Codex-Spark 5h · rate limit\n/);
    assert.match(warnings[0]?.text ?? "", /GPT-5.3-Codex-Spark 5h limit warning: 90% left/);
    assert.match(warnings[0]?.text ?? "", /87% left/);
    assert.equal(warnings[0]?.options?.messageSpec?.title, "GPT-5.3-Codex-Spark 5h · rate limit");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const observed of [false, true]) {
  test(`weekly-only model excludes account 5h warnings and resets (observed model: ${observed})`, async () => {
    const store = new BridgeStore(":memory:");
    const sends: { chatId: string; text: string }[] = [];
    const config = testConfig(":memory:");
    const client = {
      getObservedThreadModel: (id: string) => observed && id === "weekly" ? "weekly-model" : null,
      readCodexConfigSnapshot: async (cwd: string) => ({ model: cwd.endsWith("weekly") ? "weekly-model" : "ordinary-model" })
    } as unknown as CodexAppServerClient;
    const service = new BridgeService(config, store, client);
    service.registerMessageTransport({ name: "test", canHandle: () => true,
      sendMessage: async (chatId, text) => { sends.push({ chatId, text }); return { message_id: String(sends.length) }; },
      editMessageText: async () => true, deleteMessage: async () => true,
      clearMessageActions: async () => true, sendTyping: async () => undefined
    });
    try {
      const weekly = await store.upsertDiscoveredSession({ telegramChatId: "slack:T:C:1", codexThreadId: "weekly", pathKey: "/weekly", currentCwd: "/weekly" });
      const ordinary = await store.upsertDiscoveredSession({ telegramChatId: "slack:T:C:2", codexThreadId: "ordinary", pathKey: "/ordinary", currentCwd: "/ordinary" });
      const internal = service as unknown as {
        notificationSessionContext: TestNotificationSessionContext;
        handleAppServerNotification(notification: unknown): Promise<void>;
      };
      internal.notificationSessionContext.remember(weekly);
      internal.notificationSessionContext.remember((await store.getSessionById(ordinary.id))!);
      const update = (left: number, reset: number) => internal.handleAppServerNotification({
        method: "account/rateLimits/updated", params: {
          rateLimits: { limitId: "codex", primary: { leftPercent: left, windowDurationMins: 300, resetsAt: reset }, secondary: null },
          rateLimitsByLimitId: { weekly: { limitId: "weekly", limitName: "weekly-model",
            primary: null, secondary: { leftPercent: left, windowDurationMins: 10080, resetsAt: reset } } }
        }
      });
      await update(89, 1900000000);
      await update(100, 1900100000);
      const weeklyMessages = sends.filter((send) => send.chatId === weekly.telegramChatId);
      assert.ok(weeklyMessages.some((send) => send.text.includes("weekly limit warning")));
      assert.ok(weeklyMessages.some((send) => send.text.includes("weekly limit reset")));
      assert.ok(weeklyMessages.every((send) => !send.text.includes("5h") && !send.text.includes("Codex account")));
      const ordinaryMessages = sends.filter((send) => send.chatId === ordinary.telegramChatId);
      assert.ok(ordinaryMessages.some((send) => send.text.includes("5h limit warning")));
      assert.ok(ordinaryMessages.some((send) => send.text.includes("5h limit reset")));
    } finally { store.close(); }
  });
}

test("rate limit warnings are recalculated when reset time changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-reset-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(session);

    const sendRateLimitUpdate = async (resetsAt: number) => {
      await testService.handleAppServerNotification({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: {
              leftPercent: 87,
              resetsAt,
              windowDurationMins: 10080
            },
            secondary: null
          }
        }
      });
    };

    await sendRateLimitUpdate(1784515470000);
    await sendRateLimitUpdate(1784515470000);
    await sendRateLimitUpdate(1784520000000);

    const warnings = sends.filter((send) => send.text.includes("limit warning"));
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]?.text ?? "", /^Codex account · rate limit\n/);
    assert.match(warnings[0]?.text ?? "", /87% left/);
    assert.match(warnings[1]?.text ?? "", /^Codex account · rate limit\n/);
    assert.match(warnings[1]?.text ?? "", /87% left/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate limit exhausted warning is not repeated for the same reset window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-exhausted-dedupe-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(session);

    const sendRateLimitUpdate = async (resetsAt: number) => {
      await testService.handleAppServerNotification({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: {
              leftPercent: 0,
              resetsAt,
              windowDurationMins: 10080
            },
            secondary: null
          }
        }
      });
    };

    await sendRateLimitUpdate(1784515470000);
    await sendRateLimitUpdate(1784515470000);
    await sendRateLimitUpdate(1784515470000);

    const exhausted = sends.filter((send) => send.text.includes("limit exhausted"));
    assert.equal(exhausted.length, 1);
    assert.match(exhausted[0]?.text ?? "", /0% left/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate limit warning is not repeated when two windows render the same threshold", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-rendered-dedupe-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(session);

    await testService.handleAppServerNotification({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: {
            label: "weekly",
            leftPercent: 46,
            resetsAt: 1786436220000,
            windowDurationMins: 10080
          },
          secondary: {
            label: "weekly",
            leftPercent: 46,
            resetsAt: 1786436220000,
            windowDurationMins: 10080
          }
        }
      }
    });

    const warnings = sends.filter((send) => send.text.includes("weekly limit warning: 50% left"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]?.text ?? "", /46% left/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate limit recovery is detected after a reset time change is first reported as exhausted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-delayed-reset-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(session);

    const sendRateLimitUpdate = async (leftPercent: number, resetsAt: number) => {
      await testService.handleAppServerNotification({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: {
              leftPercent,
              resetsAt,
              windowDurationMins: 10080
            },
            secondary: null
          }
        }
      });
    };

    await sendRateLimitUpdate(0, 1784515470000);
    await sendRateLimitUpdate(0, 1784520000000);
    await sendRateLimitUpdate(100, 1784520000000);

    const exhausted = sends.filter((send) => send.text.includes("limit exhausted"));
    const resets = sends.filter((send) => send.text.includes("limit reset"));
    assert.equal(exhausted.length, 1);
    assert.equal(resets.length, 1);
    assert.match(resets[0]?.text ?? "", /100% left/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate limit reset notification is sent when reset time changes with recovered percentage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-reset-notice-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(session);

    const sendRateLimitUpdate = async (leftPercent: number, resetsAt: number) => {
      await testService.handleAppServerNotification({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: {
              leftPercent,
              resetsAt,
              windowDurationMins: 10080
            },
            secondary: null
          }
        }
      });
    };

    await sendRateLimitUpdate(8, 1784515470000);
    await sendRateLimitUpdate(100, 1784520000000);

    const warnings = sends.filter((send) => send.text.includes("limit warning"));
    const resets = sends.filter((send) => send.text.includes("limit reset"));
    assert.equal(warnings.length, 1);
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.chatId, "slack:T123:CROOT:111.222");
    assert.match(resets[0]?.text ?? "", /^Codex account · rate limit\n/);
    assert.match(resets[0]?.text ?? "", /weekly limit reset/);
    assert.match(resets[0]?.text ?? "", /100% left/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate limit reset notification is sent when usage recovers from below full to full", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-full-reset-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(session);

    const sendRateLimitUpdate = async (leftPercent: number, resetsAt: number) => {
      await testService.handleAppServerNotification({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: {
              leftPercent,
              resetsAt,
              windowDurationMins: 300
            },
            secondary: null
          }
        }
      });
    };

    await sendRateLimitUpdate(99, 1784515470000);
    await sendRateLimitUpdate(100, 1784520000000);

    const resets = sends.filter((send) => send.text.includes("limit reset"));
    assert.equal(resets.length, 1);
    assert.match(resets[0]?.text ?? "", /5h limit reset/);
    assert.match(resets[0]?.text ?? "", /100% left/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate limit reset notification is not repeated for reset times in the same displayed minute", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-minute-dedupe-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(session);

    const sendRateLimitUpdate = async (leftPercent: number, resetsAt: number) => {
      await testService.handleAppServerNotification({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: {
              leftPercent,
              resetsAt,
              windowDurationMins: 300
            },
            secondary: null
          }
        }
      });
    };

    await sendRateLimitUpdate(99, 1784515471000);
    await sendRateLimitUpdate(100, 1784520000000);
    await sendRateLimitUpdate(99, 1784520001000);
    await sendRateLimitUpdate(100, 1784520059000);

    const resets = sends.filter((send) => send.text.includes("limit reset"));
    assert.equal(resets.length, 1);
    assert.match(resets[0]?.text ?? "", /100% left/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate limit reset notification is not sent when reset time changes without recovered percentage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-bridge-rate-limit-reset-correction-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const store = new BridgeStore(databasePath);
  const sends: Array<{ chatId: string; text: string; options?: BridgeMessageOptions }> = [];
  const service = new BridgeService(
    testConfig(databasePath),
    store,
    {} as unknown as CodexAppServerClient
  );
  const transport: BridgeMessageTransport = {
    name: "test",
    canHandle: () => true,
    sendMessage: async (chatId, text, options) => {
      sends.push({ chatId, text, options });
      return { message_id: String(sends.length) };
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    clearMessageActions: async () => true,
    sendTyping: async () => undefined
  };
  service.registerMessageTransport(transport);

  try {
    const session = await store.upsertDiscoveredSession({
      telegramChatId: "slack:T123:CROOT:111.222",
      codexThreadId: "thread-current",
      pathKey: directory,
      currentCwd: directory,
      displayName: "current",
      latestActivityAt: Date.now()
    });
    const testService = service as unknown as {
      notificationSessionContext: TestNotificationSessionContext;
      handleAppServerNotification(notification: unknown): Promise<void>;
    };
    testService.notificationSessionContext.remember(session);

    const sendRateLimitUpdate = async (leftPercent: number, resetsAt: number) => {
      await testService.handleAppServerNotification({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            limitId: "codex",
            primary: {
              leftPercent,
              resetsAt,
              windowDurationMins: 10080
            },
            secondary: null
          }
        }
      });
    };

    await sendRateLimitUpdate(87, 1784515470000);
    await sendRateLimitUpdate(88, 1784520000000);

    const resets = sends.filter((send) => send.text.includes("limit reset"));
    assert.equal(resets.length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
