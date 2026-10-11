export class SessionDecisionOperationQueue {
  private readonly operationBySession = new Map<string, Promise<void>>();

  async run(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operationBySession.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operationBySession.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.operationBySession.get(sessionId) === next) {
        this.operationBySession.delete(sessionId);
      }
    }
  }
}
