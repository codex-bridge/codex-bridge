import type { MessageBodyPart, MessageSpec } from "./types.js";

export type ActivityContentPart = { type: "text" | "code"; text: string };

export function messageBodyPartText(part: MessageBodyPart): string {
  return part.type === "field" ? `${part.label}: ${part.value}` : part.text;
}

export function messagePlainText(spec: Pick<MessageSpec, "title" | "body">): string {
  return [spec.title, ...spec.body.map(messageBodyPartText)].join("\n");
}

// Activity text is literal. Preserve code boundaries and join only adjacent text.
export function groupActivityContent(spec: Pick<MessageSpec, "title" | "body">): ActivityContentPart[] {
  const parts: ActivityContentPart[] = [];
  let text = spec.title;
  const flush = () => {
    if (text) parts.push({ type: "text", text });
    text = "";
  };
  for (const part of spec.body) {
    if (part.type === "code") {
      flush();
      parts.push({ type: "code", text: part.text });
    } else {
      text += `${text ? "\n" : ""}${messageBodyPartText(part)}`;
    }
  }
  flush();
  return parts;
}
