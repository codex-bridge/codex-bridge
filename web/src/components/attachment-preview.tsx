import { useEffect, useState } from "react";

export function AttachmentPreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return <span className="attachment-preview">{url && <img src={url} alt="" width="56" height="56" />}</span>;
}
