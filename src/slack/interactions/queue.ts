import { encodeSlackCallbackValue } from "../callback.js";

export function buildSlackQueueModal(chatId: string, callbackSecret: string | null) {
  return {
    type: "modal" as const,
    callback_id: "bridge_queue_submit",
    private_metadata: encodeSlackCallbackValue(chatId, "queue:submit", callbackSecret),
    title: { type: "plain_text" as const, text: "Queue message" },
    submit: { type: "plain_text" as const, text: "Queue" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [{ type: "input" as const, block_id: "queue", label: { type: "plain_text" as const, text: "Message" },
      element: { type: "plain_text_input" as const, action_id: "text", multiline: true } }]
  };
}

export function readSlackQueueModalText(values: Record<string, Record<string, { value?: string | null }>>): string {
  return values.queue?.text?.value?.trim() ?? "";
}
