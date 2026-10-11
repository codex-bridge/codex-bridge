import { CodexAppServerClient } from "../../src/codex/client.js";
import { normalizeFullThreadTurnsPage } from "../../src/codex/thread-history.js";
import type { AppConfig } from "../../src/config/index.js";

const threadId = process.env.THREAD_ID?.trim();
if (!threadId) {
  throw new Error("THREAD_ID is required.");
}
const targetThreadId = threadId;
const itemsView = process.env.ITEMS_VIEW === "full" ? "full" : "summary";

function makeConfig(): AppConfig {
  return {
    telegramBotToken: "probe",
    telegramAllowedChatIds: null,
    slackEnabled: false,
    slackBotToken: null,
    slackAppToken: null,
    slackSigningSecret: null,
    slackSocketClientPingTimeoutMs: 15_000,
    slackSocketServerPingTimeoutMs: 45_000,
    bridgeCallbackSecret: null,
    slackAllowedChannelIds: null,
    slackAudioTranscriptionModel: "gpt-4o-mini-transcribe",
    openaiApiKey: null,
    bridgeDbFile: ":memory:",
    codexTransport: "stdio",
    codexAppServerCommand: process.env.CODEX_APP_SERVER_CMD ?? "codex",
    codexAppServerArgs: ["app-server"],
    codexAppServerWsUrl: null,
    codexServiceName: "codex-bridge-timeline-probe",
    codexAutoCompactOnIncompatibleHistory: false
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function summarizeTimeline(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  const data = Array.isArray(record?.data) ? record.data : [];
  const entries = data.map((value) => {
    const entry = asRecord(value);
    const item = asRecord(entry?.item);
    const error = asRecord(entry?.error);
    return {
      type: entry?.type ?? null,
      position: entry?.position ?? null,
      turnId: entry?.turnId ?? null,
      itemType: item?.type ?? null,
      itemId: item?.id ?? null,
      status: asRecord(entry?.status)?.type ?? entry?.status ?? null,
      error: error?.message ?? null,
      startedAt: entry?.startedAt ?? null,
      completedAt: entry?.completedAt ?? null,
      durationMs: entry?.durationMs ?? null
    };
  });
  return {
    count: entries.length,
    nextCursor: record?.nextCursor ?? null,
    activeRealtimeSessionAtPageStart: record?.activeRealtimeSessionAtPageStart ?? null,
    entries
  };
}

function summarizeTurns(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  const data = Array.isArray(record?.data) ? record.data : [];
  return {
    count: data.length,
    nextCursor: record?.nextCursor ?? null,
    backwardsCursor: record?.backwardsCursor ?? null,
    turns: data.map((value) => {
      const turn = asRecord(value);
      const items = Array.isArray(turn?.items) ? turn.items : [];
      return {
        id: turn?.id ?? null,
        status: asRecord(turn?.status)?.type ?? turn?.status ?? null,
        itemCount: items.length,
        itemTypes: items.map((item) => asRecord(item)?.type ?? null),
        itemIds: items.map((item) => asRecord(item)?.id ?? null),
        startedAt: turn?.startedAt ?? null,
        completedAt: turn?.completedAt ?? null,
        durationMs: turn?.durationMs ?? null
      };
    })
  };
}

function summarizeNormalizedTurns(result: unknown): Record<string, unknown> {
  const page = normalizeFullThreadTurnsPage(result, threadId!);
  return {
    nextCursor: page.nextCursor,
    turns: page.turns.map((turn) => ({
      id: turn.turnId,
      entries: turn.entries.map((entry) => entry.kind === "progress"
        ? `${entry.kind}:${entry.event.label}`
        : entry.kind === "message"
          ? `${entry.kind}:${entry.role}`
          : entry.kind)
    }))
  };
}

function loadedThreadIds(result: unknown): string[] {
  const record = asRecord(result);
  const data = Array.isArray(record?.data) ? record.data : [];
  return data
    .map((value) => typeof value === "string" ? value : asRecord(value)?.id)
    .filter((value): value is string => typeof value === "string");
}

async function capture<T>(operation: () => Promise<T>): Promise<
  { ok: true; value: T } | { ok: false; error: string }
> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main(): Promise<void> {
  const client = new CodexAppServerClient(makeConfig());
  try {
    await client.connect();
    const loadedBefore = loadedThreadIds(
      await client.requestKnownMethod("thread/loaded/list", {}, { timeoutMs: 8_000 })
    );
    const firstResult = await capture(() => client.requestKnownMethod(
      "thread/timeline/list",
      { threadId: targetThreadId, limit: 8 },
      { timeoutMs: 8_000 }
    ));
    const first = firstResult.ok ? summarizeTimeline(firstResult.value) : null;
    const nextCursor = typeof first?.nextCursor === "string"
      ? first.nextCursor
      : null;
    const secondResult = nextCursor
      ? await capture(() => client.requestKnownMethod(
          "thread/timeline/list",
          { threadId: targetThreadId, cursor: nextCursor, limit: 8 },
          { timeoutMs: 8_000 }
        ))
      : null;
    const second = secondResult?.ok ? summarizeTimeline(secondResult.value) : secondResult;
    const turnsResult = await capture(() => client.requestKnownMethod(
      "thread/turns/list",
      { threadId: targetThreadId, limit: 3, sortDirection: "desc", itemsView },
      { timeoutMs: 8_000 }
    ));
    const turnsFirst = turnsResult.ok ? summarizeTurns(turnsResult.value) : null;
    const turnsFirstNormalized = turnsResult.ok
      ? await capture(async () => summarizeNormalizedTurns(turnsResult.value))
      : null;
    const turnsCursor = typeof turnsFirst?.nextCursor === "string"
      ? turnsFirst.nextCursor
      : null;
    const turnsSecondResult = turnsCursor
      ? await capture(() => client.requestKnownMethod(
          "thread/turns/list",
          {
            threadId: targetThreadId,
            cursor: turnsCursor,
            limit: 3,
            sortDirection: "desc",
            itemsView
          },
          { timeoutMs: 8_000 }
        ))
      : null;
    const turnsSecond = turnsSecondResult?.ok
      ? summarizeTurns(turnsSecondResult.value)
      : turnsSecondResult;
    const turnsSecondNormalized = turnsSecondResult?.ok
      ? await capture(async () => summarizeNormalizedTurns(turnsSecondResult.value))
      : null;
    const normalized = await capture(async () => (
      await client.listRecentThreadMessages(targetThreadId, 5)
    ).map((message) => ({
      role: message.role,
      turnId: message.turnId,
      itemId: message.itemId,
      textLength: message.text.length
    })));
    const loadedAfter = loadedThreadIds(
      await client.requestKnownMethod("thread/loaded/list", {}, { timeoutMs: 8_000 })
    );

    console.log(JSON.stringify({
      runtime: client.getRuntimeInfo(),
      threadId,
      itemsView,
      loadedBefore: loadedBefore.includes(targetThreadId),
      loadedAfter: loadedAfter.includes(targetThreadId),
      timeline: { first, second },
      turns: {
        first: turnsFirst,
        firstNormalized: turnsFirstNormalized,
        second: turnsSecond,
        secondNormalized: turnsSecondNormalized
      },
      normalized
    }, null, 2));
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
