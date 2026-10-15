import { Fragment, memo, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { ConversationNotice, ConversationNoticeArea } from "./conversation-notice";
import { DecisionCard } from "./decision-card";
import { MessageActions } from "./message-actions";
import { MessageView } from "./message-view";
import { historyBoundaryIndex, type TimelineItem } from "../lib/timeline";
import type { SessionEntry } from "../lib/protocol";
import type { TimelineActions } from "../lib/conversation-actions";
import type { WorkbenchFeedback } from "../lib/workbench";

export type ConversationTimelineProps = {
  actions: TimelineActions;
  selected: string | null;
  entry?: SessionEntry;
  items: TimelineItem[];
  feedback: WorkbenchFeedback | null;
  loading: boolean;
  catalogFresh: boolean;
  allowed: boolean;
  pending: boolean;
  busy: boolean;
  emptyTitle: string | null;
  emptyDescription: string | null;
};

export const ConversationTimeline = memo(function ConversationTimeline({ actions, selected, entry, items,
  feedback, loading, catalogFresh, allowed, pending, busy, emptyTitle, emptyDescription }: ConversationTimelineProps) {
  const [unread, setUnread] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const historyEndsAt = historyBoundaryIndex(items);

  useEffect(() => {
    if (atBottom.current) { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); setUnread(false); }
    else setUnread(true);
  }, [items]);
  useEffect(() => { atBottom.current = true; setUnread(false); }, [selected]);

  return <>
    <ConversationNoticeArea>
      {feedback && <ConversationNotice variant="status" tone={feedback.tone}
        alert={feedback.tone === "error"}>{feedback.message}</ConversationNotice>}
      {loading && <ConversationNotice>Loading the 5 most recent messages and open approvals…</ConversationNotice>}
      {selected && !entry && !feedback && <ConversationNotice>{catalogFresh
        ? "The target session is missing or unavailable. Its address is preserved; refresh the list or select another session."
        : "The target session is preserved. Connect to the service so Bridge can confirm its availability."}</ConversationNotice>}
      {!items.length && (emptyTitle || emptyDescription) && <ConversationNotice title={emptyTitle ?? undefined}>
        {emptyDescription}
      </ConversationNotice>}
    </ConversationNoticeArea>
    <div className="timeline" ref={scroll} onScroll={() => {
      const element = scroll.current;
      atBottom.current = !!element && element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      if (atBottom.current) setUnread(false);
    }}>
      <div className="messages">{items.map((item, index) => <Fragment key={item.id}><MessageView item={item}>
        <MessageActions actions={item.message.actions} enabled={allowed && !pending && item.origin !== "cache"} busy={busy}
          onAction={(action) => { void actions.actMessage(action); }} />
        {item.message.decision && <DecisionCard message={item.message} current={item.openDecision !== false}
          enabled={allowed && item.origin !== "cache"} busy={busy}
          onAction={actions.actDecision} />}
      </MessageView>{index === historyEndsAt && <div className="history-boundary" role="separator">
        <span>Messages above are history</span>
      </div>}</Fragment>)}</div>
    </div>
    {unread && <div className="latest"><Button variant="outline" onClick={() => {
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); atBottom.current = true; setUnread(false);
    }}>View new messages</Button></div>}
  </>;
});
