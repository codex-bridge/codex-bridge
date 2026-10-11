import type { KnownBlock, PlainTextElement } from "@slack/types";
import { WebClient } from "@slack/web-api";

import type {
  BridgeMessageOptions,
  BridgeMessageTransport,
  BridgeSentMessage
} from "../bridge/transport.js";
import { renderLegacyMessage } from "../bridge/messages/legacy-adapter.js";
import type { MessageSpec } from "../bridge/messages/types.js";
import { logger } from "../logging/logger.js";
import { encodeSlackCallbackValue } from "./callback.js";
import { renderSlackMessageSpec } from "./message-renderer.js";
import { messageTransportPlatform } from "../shared/source-address.js";

type SlackChatRef = {
  channelId: string;
  teamId: string;
  threadTs: string | null;
};

type SlackActionButton = {
  callback_data?: string;
  text?: string;
  url?: string;
};

export function buildSlackChatId(input: {
  channelId: string;
  teamId: string;
  threadTs?: string | null;
}): string {
  const threadSuffix = input.threadTs ? `:${encodeURIComponent(input.threadTs)}` : "";
  return `slack:${input.teamId}:${input.channelId}${threadSuffix}`;
}

export function parseSlackChatId(chatId: string): SlackChatRef | null {
  const match = /^slack:([^:]+):([^:]+)(?::(.+))?$/.exec(chatId);
  if (!match) {
    return null;
  }
  return {
    teamId: match[1] ?? "",
    channelId: match[2] ?? "",
    threadTs: match[3] ? decodeURIComponent(match[3]) : null
  };
}

export class SlackMessageTransport implements BridgeMessageTransport {
  readonly name = "slack";

  constructor(
    private readonly client: WebClient,
    private readonly callbackSecret: string | null = null
  ) {}

  canHandle(chatId: string): boolean {
    return messageTransportPlatform(chatId) === "slack";
  }

