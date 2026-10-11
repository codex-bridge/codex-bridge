export const CODEX_BUILT_IN_PROVIDER = "openai";

/**
 * config/read represents the built-in Codex provider as null, while thread/list
 * and thread/read identify the same provider as "openai".
 */
export function resolveCodexProvider(modelProvider: string | null | undefined): string {
  return modelProvider?.trim() || CODEX_BUILT_IN_PROVIDER;
}
