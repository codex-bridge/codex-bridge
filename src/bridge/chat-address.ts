export type SlackChatAddress = {
  channelId: string;
  teamId: string;
  threadTs: string | null;
};

export function parseSlackChatId(chatId: string): SlackChatAddress | null {
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

export function getSessionSelectorChatId(chatId: string): string {
  const slackChat = parseSlackChatId(chatId);
  if (!slackChat?.threadTs) {
    return chatId;
  }
  return `slack:${slackChat.teamId}:${slackChat.channelId}`;
}