  async sendMessageSpec(
    chatId: string,
    messageSpec: MessageSpec,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null> {
    return this.sendMessage(chatId, renderLegacyMessage(messageSpec), { ...options, messageSpec });
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<BridgeSentMessage | null> {
    const ref = this.requireSlackChatRef(chatId);
    const startedAt = Date.now();
    const response = await this.client.chat.postMessage({
      channel: ref.channelId,
      text,
      thread_ts: ref.threadTs ?? undefined,
      blocks: this.buildBlocks(chatId, text, options)
    });
    const messageId = response.ts ?? null;
    logger.info("slack.message.send", {
      channelId: ref.channelId,
      chatId,
      messageId,
      purpose: options?.purpose ?? null,
      threadTs: ref.threadTs,
      elapsedMs: Date.now() - startedAt
    });
    return messageId ? { message_id: messageId } : null;
  }

  async editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    options?: BridgeMessageOptions
  ): Promise<boolean> {
    const ref = this.requireSlackChatRef(chatId);
    const startedAt = Date.now();
    await this.client.chat.update({
      channel: ref.channelId,
      ts: messageId,
      text,
      blocks: this.buildBlocks(chatId, text, options)
    });
    logger.info("slack.message.edit", {
      channelId: ref.channelId,
      chatId,
      messageId,
      purpose: options?.purpose ?? null,
      threadTs: ref.threadTs,
      elapsedMs: Date.now() - startedAt
    });
    return true;
  }

  async editMessageSpec(
    chatId: string,
    messageId: string,
    messageSpec: MessageSpec,
    options?: BridgeMessageOptions
  ): Promise<boolean> {
    return this.editMessageText(chatId, messageId, renderLegacyMessage(messageSpec), { ...options, messageSpec });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<boolean> {
    const ref = this.requireSlackChatRef(chatId);
    await this.client.chat.delete({
      channel: ref.channelId,
      ts: messageId
    });
    return true;
  }

  async clearMessageActions(
    chatId: string,
    messageId: string,
    text?: string,
    contentBlocks?: unknown[]
  ): Promise<boolean> {
    const ref = this.requireSlackChatRef(chatId);
    const startedAt = Date.now();
    const preservedBlocks = contentBlocks?.filter((block): block is KnownBlock =>
      typeof block === "object" && block !== null && "type" in block && block.type !== "actions"
    );
    const hasCallbackBlocks = contentBlocks !== undefined;
    const blocks: KnownBlock[] = hasCallbackBlocks
      ? preservedBlocks ?? []
      : text !== undefined
        ? this.buildContentBlocks(text)
        : [];
    await this.client.chat.update(text !== undefined
      ? {
          channel: ref.channelId,
          ts: messageId,
          text,
          blocks
        }
      : {
          channel: ref.channelId,
          ts: messageId,
          blocks
        });
    logger.info("slack.message.actions_clear", {
      channelId: ref.channelId,
      chatId,
      messageId,
      preservedText: text !== undefined,
      contentBlocksRestored: blocks.length,
      contentBlocksSource: hasCallbackBlocks
        ? "callback"
        : text !== undefined
          ? "rebuild"
          : "empty",
      threadTs: ref.threadTs,
      elapsedMs: Date.now() - startedAt
    });
    return true;
  }

  async sendTyping(): Promise<void> {
    // Slack has no chat typing API equivalent for bots.
  }

  private requireSlackChatRef(chatId: string): SlackChatRef {
    const ref = parseSlackChatId(chatId);
    if (!ref) {
      throw new Error(`Invalid Slack chat id: ${chatId}`);
    }
    return ref;
  }

  private buildBlocks(chatId: string, text: string, options?: BridgeMessageOptions): KnownBlock[] | undefined {
    if (options?.messageSpec) {
      return this.truncateBlocks(renderSlackMessageSpec(chatId, options.messageSpec, this.callbackSecret));
    }
    // COMPATIBILITY(MESSAGE_FACTORY): legacy text-only callers still require inferred common actions.
    const quickActionBlock = this.shouldRenderQuickActions(text)
      ? this.buildActionBlock(chatId, [
        { text: "Go", callback_data: "quick:go" },
        { text: "Next", callback_data: "quick:next" },
        { text: "Help", callback_data: "quick:help" }
      ], 99)
      : null;
    const workingInterruptBlock = this.shouldRenderWorkingInterruptAction(text)
      ? this.buildActionBlock(chatId, [
        { text: "Queue", callback_data: "quick:queue" },
        { text: "Interrupt", callback_data: "quick:interrupt" }
      ], 97)
      : null;

    const contentBlocks = this.buildContentBlocks(text);
    return this.truncateBlocks([
      ...contentBlocks,
      ...(quickActionBlock ? [quickActionBlock] : []),
      ...(workingInterruptBlock ? [workingInterruptBlock] : [])
    ]);
  }

  private buildContentBlocks(text: string): KnownBlock[] {
    const lines = text.trim()
      .split(/\n/)
      .map((line) => line.trimEnd())
      .filter((line) => !this.isSessionMenuHeading(line));
    if (lines.length === 0 || !lines.some((line) => line.trim())) {
      return [];
    }
    const firstLine = lines[0]?.trim() ?? "";

    if (
      firstLine === "Codex" ||
      firstLine.startsWith("Codex · ") ||
      firstLine === "Codex account" ||
      firstLine.startsWith("Codex account · ") ||
      firstLine.startsWith("Actions · ")
    ) {
      const headerBlocks = this.buildPlainTextBlocks(`**${firstLine}**`);
      const bodyLines = lines.slice(1).filter((line) => !this.isQuickActionsLine(line));
      const secondLine = bodyLines[0]?.trim() ?? "";
      if (secondLine === "Sessions" || secondLine.startsWith("Sections · ")) {
        return [
          ...headerBlocks,
          ...this.buildContentBlocks(bodyLines.join("\n"))
        ];
      }
      return this.buildPlainTextBlocks([
        `**${firstLine}**`,
        ...bodyLines
      ].join("\n"));
    }
    if (firstLine === "Sessions") {
      if (lines[1]?.trim() === "Choose a directory.") {
        return this.buildTitledBlocks("Choose a directory", lines.slice(2));
      }
      return this.buildTitledBlocks("Sessions", lines.slice(1));
    }
    if (firstLine.startsWith("Sections · ")) {
      return this.buildTitledBlocks("Sections", [
        `Directory: ${firstLine.slice("Sections · ".length)}`,
        ...lines.slice(1)
      ]);
    }
    if (firstLine.startsWith("Working · ")) {
      return this.buildPlainTextBlocks([
        `**Working**${firstLine.slice("Working".length)}`,
        ...lines.slice(1)
      ].join("\n"));
    }
    if (this.isTranscriptHeaderLine(firstLine)) {
      return this.buildPlainTextBlocks([
        `**${firstLine}**`,
        ...lines.slice(1)
      ].join("\n"));
    }
    if (this.isBoldOnlyLine(firstLine)) {
      return this.buildKeyValueBlocks(this.stripBold(firstLine), lines.slice(1));
    }
    if (firstLine.startsWith("Switched to ") || firstLine.startsWith("Created and switched to ")) {
      return this.buildTitledBlocks(firstLine, lines.slice(1));
    }

    return this.buildPlainTextBlocks(text);
  }

  private buildTitledBlocks(title: string, lines: string[]): KnownBlock[] {
    return this.buildPlainTextBlocks([
      `**${title}**`,
      ...lines.map((line) => line.trim()).filter(Boolean)
    ].join("\n"));
  }

  private buildKeyValueBlocks(title: string, lines: string[]): KnownBlock[] {
    const bodySections: string[] = [`*${this.escapeSlackText(title)}*`];
    const spacedSections = title === "Codex status";
    let bodyLines: string[] = [];
    const flushBodyLines = () => {
      if (bodyLines.length === 0) {
        return;
      }
      bodySections.push(bodyLines.join("\n"));
      bodyLines = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (this.isBoldOnlyLine(line)) {
        flushBodyLines();
        const currentSection = this.stripBold(line);
        bodySections.push(`*${this.escapeSlackText(currentSection)}*`);
        continue;
      }
      const keyValueLine = this.toSlackKeyValueLine(line);
      if (keyValueLine) {
        bodyLines.push(keyValueLine);
        if (bodyLines.length === 12) {
          flushBodyLines();
        }
        continue;
      }
      flushBodyLines();
      bodySections.push(this.toSlackMrkdwn(line));
    }
    flushBodyLines();
    return [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: this.truncateBlockText(this.joinKeyValueSections(bodySections, spacedSections))
      }
    }];
  }

