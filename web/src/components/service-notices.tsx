import type { MessageSpec } from "../lib/protocol";
import { MessageView } from "./message-view";

export function ServiceNotices({ notices }: { notices: readonly MessageSpec[] }) {
  if (!notices.length) return null;
  return <details className="service-notices">
    <summary>Service notices · {notices.length}</summary>
    <div aria-label="Service notices">{notices.map((message, index) =>
      <MessageView key={index} item={{ id: `service-notice-${index}`, origin: "live", message }} />)}</div>
  </details>;
}
