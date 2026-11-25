import type { CodexAppServerClient } from "../../codex/client.js";
import type { BridgeStore } from "../../store/index.js";
import { SessionAccessService } from "./access.js";
import { createMessage, messageContextForSession } from "../messages/factory.js";
import type { MessageSpec } from "../messages/types.js";
import { helpAction, messageAction } from "../messages/actions.js";
import { createSessionActionCallback } from "./action-callbacks.js";

export type CodexFeatureCommand = "search" | "provider" | "realtime";

/** Shared explicit commands; adapters retain their existing command eligibility rules. */
export class CodexFeatureCommands {
  constructor(private readonly deps: { store: BridgeStore;
    client: Pick<CodexAppServerClient, "searchThreads" | "listModelProviders" | "setDefaultModelProvider" | "readRealtimeHistory">;
    directory: (session: import("../../shared/types.js").SessionRecord) => string }) {}

  async run(sourceId: string, command: CodexFeatureCommand, argument: string): Promise<MessageSpec> {
    const session = await this.deps.store.getActiveSession(sourceId);
    const context = messageContextForSession(session ? { id: session.id, directory: this.deps.directory(session) } : undefined);
    const message = (body: string, titleLabel: string, kind: MessageSpec["kind"] = "system") => createMessage({ kind, titleLabel, ...context,
      body: [{ type: "text", text: body }], actions: [helpAction()] });
    try {
      if (command === "search") {
        if (!argument.trim()) return message("Use /search <text> to search saved conversations.", "Session search");
        const page = await this.deps.client.searchThreads(argument, { limit: 8 });
        const actions = page.data.flatMap(result => {
          if (!result.directory) return [];
          const sessionId = this.deps.store.registerCatalogSession({ threadId: result.threadId, directory: result.directory,
            pathKey: result.directory, name: result.name }, sourceId);
          return [messageAction("handoff", result.name ?? result.threadId.slice(0, 8), createSessionActionCallback("handoff", sessionId))];
        });
        return createMessage({ kind: "menu", titleLabel: "Session search", ...context,
          body: [{ type: "text", text: page.data.map(result => [result.name ?? result.threadId, result.directory,
            Array.from(result.snippet).slice(0, 240).join("")].filter(Boolean).join("\n")).join("\n\n") || "No matching sessions." }], actions });
      }
      if (command === "provider") {
        if (argument.trim()) {
          await this.deps.client.setDefaultModelProvider(argument.trim());
          return message("Codex default provider updated. The next turn reads the latest configuration; existing sessions retain Codex's provider compatibility checks.", "Provider");
        }
        const catalog = await this.deps.client.listModelProviders();
        return message([`Default: ${catalog.defaultProviderId}`, ...catalog.data.map(provider => `${provider.id} · ${provider.name}`),
          catalog.canChangeDefault ? "Use /provider <id> to change Codex's global default." : "Default provider is managed by Codex."].join("\n"), "Provider");
      }
      if (!session) return message("Select a session first.", "Realtime history", "error");
      const access = await new SessionAccessService(this.deps.store).requireOwned(session.codexThreadId, sourceId, undefined, () => {});
      const page = await this.deps.client.readRealtimeHistory(session.codexThreadId);
      access.assertCurrent();
      return message(page.coverage !== "ready" ? `Realtime history: ${page.coverage}.` :
        page.data.map(entry => entry.text !== null ? `${entry.role ?? "Transcript"}: ${entry.text}` : entry.type).join("\n") || "No realtime history.", "Realtime history");
    } catch (error) {
      return message(error instanceof Error ? error.message : "Codex request failed.", command === "realtime" ? "Realtime history" : command === "search" ? "Session search" : "Provider", "error");
    }
  }
}
