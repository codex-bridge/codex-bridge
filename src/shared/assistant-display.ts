// This payload contains display instructions only, never the original restricted answer.
export type AssistantDisplay =
  | { version: 1; mode: "show"; trustedContacts: "check" | "skip";
      annotation?: { kind: "wellbeingHelpline"; subject: "answer" | "prompt" } }
  | { version: 1; mode: "hide"; replacement: { kind: "wellbeingPromptHelpline" } }
  | { version: 1; mode: "block"; reason: { kind: "protection"; protectionType: string } | { kind: "cyber"; trustedAccess?: boolean } }
  | { version: number | null; mode: "restricted" };

export type PresentedAssistantMessage = { text: string; assistantDisplay?: AssistantDisplay; sourceItemId?: string };

const SUPPORT = "Support is available. Consider reaching out to someone you trust or a local crisis helpline. If there is immediate danger, contact local emergency services.";
const BLOCKED = "This response is unavailable under Codex's display rules.";
const RESTRICTED = "This response is unavailable because its display instructions could not be verified.";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function restricted(value: Record<string, unknown> | null): AssistantDisplay {
  return { mode: "restricted", version: typeof value?.version === "number" && Number.isSafeInteger(value.version)
    ? value.version : null };
}

/** Normalize the supported v1 contract; unknown versions/modes never authorize showing an answer. */
export function normalizeAssistantDisplay(value: unknown): AssistantDisplay {
  const display = record(value);
  if (display?.mode === "restricted") return restricted(display);
  if (display?.version !== 1) return restricted(display);
  if (display.mode === "show" && (display.trustedContacts === "check" || display.trustedContacts === "skip")) {
    const annotation = record(display.annotation);
    if (display.annotation != null && (annotation?.kind !== "wellbeingHelpline" ||
        (annotation.subject !== "answer" && annotation.subject !== "prompt"))) return restricted(display);
    return { version: 1, mode: "show", trustedContacts: display.trustedContacts,
      ...(annotation ? { annotation: { kind: "wellbeingHelpline", subject: annotation.subject as "answer" | "prompt" } } : {}) };
  }
  if (display.mode === "hide" && record(display.replacement)?.kind === "wellbeingPromptHelpline") {
    return { version: 1, mode: "hide", replacement: { kind: "wellbeingPromptHelpline" } };
  }
  const reason = record(display.reason);
  if (display.mode === "block" && (reason?.kind === "cyber" ||
      (reason?.kind === "protection" && typeof reason.protectionType === "string"))) {
    return { version: 1, mode: "block", reason: reason.kind === "protection"
      ? { kind: "protection", protectionType: reason.protectionType as string }
      : { kind: "cyber", ...(typeof reason.trustedAccess === "boolean" ? { trustedAccess: reason.trustedAccess } : {}) } };
  }
  return restricted(display);
}

function replacement(display: AssistantDisplay): string | null {
  if (display.mode === "hide") return SUPPORT;
  if (display.mode === "block") return BLOCKED;
  if (display.mode === "restricted") return RESTRICTED;
  return null;
}

/** Resolve upstream moderation before logging, persistence or platform delivery. */
export function presentAssistantText(text: string, moderation: unknown): PresentedAssistantMessage {
  if (moderation == null) return { text };
  const value = record(moderation);
  if (value?.moderated === false && value.display == null) return { text };
  const assistantDisplay = value && typeof value.moderated === "boolean" && value.display != null
    ? normalizeAssistantDisplay(value.display) : restricted(null);
  const substituted = replacement(assistantDisplay);
  return { text: substituted ?? (assistantDisplay.mode === "show" && assistantDisplay.annotation
    ? `${text.trimEnd()}\n\n${SUPPORT}` : text), assistantDisplay };
}

/** Protect an already-presented message/cache without appending annotations a second time. */
export function protectPresentedAssistantText(text: string, value: unknown, previous?: AssistantDisplay): PresentedAssistantMessage {
  // Missing metadata cannot revoke a known restriction for the same native item.
  if (value === undefined && previous && previous.mode !== "show") value = previous;
  if (value === undefined) return { text };
  const assistantDisplay = normalizeAssistantDisplay(value);
  return { text: replacement(assistantDisplay) ?? text, assistantDisplay };
}
