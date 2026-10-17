import type { SessionRecord } from "../../shared/types.js";
import { formatSessionMarker } from "../../shared/session-tag.js";
import type { BridgeStore } from "../../store/index.js";
import { logger } from "../../logging/logger.js";
import { actionRow, messageAction } from "../messages/actions.js";
import { createMessage, messageContextForSession } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";
import { formatSessionMenuLabel } from "./menu-formatters.js";
import { renderCurrentSessionMenuSection, type CurrentSessionSnapshot } from "./state-presentation.js";
import type { CachedThreadProvider } from "../../codex/thread-metadata-cache.js";
import {
  SessionMenuSnapshotCache,
  type DirectoryMenuGroup,
  type SectionMenuEntry,
  type SessionDirectoryMenuSnapshot
} from "./menu-snapshots.js";

export type { DirectoryMenuGroup, SectionMenuEntry, SessionDirectoryMenuSnapshot } from "./menu-snapshots.js";

type SessionMenuStore = Pick<BridgeStore, "listKnownSessions" | "listLatestMessageTimes">;

export type SessionMenuServiceDependencies = {
  store: SessionMenuStore;
  sessionsPageSize: number;
  snapshots: SessionMenuSnapshotCache;
  getSessionSelectorChatId: (chatId: string) => string;
  refreshSessionsForChat: (chatId: string, options?: { includeUnknownThreads?: boolean }) => Promise<void>;
  getSessionDirectory: (session: SessionRecord) => string;
  sortSessionsByMenuActivity: (sessions: SessionRecord[], activityTimes: Map<string, number>) => SessionRecord[];
  hashDirectoryKey: (directoryKey: string) => string;
  formatDirectoryMenuLabel: (group: DirectoryMenuGroup) => string;
  formatSectionMenuLabel: (entry: SectionMenuEntry, provider: string) => Promise<string>;
  getSessionProvider: (threadId: string) => CachedThreadProvider;
  readEffectiveProvider: (directory: string) => Promise<string | null>;
  readEffectiveProviderLabel: (directory: string) => Promise<string>;
  getCurrentSessionSnapshot: (chatId: string) => Promise<CurrentSessionSnapshot | null>;
};

export type SessionMenuRenderOptions = {
  refresh?: boolean;
  includeUnknownThreads?: boolean;
  reuseSnapshot?: boolean;
};

export class SessionMenuService {
  constructor(private readonly deps: SessionMenuServiceDependencies) {}

  async getDirectoryGroup(
    telegramChatId: string,
    directoryHash: string
  ): Promise<DirectoryMenuGroup | null> {
    const { groups } = await this.buildSessionDirectoryGroups(telegramChatId);
    return groups.find((group) => group.hash === directoryHash) ?? null;
  }

