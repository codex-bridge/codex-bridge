import { asRecord, firstString } from "./protocol-utils.js";

const categories: Record<string, string> = {
  apiKeySpendLimitExceeded: "API key spend limit reached",
  organizationSpendLimitExceeded: "Organization spend limit reached",
  projectSpendLimitExceeded: "Project spend limit reached",
  bioPolicy: "Biological safety policy refusal"
};

/** Public explanations only; never expose arbitrary payloads or continuation instructions. */
export function publicErrorDetails(value: unknown): string[] {
  const error = asRecord(value);
  const classification = typeof error?.codexErrorInfo === "string" ? categories[error.codexErrorInfo] : undefined;
  return [...new Set([classification, firstString(error?.additionalDetails), firstString(asRecord(error?.misalignment)?.detailedExplanation)]
    .filter((text): text is string => Boolean(text?.trim())).map(text => Array.from(text.trim()).slice(0, 2000).join("")))];
}

export function renderPublicError(message: string, details: readonly string[]): string {
  return [message, ...details.filter(detail => detail !== message).map(detail => `Details: ${detail}`)].join("\n");
}
