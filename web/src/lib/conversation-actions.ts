import type { WorkbenchController } from "./workbench";

export type TimelineActions = Pick<WorkbenchController, "actMessage" | "actDecision">;
export type ComposerActions = Pick<WorkbenchController,
  "setDraft" | "addAttachments" | "removeAttachment" | "send" | "queueDraft">;
type ConversationController = TimelineActions & ComposerActions & Pick<WorkbenchController, "cancelQueued">;

/** Bind only the operations each conversation region consumes, without storing state. */
export function createConversationActions(controller: ConversationController): {
  timeline: TimelineActions;
  composer: ComposerActions;
  cancelQueued: ConversationController["cancelQueued"];
} {
  return {
    timeline: {
      actMessage: (action) => controller.actMessage(action),
      actDecision: (id, action, content) => controller.actDecision(id, action, content)
    },
    composer: {
      setDraft: (text) => controller.setDraft(text),
      addAttachments: (files) => controller.addAttachments(files),
      removeAttachment: (index) => controller.removeAttachment(index),
      send: () => controller.send(),
      queueDraft: () => controller.queueDraft()
    },
    cancelQueued: (id) => controller.cancelQueued(id)
  };
}