  async renderSessionMenu(
    telegramChatId: string,
    page = 0,
    options?: SessionMenuRenderOptions
  ): Promise<MessageSpec> {
    const menuOptions = options ?? { refresh: false, reuseSnapshot: false };
    const { hiddenCount, groups } = await this.buildSessionDirectoryGroups(
      this.deps.getSessionSelectorChatId(telegramChatId),
      menuOptions
    );
    const current = renderCurrentSessionMenuSection(await this.deps.getCurrentSessionSnapshot(telegramChatId));
    const totalPages = Math.max(1, Math.ceil(groups.length / this.deps.sessionsPageSize));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const visibleGroups = groups.slice(safePage * this.deps.sessionsPageSize, (safePage + 1) * this.deps.sessionsPageSize);
    logger.info("bridge.session_menu.render", {
      chatId: telegramChatId,
      directoryCount: groups.length,
      hiddenSessionCount: hiddenCount,
      page: safePage,
      totalPages
    });
    if (groups.length === 0) {
      logger.warn("bridge.session_menu.empty", { chatId: telegramChatId, hiddenSessionCount: hiddenCount });
      const messageSpec = this.createMenuSpec(
        current,
        "Sessions",
        [
          ...(current?.messageSpec.actions ?? []),
          ...actionRow(
            messageAction("archived", "Archived", "session-archived", "Sessions"),
            messageAction("refresh", "Refresh", "session-refresh", "Sessions"),
            messageAction("help", "Help", "quick:help")
          )
        ],
        [
          ...(current ? [{ type: "heading" as const, text: "Current session" }] : []),
          ...(current?.messageSpec.body ?? []),
          { type: "text", text: "No sessions are currently available." },
          ...(hiddenCount > 0
            ? [{ type: "text" as const, text: `${hiddenCount} session${hiddenCount === 1 ? "" : "s"} hidden because the provider does not match Codex config.` }]
            : []),
          { type: "text", text: "No recoverable Codex threads were found for this chat." },
          { type: "text", text: "Try again after the app server has existing threads available." }
        ],
        current?.messageSpec.session
      );
      return messageSpec;
    }

    const messageSpec = this.createMenuSpec(
      current,
      "Sessions",
      [
        ...(current?.messageSpec.actions ?? []),
        ...visibleGroups.map((group) => messageAction(
          `directory-${group.hash}`,
          this.deps.formatDirectoryMenuLabel(group),
          `session-dir:${group.hash}:0`,
          "Sessions"
        )),
        ...(totalPages > 1
          ? actionRow(
              ...(safePage > 0 ? [messageAction("previous", "Previous", `session-page:${safePage - 1}`, "Sessions")] : []),
              messageAction("page", `${safePage + 1}/${totalPages}`, "noop", "Sessions"),
              ...(safePage < totalPages - 1 ? [messageAction("next", "Next", `session-page:${safePage + 1}`, "Sessions")] : [])
            )
          : []),
        ...actionRow(
          messageAction("archived", "Archived", "session-archived", "Sessions"),
          messageAction("refresh", "Refresh", "session-refresh", "Sessions"),
          messageAction("help", "Help", "quick:help")
        )
      ],
      [
        ...(current ? [{ type: "heading" as const, text: "Current session" }] : []),
        ...(current?.messageSpec.body ?? [])
      ],
      current?.messageSpec.session
    );
    return messageSpec;
  }

  async renderArchivedSessionMenu(
    telegramChatId: string,
    page = 0
  ): Promise<MessageSpec> {
    const selectorChatId = this.deps.getSessionSelectorChatId(telegramChatId);
    await this.deps.refreshSessionsForChat(selectorChatId);
    const sessions = (await this.deps.store.listKnownSessions(selectorChatId, { includeArchived: true }))
      .filter((session) => session.codexArchivedAt !== null);
    const activityTimes = new Map(
      [...(await this.deps.store.listLatestMessageTimes(sessions.map((session) => session.id))).entries()]
    );
    const sortedSessions = this.deps.sortSessionsByMenuActivity(sessions, activityTimes);
    const totalPages = Math.max(1, Math.ceil(sortedSessions.length / this.deps.sessionsPageSize));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const visibleSessions = sortedSessions.slice(
      safePage * this.deps.sessionsPageSize,
      (safePage + 1) * this.deps.sessionsPageSize
    );
    logger.info("bridge.archived_session_menu.render", {
      chatId: telegramChatId,
      archivedSessionCount: sortedSessions.length,
      page: safePage,
      totalPages
    });
    const actions = [
      ...visibleSessions.map((session) => messageAction(
        `unarchive-${session.id}`,
        `Archived · ${formatSessionMenuLabel(session, { activityTimes })}`,
        `session-unarchive:${session.id}`,
        "Archived sessions"
      )),
      ...(totalPages > 1
        ? actionRow(
            ...(safePage > 0 ? [messageAction("previous", "Previous", `session-archived-page:${safePage - 1}`, "Archived sessions")] : []),
            messageAction("page", `${safePage + 1}/${totalPages}`, "noop", "Archived sessions"),
            ...(safePage < totalPages - 1 ? [messageAction("next", "Next", `session-archived-page:${safePage + 1}`, "Archived sessions")] : [])
          )
        : []),
      ...actionRow(
        messageAction("help", "Help", "quick:help"),
        messageAction("back", "Back", "session-page:0")
      )
    ];
    return this.createMenuSpec(
        null,
        "Archived sessions",
        actions,
        sortedSessions.length === 0
          ? [{ type: "text", text: "No archived sessions are available." }]
          : [{ type: "text", text: "Choose a session to restore." }]
      );
  }

