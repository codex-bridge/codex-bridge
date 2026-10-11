import assert from "node:assert/strict";
import test from "node:test";

import { NotificationSessionContext } from "../src/bridge/notifications/session-context.js";
import type { SessionRecord } from "../src/shared/types.js";

test("notification session context records routing and rate-limit targets together", () => {
  const calls: string[] = [];
  const session = { id: "session-1", codexThreadId: "thread-1" } as SessionRecord;
  const context = new NotificationSessionContext({
    router: { remember: (value) => calls.push(`route:${value.id}`) },
    rateLimitNotifier: { rememberSession: (threadId, sessionId) => calls.push(`limit:${threadId}:${sessionId}`) }
  });

  context.remember(session);

  assert.deepEqual(calls, ["route:session-1", "limit:thread-1:session-1"]);
});
