import { memo, useRef } from "react";
import { Button } from "./ui/button";
import { AttachmentPreview } from "./attachment-preview";
import { InfoHint } from "./info-hint";
import { AutoSizeTextarea } from "./ui/auto-size-textarea";
import type { ComposerActions } from "../lib/conversation-actions";
import { WEB_IMAGE_MIME_TYPES } from "../../../src/web/protocol-limits";

export type ComposerProps = {
  actions: ComposerActions;
  selected: string | null;
  draft: string;
  attachments: File[];
  allowed: boolean;
  pending: boolean;
  busy: boolean;
  sending: boolean;
  queueRunning: boolean;
  placeholder: string;
  restriction: string | null;
};

export const Composer = memo(function Composer({ actions, selected, draft, attachments, allowed, pending, busy,
  sending, queueRunning, placeholder, restriction }: ComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); void actions.send(); }}>
    <div className="composer-label"><label htmlFor="message-draft">Message</label>
      <InfoHint label="Sending and image help" text="Text beginning with / is sent normally. Select or paste up to 5 PNG, JPEG, WebP, or GIF images; 10 MiB each and 25 MiB total." /></div>
    <div className="composer-surface">
    <AutoSizeTextarea id="message-draft" value={draft} disabled={!selected} maxLength={6000}
      aria-describedby="message-draft-shortcut"
      onChange={(event) => actions.setDraft(event.target.value)}
      onPaste={(event) => {
        const images = [...event.clipboardData.items].flatMap((item) => {
          if (item.kind !== "file" || !item.type.startsWith("image/")) return [];
          const file = item.getAsFile(); return file ? [file] : [];
        });
        if (!images.length) return;
        event.preventDefault(); actions.addAttachments(images);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault(); void actions.send();
        }
      }} placeholder={placeholder} />
    {!!attachments.length && <ul className="attachment-list" aria-label="Images to send">{attachments.map((file, index) => <li key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>
      <AttachmentPreview file={file} /><span className="attachment-details"><span className="truncate">{file.name}</span>
        <span className="muted">{file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KiB` : `${(file.size / 1024 / 1024).toFixed(1)} MiB`}</span></span>
      <Button type="button" variant="ghost" disabled={busy} aria-label={`Remove image ${file.name}`}
        onClick={() => actions.removeAttachment(index)}>Remove</Button>
    </li>)}</ul>}
    <div className="composer-footer"><div className="composer-guidance">
      {restriction && <p className="muted">{restriction}</p>}
      <p id="message-draft-shortcut" className="composer-shortcut"><kbd>Shift + Enter</kbd> for a new line</p>
      </div>
      <div className="composer-actions">
        <input ref={fileInput} className="attachment-input" type="file" multiple tabIndex={-1}
          accept={WEB_IMAGE_MIME_TYPES.join(",")}
          onChange={(event) => { actions.addAttachments([...(event.target.files ?? [])]); event.target.value = ""; }} />
        <Button type="button" variant="ghost" disabled={!selected || busy}
          onClick={() => fileInput.current?.click()}>Add images</Button>
        {queueRunning && <Button type="button" variant="outline"
          disabled={!allowed || busy || (!draft.trim() && !attachments.length)} onClick={() => { void actions.queueDraft(); }}>Queue</Button>}
        <Button type="submit" disabled={!allowed || pending || busy || (!draft.trim() && !attachments.length)}>{sending ? "Sending…" : "Send"}</Button>
      </div>
    </div>
    </div>
  </form>;
});