  async renderSessionSectionMenu(
    telegramChatId: string,
    directoryHash: string,
    page = 0
  ): Promise<MessageSpec> {
    const { groups } = await this.buildSessionDirectoryGroups(
      this.deps.getSessionSelectorChatId(telegramChatId),
      { refresh: false, reuseSnapshot: true }
    );
    const group = groups.find((candidate) => candidate.hash === directoryHash);
    if (!group) {
      return this.createMenuSpec(null, "Sessions", actionRow(
        messageAction("refresh", "Refresh", "session-refresh", "Sessions"),
        messageAction("help", "Help", "quick:help"),
        messageAction("back", "Back", "session-page:0")
      ), [
          { type: "text", text: "Session directory menu expired." },
          { type: "text", text: "Refresh to load the current session directories." }
        ]);
    }
    const entries = [...group.entries].sort((left, right) => right.activityAt - left.activityAt);
    const totalPages = Math.max(1, Math.ceil(entries.length / this.deps.sessionsPageSize));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const visibleEntries = entries.slice(safePage * this.deps.sessionsPageSize, (safePage + 1) * this.deps.sessionsPageSize);
    const snapshot = await this.deps.getCurrentSessionSnapshot(telegramChatId);
    const current = snapshot?.session.directory === group.directoryKey
      ? renderCurrentSessionMenuSection(snapshot)
      : null;
    logger.info("bridge.session_section_menu.render", {
      chatId: telegramChatId,
      directoryHash,
      directoryKey: group.directoryKey,
      sectionCount: entries.length,
      page: safePage,
      totalPages
    });

    const providerLabel = await this.deps.readEffectiveProviderLabel(group.directoryKey);
    const labels = await Promise.all(visibleEntries.map((entry) => this.deps.formatSectionMenuLabel(entry, providerLabel)));
    const messageSpec = this.createMenuSpec(
      current,
      `Sections · ${formatSessionMarker(group.directoryKey)}`,
      [
        ...(current?.messageSpec.actions ?? []),
        ...visibleEntries.map((entry, index) => messageAction(
          `section-${entry.session.id}`,
          labels[index] ?? "Session",
          `section:${entry.session.id}`,
          "Sessions"
        )),
        ...(totalPages > 1
          ? actionRow(
              ...(safePage > 0 ? [messageAction("previous", "Previous", `section-page:${directoryHash}:${safePage - 1}`, "Sessions")] : []),
              messageAction("page", `${safePage + 1}/${totalPages}`, "noop", "Sessions"),
              ...(safePage < totalPages - 1 ? [messageAction("next", "Next", `section-page:${directoryHash}:${safePage + 1}`, "Sessions")] : [])
            )
          : []),
        ...actionRow(
          messageAction("new-session", "New session", `session-new:${directoryHash}`, "Sessions"),
          messageAction("refresh", "Refresh", "session-refresh", "Sessions"),
          messageAction("help", "Help", "quick:help"),
          messageAction("back", "Back", "session-page:0")
        )
      ],
      [
        ...(current ? [{ type: "heading" as const, text: "Current session" }] : []),
        ...(current?.messageSpec.body ?? []),
      ]
    );
    return messageSpec;
  }

  private createMenuSpec(
    current: { messageSpec: MessageSpec } | null,
    title: string,
    actions: MessageSpec["actions"],
    body?: MessageSpec["body"],
    titleSession?: MessageSpec["session"]
  ): MessageSpec {
    return createMessage({
      kind: "menu",
      surface: "session-selector",
      titleLabel: title,
      ...messageContextForSession(titleSession),
      body: body ?? current?.messageSpec.body ?? [],
      actions
    });
  }

