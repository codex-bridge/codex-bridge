import { createHmac, timingSafeEqual } from "node:crypto";

const CALLBACK_PREFIX = "bridge:v1:";
// COMPATIBILITY(MESSAGE_FACTORY): accept bridge_spec_* from Slack messages created before action IDs were unified.
export const SLACK_CALLBACK_ACTION_ID_PATTERN = /^bridge_(?:callback|spec)_/;

export type SlackCallbackContext = {
  chatId: string;
  issuedAt: number;
  v: 1;
};

export type DecodedSlackCallbackValue = {
  action: string;
  chatId: string;
};

export function isSlackCallbackValue(value: string): boolean {
  return value.startsWith(CALLBACK_PREFIX);
}

export function encodeSlackCallbackValue(chatId: string, action: string, secret?: string | null): string {
  if (action.startsWith(CALLBACK_PREFIX)) {
    return action;
  }
  const context: SlackCallbackContext = {
    v: 1,
    chatId,
    issuedAt: Date.now()
  };
  const contextToken = Buffer.from(JSON.stringify(context), "utf8").toString("base64url");
  const encodedAction = encodeURIComponent(action);
  if (!secret) {
    return `${CALLBACK_PREFIX}${contextToken}:${encodedAction}`;
  }
  const signature = signSlackCallbackValue(secret, contextToken, encodedAction);
  return `${CALLBACK_PREFIX}${contextToken}:${encodedAction}:${signature}`;
}

export function decodeSlackCallbackValue(value: string, secret?: string | null): DecodedSlackCallbackValue | null {
  if (!value.startsWith(CALLBACK_PREFIX)) {
    return null;
  }
  const rest = value.slice(CALLBACK_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }
  const [contextToken, encodedAction, signature] = parts;
  if (!contextToken || !encodedAction) {
    return null;
  }
  if (signature) {
    if (!secret || !verifySlackCallbackValue(secret, contextToken, encodedAction, signature)) {
      return null;
    }
  } else if (secret) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(contextToken, "base64url").toString("utf8")) as Partial<SlackCallbackContext>;
    if (parsed.v !== 1 || typeof parsed.chatId !== "string" || !parsed.chatId.startsWith("slack:")) {
      return null;
    }
    return {
      action: decodeURIComponent(encodedAction),
      chatId: parsed.chatId
    };
  } catch {
    return null;
  }
}

function signSlackCallbackValue(secret: string, contextToken: string, encodedAction: string): string {
  return createHmac("sha256", secret)
    .update(`${contextToken}:${encodedAction}`)
    .digest("base64url");
}

function verifySlackCallbackValue(
  secret: string,
  contextToken: string,
  encodedAction: string,
  signature: string
): boolean {
  const expected = Buffer.from(signSlackCallbackValue(secret, contextToken, encodedAction), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
