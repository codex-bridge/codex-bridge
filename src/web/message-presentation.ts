import type { ActionSpec, MessageSpec } from "../bridge/messages/types.js";

export type WebActionSpec = Omit<ActionSpec, "callback" | "execution"> & {
  execution: NonNullable<ActionSpec["execution"]>;
};
export type WebMessageSpec = Omit<MessageSpec, "actions"> & { actions: WebActionSpec[] };

function presentWebAction(action: ActionSpec): WebActionSpec | null {
  if (!action.execution) return null;
  return {
    id: action.id,
    label: action.label,
    execution: structuredClone(action.execution),
    ...(action.style ? { style: action.style } : {}),
    ...(action.group ? { group: action.group } : {}),
    ...(action.sameRowAsPrevious ? { sameRowAsPrevious: true } : {})
  };
}

/** Removes platform callbacks and keeps only explicitly typed browser actions. */
export function presentWebMessage(message: MessageSpec): WebMessageSpec {
  return structuredClone({
    ...message,
    actions: message.actions.flatMap((action) => {
      const presented = presentWebAction(action);
      return presented ? [presented] : [];
    })
  });
}
