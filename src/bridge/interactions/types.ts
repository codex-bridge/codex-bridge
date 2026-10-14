import type { MessageSpec } from "../messages/types.js";

export type InteractionContext = {
  platform: "slack" | "telegram";
  conversationId: string;
  surfaceId: string;
  sourceMessageId?: string;
  triggerId?: string;
  sourceSurface?: MessageSpec["surface"];
};

export type InteractionDelivery =
  | { mode: "send"; target: "conversation"; message: MessageSpec }
  | { mode: "edit"; target: "surface"; message: MessageSpec };
