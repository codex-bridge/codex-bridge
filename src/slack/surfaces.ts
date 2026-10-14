import type { MessageSpec } from "../bridge/messages/types.js";

const SURFACE_IDS = {
  "session-selector": "bridge_surface_session_selector",
  "session-status": "bridge_surface_session_status",
  "action-result": "bridge_surface_action_result"
} satisfies Record<NonNullable<MessageSpec["surface"]>, string>;

export function slackSurfaceBlockId(surface: NonNullable<MessageSpec["surface"]>): string {
  return SURFACE_IDS[surface];
}

export function readSlackSurface(blocks: Array<{ block_id?: string }> | null | undefined): MessageSpec["surface"] {
  const blockId = blocks?.[0]?.block_id;
  return (Object.keys(SURFACE_IDS) as Array<keyof typeof SURFACE_IDS>)
    .find((surface) => SURFACE_IDS[surface] === blockId);
}
