export type TelegramAddress = { chatId: string; topicId: number | null };

/** Numeric addresses retain the existing private/group/General entry. */
export function parseTelegramAddress(sourceId: string): TelegramAddress | null {
  if (/\s/.test(sourceId)) return null;
  if (/^-?\d+$/.test(sourceId)) return { chatId: sourceId, topicId: null };
  const match = /^telegram:(-?\d+):([1-9]\d*)$/.exec(sourceId);
  if (!match) return null;
  const topicId = Number(match[2]);
  return Number.isSafeInteger(topicId) ? { chatId: match[1]!, topicId } : null;
}

export function telegramSourceId(chatId: string, topicId?: number): string {
  if (/\s/.test(chatId) || !/^-?\d+$/.test(chatId)) throw new Error("Invalid Telegram chat ID.");
  if (topicId === undefined) return chatId;
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new Error("Invalid Telegram topic ID.");
  return `telegram:${chatId}:${topicId}`;
}

/** A plain reply thread is not necessarily a forum topic. Never guess an absent topic ID. */
export function telegramSourceForContext(context: {
  chat?: { id: number };
  msg?: { is_topic_message?: boolean; message_thread_id?: number };
}): string {
  if (!context.chat) throw new Error("No Telegram chat context is available.");
  if (context.msg?.is_topic_message && context.msg.message_thread_id === undefined) {
    throw new Error("Telegram topic identity is unavailable.");
  }
  return telegramSourceId(String(context.chat.id), context.msg?.is_topic_message ? context.msg.message_thread_id : undefined);
}
