import type { MessageBodyPart, MessageSpec } from "./types.js";

// COMPATIBILITY(MESSAGE_FACTORY): remove after transports accept spec-only payloads, including chunked delivery.
export function renderLegacyMessage(spec: MessageSpec): string {
  return [spec.title, ...spec.body.map(renderBodyPart)].join("\n");
}

function renderBodyPart(part: MessageBodyPart): string {
  switch (part.type) {
    case "text":
    case "markdown":
    case "code":
    case "heading":
      return part.text;
    case "field":
      return `${part.label}: ${part.value}`;
  }
}
