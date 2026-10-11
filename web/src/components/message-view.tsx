import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { messageAppearance } from "../lib/message-appearance";
import type { TimelineItem } from "../lib/timeline";

const deliveryLabels = { sending: "Sending", accepted: null, unknown: "Delivery status unknown; check the conversation", refused: "Not accepted; draft preserved" };
export function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span>[Image: {alt ?? ""}]</span>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>
  }}>{text}</ReactMarkdown>;
}
export function MessageView({ item, children }: { item: TimelineItem; children?: React.ReactNode }) {
  const { message } = item;
  const { appearance, tone } = messageAppearance(message);
  const delivery = item.deliveryStatus ? deliveryLabels[item.deliveryStatus] : null;
  const showHeading = message.kind !== "user" || !!delivery;
  return <article className={`message message-${message.kind} message-role-${appearance}`} data-message-id={item.id} data-tone={tone}>
    {message.kind !== "actions" && <>{showHeading && <header className="message-heading">
      {message.kind !== "user" && <h3>{message.title}</h3>}
      {delivery && <span className="message-meta">{delivery}</span>}
    </header>}
    <div className="message-body">{message.body.map((part, index) => {
      switch (part.type) {
        case "markdown": return <Markdown key={index} text={part.text} />;
        case "text": return <p className="plain-text" key={index}>{part.text}</p>;
        case "code": return <pre key={index}><code>{part.text}</code></pre>;
        case "field": return <dl key={index}><dt>{part.label}</dt><dd>{part.value}</dd></dl>;
        case "heading": return <h4 key={index}>{part.text}</h4>;
      }
    })}</div></>}
    {children}
  </article>;
}
