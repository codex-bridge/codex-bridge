import type { MessageBodyPart, MessageSpec } from "./types.js";

// Temporary activity cards must stay editable on every supported transport.
// This is intentionally independent from the much larger platform limits.
export const TEMPORARY_MESSAGE_BODY_MAX_LENGTH = 800;

export function truncateTemporaryMessageSpec(
  spec: MessageSpec,
  maxLength = TEMPORARY_MESSAGE_BODY_MAX_LENGTH
): MessageSpec {
  if (maxLength <= 0) return { ...spec, body: [] };
  const length = spec.body.reduce((sum, part) => sum + Array.from(bodyText(part)).length, 0);
  if (length <= maxLength) return spec;
  // Reserve the ellipsis before splitting the budget across text/code parts.
  let remaining = maxLength - 1;
  let truncated = false;
  const body = spec.body.map((part) => {
    if (truncated) return null;
    const text = bodyText(part);
    const length = Array.from(text).length;
    if (length <= remaining) {
      remaining -= length;
      return part;
    }
    truncated = true;
    return replaceBodyText(part, ellipsize(text, remaining + 1));
  }).filter((part): part is MessageBodyPart => Boolean(part));

  return truncated ? { ...spec, body } : spec;
}

function bodyText(part: MessageBodyPart): string {
  return part.type === "field" ? `${part.label} ${part.value}` : part.text;
}

function replaceBodyText(part: MessageBodyPart, text: string): MessageBodyPart {
  return part.type === "field" ? { ...part, value: text } : { ...part, text };
}

function ellipsize(text: string, maxLength: number): string {
  if (maxLength <= 0) return "…";
  const chars = Array.from(text);
  if (maxLength === 1) return "…";
  return `${chars.slice(0, maxLength - 1).join("")}…`;
}
