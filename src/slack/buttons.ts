import type { Button } from "@slack/types";

import { encodeSlackCallbackValue } from "./callback.js";

const BUTTON_TEXT_LIMIT = 75;

// Slack counts Unicode characters, not UTF-16 code units. Never split a surrogate pair.
function buttonText(label: string): string {
  const characters = Array.from(label.trim() || "Action");
  return characters.length <= BUTTON_TEXT_LIMIT
    ? characters.join("")
    : `${characters.slice(0, BUTTON_TEXT_LIMIT - 1).join("").trimEnd()}…`;
}

export function buildSlackButton(input: {
  chatId: string;
  label: string;
  actionId: string;
  callbackSecret: string | null;
  destination: { callback: string } | { url: string };
  style?: "primary" | "danger";
}): Button {
  return {
    type: "button",
    text: { type: "plain_text", text: buttonText(input.label), emoji: false },
    action_id: input.actionId,
    ...("url" in input.destination
      ? { url: input.destination.url }
      : { value: encodeSlackCallbackValue(input.chatId, input.destination.callback, input.callbackSecret) }),
    ...(input.style ? { style: input.style } : {})
  };
}
