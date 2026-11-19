const statusLabels = new Map<string, string>([
  ["pending", "Pending"],
  ["inProgress", "In progress"],
  ["running", "Running"],
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["blocked", "Blocked"],
  ["stopped", "Stopped"],
  ["approved", "Approved"],
  ["denied", "Denied"],
  ["timedOut", "Timed out"],
  ["aborted", "Aborted"]
]);

/** Display only: unknown upstream values retain their meaning and spelling. */
export function formatActivityStatus(status: string): string {
  return statusLabels.get(status) ?? status;
}
