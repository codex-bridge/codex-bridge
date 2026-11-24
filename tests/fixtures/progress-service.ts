import { ProgressService } from "../../src/bridge/progress/service.js";
import type { BridgeStore } from "../../src/store/index.js";
import type { MessageSpec } from "../../src/bridge/messages/types.js";
import { renderLegacyMessage } from "../../src/bridge/messages/legacy-adapter.js";

/** Real progress aggregation and persistence, with only the transport replaced. */
export function fixtureProgressService(store: BridgeStore, deliver: (id: string, spec: MessageSpec, edit: boolean) => void,
  shouldSkipCalledProgress = () => false) {
  let next = 0;
  return new ProgressService({
    getActiveTurnRoute: thread => store.getActiveTurnRoute(thread),
    getProgressPhaseMessageForItem: (thread, turn, id) => store.getProgressPhaseMessageForItem(thread, turn, id),
    getSessionDirectory: s => s.pathKey, getInFlightTurnId: () => null, shouldSkipCalledProgress,
    getProgressPhaseMessage: id => store.getProgressPhaseMessage(id),
    getActiveProgressPhaseMessage: (thread, turn) => store.getActiveProgressPhaseMessage(thread, turn),
    getLatestProgressPhaseMessage: (thread, turn) => store.getLatestProgressPhaseMessage(thread, turn),
    getProgressPhaseMessageForFileEdit: (thread, turn, id) => store.getProgressPhaseMessageForFileEdit(thread, turn, id),
    getProgressPhaseMessageForActivity: (thread, turn, id) => store.getProgressPhaseMessageForActivity(thread, turn, id),
    updateFinalProgressPhaseAggregate: (id, aggregate) => store.updateFinalProgressPhaseAggregate(id, aggregate),
    listActiveProgressPhaseMessages: () => store.listActiveProgressPhaseMessages(),
    listPendingProgressPhaseFinalDelivery: () => store.listPendingProgressPhaseFinalDelivery(),
    createProgressPhaseMessage: input => store.createProgressPhaseMessage(input),
    updateActiveProgressPhaseMessage: (id, input) => store.updateActiveProgressPhaseMessage(id, input),
    recordSuccessfulRunContentUpdate: id => store.recordSuccessfulRunContentUpdate(id),
    finalizeProgressPhaseMessage: input => store.finalizeProgressPhaseMessage(input),
    updateFinalProgressPhaseMessageState: input => store.updateFinalProgressPhaseMessageState(input),
    markProgressPhaseMessageDeliveryState: input => store.markProgressPhaseMessageDeliveryState(input),
    editMessageSpec: async (_source, id, spec) => { deliver(id, spec, true); return true; },
    sendTemporaryMessageSpec: async (_source, spec) => { const id = `activity-${next++}`; deliver(id, spec, false);
      return { messageId: id, text: renderLegacyMessage(spec) }; }
  });
}
