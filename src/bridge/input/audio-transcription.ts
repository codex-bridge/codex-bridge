import { readFile } from "node:fs/promises";

export async function transcribeAudioFile(input: {
  apiKey: string | null | undefined;
  fileName: string;
  filePath: string;
  mimeType?: string | null;
  model?: string | null;
}): Promise<string> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for Slack audio transcription.");
  }
  const fileBytes = await readFile(input.filePath);
  const form = new FormData();
  form.set("model", input.model?.trim() || "gpt-4o-mini-transcribe");
  form.set(
    "file",
    new Blob([fileBytes], { type: input.mimeType ?? "application/octet-stream" }),
    input.fileName
  );
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    body: form,
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    method: "POST"
  });
  const body = await response.json().catch(() => null) as { error?: { message?: string }; text?: string } | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `audio transcription failed: HTTP ${response.status}`);
  }
  const text = body?.text?.trim();
  if (!text) {
    throw new Error("audio transcription returned empty text.");
  }
  return text;
}
