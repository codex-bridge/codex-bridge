import type { SessionRecord } from "../../shared/types.js";
import type { RateLimitNotifier } from "./rate-limit-notifier.js";
import type { NotificationSessionRouter } from "./session-router.js";

export type NotificationSessionContextDependencies = {
  router: Pick<NotificationSessionRouter, "remember">;
  rateLimitNotifier: Pick<RateLimitNotifier, "rememberSession">;
};

export class NotificationSessionContext {
  constructor(private readonly deps: NotificationSessionContextDependencies) {}

  remember(session: SessionRecord): void {
    this.deps.router.remember(session);
    this.deps.rateLimitNotifier.rememberSession(session.codexThreadId, session.id);
  }
}
