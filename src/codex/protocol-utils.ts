export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function extractMessageText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const direct = firstString(record.text, record.content, record.message);
  if (direct) {
    return direct;
  }

  if (Array.isArray(record.content)) {
    const parts = record.content
      .map((item) => {
        const itemRecord = asRecord(item);
        return firstString(itemRecord?.text, itemRecord?.content);
      })
      .filter((item): item is string => Boolean(item))
      .map((item) => item.trim());
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  return null;
}
