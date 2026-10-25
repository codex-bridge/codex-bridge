import { BridgeService } from "./bridge/service.js";
import { CodexAppServerClient } from "./codex/client.js";
import { loadConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import { cleanupSlackAttachments } from "./slack/attachments.js";
import { buildSlackBot } from "./slack/bot.js";
import { BridgeStore } from "./store/index.js";
import { buildTelegramBot } from "./telegram/bot.js";
import { TelegramMessageTransport } from "./telegram/transport.js";
import { WebServer } from "./web/server.js";
import { cleanupWebAttachments } from "./web/attachments.js";

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info("app.start", {
    transport: config.codexTransport,
    allowedChatCount: config.telegramAllowedChatIds?.size ?? 0,
    slackEnabled: config.slackEnabled,
    webEnabled: Boolean(config.web),
    slackAllowedChannelCount: config.slackAllowedChannelIds?.size ?? 0,
    logFile: logger.getLogFile(),
    codexAppServerCommand: config.codexAppServerCommand,
    codexAppServerArgs: config.codexAppServerArgs
  });
  const store = new BridgeStore(config.bridgeDbFile);
  const codexClient = new CodexAppServerClient(config);
  const service = new BridgeService(config, store, codexClient);
  const bot = config.telegramBotToken ? buildTelegramBot(config, service) : null;
  if (bot) {
    service.registerMessageTransport(new TelegramMessageTransport(bot, (text) => service.formatTelegramHtml(text)));
  }
  const slack = config.slackEnabled ? buildSlackBot(config, service) : null;
  const web = config.web ? new WebServer(config.web, service.createWebApi()) : null;
  let slackAttachmentCleanupTimer: NodeJS.Timeout | null = null;
  let webAttachmentCleanupTimer: NodeJS.Timeout | null = null;

  await service.bootstrap();

  if (web) {
    const cleanupResult = await cleanupWebAttachments();
    logger.info("web.attachments.cleanup.startup", cleanupResult);
    webAttachmentCleanupTimer = setInterval(() => {
      void cleanupWebAttachments()
        .then((result) => logger.info("web.attachments.cleanup.periodic", result))
        .catch((error) => logger.warn("web.attachments.cleanup.failed", {
          error: error instanceof Error ? error.message : String(error)
        }));
    }, 6 * 60 * 60 * 1000);
    webAttachmentCleanupTimer.unref();
    const address = await web.start();
    logger.info("app.web.ready", { host: address.address, port: address.port });
  }

  if (bot) {
    void bot.start();
    logger.info("app.telegram.ready");
  }
  if (slack) {
    const cleanupResult = await cleanupSlackAttachments();
    logger.info("slack.attachments.cleanup.startup", cleanupResult);
    slackAttachmentCleanupTimer = setInterval(() => {
      void cleanupSlackAttachments()
        .then((result) => logger.info("slack.attachments.cleanup.periodic", result))
        .catch((error) => logger.warn("slack.attachments.cleanup.failed", {
          error: error instanceof Error ? error.message : String(error)
        }));
    }, 6 * 60 * 60 * 1000);
    slackAttachmentCleanupTimer.unref();
    await slack.start();
  }

  const shutdown = async (): Promise<void> => {
    logger.info("app.shutdown.start");
    if (slackAttachmentCleanupTimer) {
      clearInterval(slackAttachmentCleanupTimer);
    }
    if (webAttachmentCleanupTimer) {
      clearInterval(webAttachmentCleanupTimer);
    }
    bot?.stop();
    await web?.stop();
    await slack?.stop();
    await service.shutdown();
    await codexClient.close();
    store.close();
    logger.info("app.shutdown.complete");
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error) => {
  logger.error("app.fatal", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
