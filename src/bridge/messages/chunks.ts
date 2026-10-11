import type { MessageBodyPart, MessageSpec } from "./types.js";

export function splitMessageSpecByRenderedLength(
  spec: MessageSpec,
  maxLength: number,
  getRenderedLength: (spec: MessageSpec) => number
): MessageSpec[] {
  const withoutActions = { ...spec, actions: [] };
  const groups: MessageBodyPart[][] = [];
  let current: MessageBodyPart[] = [];

  const flush = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  };

  for (const part of spec.body) {
    for (const fragment of splitBodyPartToFit(withoutActions, part, maxLength, getRenderedLength)) {
      const candidate = { ...withoutActions, body: [...current, fragment] };
      if (current.length > 0 && getRenderedLength(candidate) > maxLength) {
        flush();
      }
      current.push(fragment);
    }
  }
  flush();

  if (groups.length === 0) {
    groups.push([]);
  }

  return groups.map((body, index) => ({
    ...spec,
    body,
    actions: index === groups.length - 1 ? spec.actions : []
  }));
}

function splitBodyPartToFit(
  baseSpec: MessageSpec,
  part: MessageBodyPart,
  maxLength: number,
  getRenderedLength: (spec: MessageSpec) => number
): MessageBodyPart[] {
  if (getRenderedLength({ ...baseSpec, body: [part] }) <= maxLength) {
    return [part];
  }

  const rawText = part.type === "field" ? part.value : part.text;
  const pieces: string[] = [];
  let remaining = rawText;
  while (remaining.length > 0) {
    const fittingLength = findLargestFittingLength(
      baseSpec,
      part,
      remaining,
      maxLength,
      getRenderedLength
    );
    if (fittingLength <= 0) {
      pieces.push(remaining);
      break;
    }
    const breakAt = chooseTextBreak(remaining, fittingLength);
    pieces.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  return pieces.filter(Boolean).map((text) => bodyPartWithText(part, text));
}

function findLargestFittingLength(
  baseSpec: MessageSpec,
  part: MessageBodyPart,
  text: string,
  maxLength: number,
  getRenderedLength: (spec: MessageSpec) => number
): number {
  let low = 1;
  let high = Math.min(text.length, maxLength);
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = bodyPartWithText(part, text.slice(0, middle));
    if (getRenderedLength({ ...baseSpec, body: [candidate] }) <= maxLength) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function bodyPartWithText(part: MessageBodyPart, text: string): MessageBodyPart {
  if (part.type === "field") return { type: "field", label: part.label, value: text };
  return { type: part.type, text };
}

function chooseTextBreak(text: string, maxLength: number): number {
  const preferred = [text.lastIndexOf("\n", maxLength), text.lastIndexOf(" ", maxLength)]
    .find((index) => index >= Math.floor(maxLength / 2));
  return preferred && preferred > 0 ? preferred : maxLength;
}