  private async buildSessionDirectoryGroups(
    telegramChatId: string,
    options?: SessionMenuRenderOptions
  ): Promise<SessionDirectoryMenuSnapshot> {
    const cached = options?.reuseSnapshot ? this.deps.snapshots.getFresh(telegramChatId) : null;
    if (cached) {
      logger.info("bridge.session_menu.snapshot_hit", {
        chatId: telegramChatId,
        expiresInMs: cached.expiresAt - Date.now(),
        directoryCount: cached.groups.length
      });
      return cached;
    }
    if (options?.refresh === true) {
      await this.deps.refreshSessionsForChat(telegramChatId, {
        includeUnknownThreads: options?.includeUnknownThreads
      });
    }
    let discoveredSessions = await this.deps.store.listKnownSessions(telegramChatId);
    if (discoveredSessions.length === 0 && options?.refresh !== true) {
      await this.deps.refreshSessionsForChat(telegramChatId, {
        includeUnknownThreads: options?.includeUnknownThreads
      });
      discoveredSessions = await this.deps.store.listKnownSessions(telegramChatId);
    }
    const storedMessageTimes = await this.deps.store.listLatestMessageTimes(discoveredSessions.map((session) => session.id));
    const activityTimes = new Map(discoveredSessions.map((session) => [
      session.id,
      Math.max(session.latestActivityAt, storedMessageTimes.get(session.id) ?? 0)
    ]));
    const sortedSessions = this.deps.sortSessionsByMenuActivity(discoveredSessions, activityTimes);
    const entriesByDirectory = new Map<string, SectionMenuEntry[]>();
    const providerByDirectory = new Map<string, string | null>();
    await Promise.all([...new Set(sortedSessions.map((session) => this.deps.getSessionDirectory(session)))].map(async (directoryKey) => {
      providerByDirectory.set(directoryKey, await this.deps.readEffectiveProvider(directoryKey));
    }));
    const sessionProviders = sortedSessions.map((session) => ({
      sessionId: session.id,
      provider: providerByDirectory.get(this.deps.getSessionDirectory(session))
        ? this.resolveSessionProvider(session.codexThreadId)
        : { provider: null, known: false }
    }));
    const providerBySession = new Map(sessionProviders.map((entry) => [entry.sessionId, entry.provider]));
    let hiddenCount = 0;
    for (const session of sortedSessions) {
      const directoryKey = this.deps.getSessionDirectory(session);
      const effectiveProvider = providerByDirectory.get(directoryKey) ?? null;
      const sessionProvider = providerBySession.get(session.id) ?? { provider: null, known: false };
      if (
        effectiveProvider &&
        sessionProvider.known &&
        sessionProvider.provider &&
        sessionProvider.provider !== effectiveProvider
      ) {
        hiddenCount += 1;
        logger.info("bridge.session_menu.provider_filtered", {
          chatId: telegramChatId,
          sessionId: session.id,
          threadId: session.codexThreadId,
          sessionProvider: sessionProvider.provider,
          effectiveProvider
        });
        continue;
      }
      const entry: SectionMenuEntry = {
        session,
        activityAt: activityTimes.get(session.id) ?? session.latestActivityAt
      };
      entriesByDirectory.set(directoryKey, [...(entriesByDirectory.get(directoryKey) ?? []), entry]);
    }
    const groups = [...entriesByDirectory.entries()]
      .map(([directoryKey, entries]) => ({
        directoryKey,
        hash: this.deps.hashDirectoryKey(directoryKey),
        sectionCount: entries.length,
        activityAt: Math.max(...entries.map((entry) => entry.activityAt)),
        entries
      }))
      .sort((left, right) => right.activityAt - left.activityAt);
    return this.deps.snapshots.set(telegramChatId, {
      discoveredCount: discoveredSessions.length,
      hiddenCount,
      groups
    });
  }

  private resolveSessionProvider(threadId: string): CachedThreadProvider {
    // Only the native thread/list inventory controls menu visibility. thread/read
    // can expose historical provider metadata after an offline provider migration.
    return this.deps.getSessionProvider(threadId);
  }
}
