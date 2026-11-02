/** Only an explicit rate-limit rejection proves that a write was not accepted. */
export async function slackApiCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (typeof error !== "object" || error === null) throw error;
    const rateLimit = error as { code?: string; retryAfter?: number };
    if (rateLimit.code !== "slack_webapi_rate_limited_error" ||
        typeof rateLimit.retryAfter !== "number" || rateLimit.retryAfter < 0 || rateLimit.retryAfter > 10) throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, rateLimit.retryAfter! * 1000));
    return operation();
  }
}
