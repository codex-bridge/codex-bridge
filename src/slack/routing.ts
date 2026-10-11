import type { AppConfig } from "../config/index.js";
import type { BridgeChatPort } from "../bridge/contracts.js";
import { buildSlackChatId, parseSlackChatId } from "./transport.js";

export function normalizeSlackCommand(text: string): string {
  return text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

export function getSlackRootTextCommand(chatId: string, text: string): string {
  return isSlackThreadChatId(chatId) ? "" : normalizeSlackCommand(text);
}

export function getCommandArgument(text: string): string {
  const trimmed = text.trim();
  const match = /\s/.exec(trimmed);
  return match ? trimmed.slice(match.index).trim() : "";
}

export function isSlackRootEntryCommand(command: string): boolean {
  return command === "help" || command === "/help" || command === "/codex" ||
    command === "sessions" || command === "/sessions" || command === "session_new" ||
    command === "/session_new" || command === "goals" || command === "/goals";
}

export function isSlackRootManagementCommand(command: string): boolean {
  return isSlackRootEntryCommand(command) ||
    command === "status" || command === "/status" || command === "/codex_status" ||
    command === "status_full" || command === "/status_full" || command === "/codex_status_full" ||
    command === "interrupt" || command === "/interrupt" || command === "/codex-interrupt" ||
    command === "compact" || command === "/compact" || command === "goal" || command === "/goal" ||
    command === "section_rename" || command === "/section_rename" || command === "session_new" ||
    command === "/session_new" || command === "bot_connect" || command === "/bot_connect" ||
    command === "bot_disconnect" || command === "/bot_disconnect" || command === "bot_restart" ||
    command === "/bot_restart";
}

export function stripBotMention(text: string, botUserId: string | null): string {
  return botUserId ? text.replace(new RegExp(`^<@${botUserId}>\\s*`), "").trim() : text.trim();
}

export function isAllowedSlackChannel(config: AppConfig, channelId: string, channelType?: string): boolean {
  return channelType === "im" || !config.slackAllowedChannelIds || config.slackAllowedChannelIds.has(channelId);
}

export function makeChatId(input: {
  channelId: string;
  channelType?: string;
  rootCreatesThread?: boolean;
  teamId: string;
  threadTs?: string | null;
  ts?: string | null;
}): string {
  const threadTs = input.channelType === "im"
    ? input.threadTs ?? null
    : input.threadTs ?? (input.rootCreatesThread ? input.ts ?? null : null);
  return buildSlackChatId({ channelId: input.channelId, teamId: input.teamId, threadTs });
}

export function isSlackThreadChatId(chatId: string): boolean {
  return Boolean(parseSlackChatId(chatId)?.threadTs);
}

export async function isLockedSlackThread(
  service: Pick<BridgeChatPort, "getActiveSession">,
  chatId: string
): Promise<boolean> {
  return isSlackThreadChatId(chatId) && Boolean(await service.getActiveSession(chatId));
}

export function renderLockedSlackThreadSessionMessage(): string {
  return "This thread is already bound to a session.";
}
