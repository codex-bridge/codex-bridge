export type StatusMessageEntry = { messageId: string; text: string };

export class StatusRuntimeState {
  readonly statusMessageBySession = new Map<string, StatusMessageEntry>();
  readonly statusStartedAtBySession = new Map<string, number>();
  readonly statusLabelBySession = new Map<string, string>();
  readonly statusDetailBySession = new Map<string, string>();
  readonly statusLastEditAtBySession = new Map<string, number>();
  readonly statusOpBySession = new Map<string, Promise<void>>();

  resetEditThrottle(sessionId: string): void { this.statusLastEditAtBySession.delete(sessionId); }
  getLabel(sessionId: string): string | undefined { return this.statusLabelBySession.get(sessionId); }
}