  private joinKeyValueSections(sections: string[], spacedSections: boolean): string {
    if (!spacedSections) {
      return sections.join("\n");
    }
    return sections.reduce((text, section, index) => {
      if (index === 0) {
        return section;
      }
      const previous = sections[index - 1] ?? "";
      const separator = index === 1 || previous.includes("\n") ? "\n\n" : "\n";
      return `${text}${separator}${section}`;
    }, "");
  }

  private buildPlainTextBlocks(text: string): KnownBlock[] {
    return [this.buildPlainTextSectionBlock(text)];
  }

  private buildPlainTextSectionBlock(text: string): KnownBlock {
    return {
      type: "section",
      text: {
        type: "mrkdwn",
        text: this.truncateBlockText(this.toSlackMrkdwn(text))
      }
    };
  }


  private truncateBlocks(blocks: KnownBlock[]): KnownBlock[] {
    if (blocks.length <= 50) {
      return blocks;
    }
    return [
      ...blocks.slice(0, 49),
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*More actions hidden*\nUse the text command for items not shown."
        }
      }
    ];
  }


  private isSessionMenuHeading(line: string): boolean {
    if (!this.isBoldOnlyLine(line)) {
      return false;
    }
    const title = this.stripBold(line);
    return title === "Sessions" ||
      title === "Directories" ||
      title === "Sections" ||
      title.startsWith("Sections · ");
  }

  private toSlackKeyValueLine(line: string): string | null {
    const boldField = /^\*\*([^*]+)\*\*\s*(.*)$/.exec(line);
    if (boldField) {
      return `*${this.escapeSlackText(boldField[1] ?? "")}*  ${this.toSlackMrkdwn(boldField[2] ?? "")}`;
    }
    const colonField = /^([^:]{1,32}):\s*(.+)$/.exec(line);
    if (colonField) {
      return `*${this.escapeSlackText(colonField[1] ?? "")}*  ${this.toSlackMrkdwn(colonField[2] ?? "")}`;
    }
    return null;
  }

  private shouldRenderQuickActions(text: string): boolean {
    return text.trim().split(/\n/).some((line) => this.isQuickActionsLine(line));
  }

  private shouldRenderWorkingInterruptAction(text: string): boolean {
    return text.trim().split(/\n/).some((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("Working · ") && !trimmed.startsWith("Working · Done");
    });
  }

  private isQuickActionsLine(line: string): boolean {
    return /^\/go\s+·\s+\/next\s+·\s+\/help$/.test(line.trim());
  }

  private isTranscriptHeaderLine(line: string): boolean {
    return /^(User|Assistant|Called|Edited|System|Compact started|Compact completed|Codex error|Codex stream error|MCP result) · \S/.test(line.trim());
  }

  private toSlackMrkdwn(text: string): string {
    const slackLinks: string[] = [];
    const codeSpans: string[] = [];
    const stashSlackLink = (link: string): string => {
      const token = `\uE000SLACK_LINK_${slackLinks.length}\uE000`;
      slackLinks.push(link);
      return token;
    };
    const stashCodeSpan = (code: string): string => {
      const token = `\uE000CODE_SPAN_${codeSpans.length}\uE000`;
      codeSpans.push(code);
      return token;
    };
    const protectedText = text
      .replace(/`\s*(<https?:\/\/[^<>\s|]+(?:\|[^<>]+)?>)\s*`/g, (_match, link: string) => stashSlackLink(link))
      .replace(/<https?:\/\/[^<>\s|]+(?:\|[^<>]+)?>/g, (link) => stashSlackLink(link))
      .replace(/`([^`\n]+)`/g, (_match, code: string) => stashCodeSpan(code.trim()));
    return this.escapeSlackText(protectedText)
      .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
      .replace(/\[([^\]]+)\]/g, "`$1`")
      .replace(/\uE000CODE_SPAN_(\d+)\uE000/g, (_match, index: string) => ` \`${codeSpans[Number(index)] ?? ""}\` `)
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\uE000SLACK_LINK_(\d+)\uE000/g, (_match, index: string) => slackLinks[Number(index)] ?? "");
  }

  private escapeSlackText(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private isBoldOnlyLine(line: string): boolean {
    return /^\*\*[^*]+\*\*$/.test(line.trim());
  }

  private stripBold(text: string): string {
    return text.trim().replace(/^\*\*/, "").replace(/\*\*$/, "");
  }

  private buildActionBlock(
    chatId: string,
    row: SlackActionButton[],
    rowIndex: number
  ): KnownBlock | null {
    const elements = row
      .filter((button) => button.text?.trim() && button.text.trim() !== " ")
      .slice(0, 5)
      .map((button, index) => {
        const text: PlainTextElement = {
          type: "plain_text",
          text: this.truncateButtonText(button.text ?? "Action"),
          emoji: false
        };
        if (button.url) {
          return {
            type: "button" as const,
            text,
            url: button.url,
            action_id: `bridge_url_${rowIndex}_${index}`
          };
        }
        return {
          type: "button" as const,
          text,
          value: encodeSlackCallbackValue(chatId, button.callback_data ?? button.text ?? "", this.callbackSecret),
          action_id: `bridge_callback_${rowIndex}_${index}`
        };
      });
    if (elements.length === 0) {
      return null;
    }
    return {
      type: "actions",
      elements
    };
  }

  private truncateBlockText(text: string): string {
    const normalized = text.trim() || " ";
    if (normalized.length <= 3000) {
      return normalized;
    }
    return `${normalized.slice(0, 2999).trimEnd()}…`;
  }

  private truncateButtonText(text: string): string {
    const normalized = text.trim() || "Action";
    if (normalized.length <= 75) {
      return normalized;
    }
    return `${normalized.slice(0, 74).trimEnd()}…`;
  }
}
