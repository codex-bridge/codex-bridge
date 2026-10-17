import { formatSessionMarker } from "../../shared/session-tag.js";
import { helpAction } from "./actions.js";
import type {
  ActionSpec,
  DeliverySpec,
  MessageBodyPart,
  MessageKind,
  MessageSpec,
  SessionContext
} from "./types.js";
import type { SessionRecord } from "../../shared/types.js";

const MESSAGE_LABELS: Record<MessageKind, string> = {
  codex: "Codex",
  progress: "Progress",
  failed: "Failed",
  called: "Called",
  edited: "Edited",
  working: "Working",
  actions: "Actions",
  mcp: "MCP result",
  decision: "Decision",
  "decision-batch": "Decisions",
  system: "System",
  error: "Codex error",
  "stream-error": "Codex stream error",
  "compact-started": "Compact started",
  "compact-completed": "Compact completed",
  "version-update": "Codex update",
  queue: "Queue",
  subagent: "Subagent",
  refresh: "Codex",
  menu: "Codex",
  user: "User"
};

// A missing context is not the same as an intentionally global message.
export type MessageContextInput =
  | { session: SessionContext; directory?: never; scope?: never }
  | { directory: string; session?: never; scope?: never }
  | { scope: "global"; session?: never; directory?: never };

type MessageContentInput = {
  kind: MessageKind;
  body?: MessageBodyPart[];
  actions?: ActionSpec[];
  delivery?: DeliverySpec;
  titleLabel?: string;
  surface?: MessageSpec["surface"];
};

export type CreateMessageInput = MessageContentInput & MessageContextInput;
type MessageInput = Omit<MessageContentInput, "kind"> & MessageContextInput;

export function messageContextForSession(session: SessionContext | null | undefined): MessageContextInput {
  return session ? { session } : { scope: "global" };
}

export function createMessage(input: CreateMessageInput): MessageSpec {
  const contextCount = Number(input.session != null) + Number(input.directory !== undefined) + Number(input.scope === "global");
  if (contextCount !== 1) {
    throw new Error("Message context must specify exactly one of session, directory, or global scope.");
  }
  const label = input.titleLabel ?? MESSAGE_LABELS[input.kind];
  const directory = input.session?.directory ?? input.directory;
  const title = directory !== undefined
    ? `${label} · ${formatSessionMarker(directory)}`
    : label;

  return {
    kind: input.kind,
    title,
    ...(input.session ? { session: input.session } : {}),
    body: [...(input.body ?? [])],
    actions: [...(input.actions ?? [])],
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.surface ? { surface: input.surface } : {})
  };
}

export function createCodexMessage(input: MessageInput): MessageSpec {
  return createMessage({ ...input, kind: "codex" });
}

export function createCalledMessage(input: MessageInput): MessageSpec {
  return createMessage({ ...input, kind: "called" });
}

export function createEditedMessage(input: MessageInput): MessageSpec {
  return createMessage({ ...input, kind: "edited" });
}

export function createWorkingMessage(input: MessageInput): MessageSpec {
  return createMessage({ ...input, kind: "working" });
}

export function createProgressMessage(input: {
  directory: string;
  label: string;
  failed?: boolean;
  body?: MessageBodyPart[];
}): MessageSpec {
  return createMessage({
    kind: input.failed ? "failed" : "progress",
    titleLabel: input.label,
    session: { id: null, directory: input.directory },
    body: input.body
  });
}

export class BridgeMessageFactory {
  constructor(private readonly getSessionDirectory: (session: SessionRecord) => string) {}

  createSessionActionSpec(
    session: SessionRecord | null,
    kind: MessageSpec["kind"],
    body: string,
    actions: MessageSpec["actions"]
  ): MessageSpec {
    return createMessage({
      kind,
      ...messageContextForSession(session ? this.sessionContext(session) : null),
      body: [{ type: "text", text: body }],
      actions
    });
  }

  createCommandResultSpec(
    kind: MessageSpec["kind"],
    body: string,
    actions: MessageSpec["actions"] = [helpAction()]
  ): MessageSpec {
    return createMessage({
      kind,
      scope: "global",
      titleLabel: "Codex",
      body: [{ type: "text", text: body }],
      actions
    });
  }

  createSessionCommandResultSpec(
    session: SessionRecord | null,
    kind: MessageSpec["kind"],
    body: string,
    actions: MessageSpec["actions"] = [helpAction()]
  ): MessageSpec {
    if (!session) return this.createCommandResultSpec(kind, body, actions);
    return createMessage({
      kind,
      session: this.sessionContext(session),
      body: [{ type: "text", text: body }],
      actions
    });
  }

  sessionContext(session: SessionRecord): NonNullable<MessageSpec["session"]> {
    return {
      id: session.codexThreadId,
      directory: this.getSessionDirectory(session)
    };
  }

  createSelectedSessionSpec(
    session: SessionRecord,
    threadLabel: string,
    actions: MessageSpec["actions"] = []
  ): MessageSpec {
    return createMessage({
      kind: "system",
      titleLabel: "Codex",
      session: this.sessionContext(session),
      body: [{
        type: "text",
        text: `Session ID ${session.codexThreadId}\nThread ${threadLabel}`
      }],
      actions
    });
  }
}
