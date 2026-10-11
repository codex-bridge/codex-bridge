import { transcribeAudioFile } from "./audio-transcription.js";
import type { CodexTurnInputPart } from "../../codex/client.js";
import type { MessageSpec } from "../messages/types.js";

export type IncomingAttachment = {
  kind: "audio" | "file" | "image";
  localPath: string;
  mimeType: string | null;
  name: string;
  sizeBytes: number;
};

export type IncomingPayloadInput = {
  attachments: IncomingAttachment[];
  queue?: boolean;
  telegramChatId: string;
  telegramMessageId: string;
  text: string;
};

export type IncomingPayloadDependencies = {
  openaiApiKey: string | null | undefined;
  transcriptionModel?: string | null;
  createPromptSpec: (kind: "error", text: string) => MessageSpec;
  handleIncomingUserText: (input: {
    inputParts?: CodexTurnInputPart[];
    queue?: boolean;
    telegramChatId: string;
    telegramMessageId: string;
    text: string;
  }) => Promise<{ routed: boolean; prompt?: MessageSpec }>;
};

export class IncomingPayloadService {
  constructor(private readonly deps: IncomingPayloadDependencies) {}

  async handle(input: IncomingPayloadInput): Promise<{ routed: boolean; prompt?: MessageSpec }> {
    const images = input.attachments.filter((attachment) => attachment.kind === "image");
    const audios = input.attachments.filter((attachment) => attachment.kind === "audio");
    const files = input.attachments.filter((attachment) => attachment.kind === "file");
    const transcripts: string[] = [];
    const warnings: string[] = [];

    for (const [index, audio] of audios.entries()) {
      try {
        const transcript = await transcribeAudioFile({
          apiKey: this.deps.openaiApiKey,
          fileName: audio.name,
          filePath: audio.localPath,
          mimeType: audio.mimeType,
          model: this.deps.transcriptionModel
        });
        transcripts.push(`Audio transcript ${index + 1}:\n${transcript}`);
      } catch (error) {
        warnings.push(`Audio ${index + 1} failed to transcribe: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!input.text.trim() && images.length === 0 && files.length === 0 && transcripts.length === 0) {
      const text = warnings.length
        ? `Audio transcription failed.\n${warnings.join("\n")}`
        : "No supported attachment content was available.";
      return {
        routed: false,
        prompt: this.deps.createPromptSpec("error", text)
      };
    }

    const textParts: string[] = [];
    const userText = input.text.trim();
    if (userText) {
      textParts.push(userText);
    } else if (files.length > 0) {
      textParts.push(`Please inspect the attached files: ${files.map((file) => file.name).join(", ")}.`);
    } else if (images.length > 0 && transcripts.length > 0) {
      textParts.push("Please respond using the attached image and audio transcript.");
    } else if (images.length > 0) {
      textParts.push("Please inspect the attached image.");
    } else if (transcripts.length > 0) {
      textParts.push("Please respond to the audio transcript.");
    }
    textParts.push(...transcripts);
    if (warnings.length > 0) {
      textParts.push(`Warnings:\n${warnings.join("\n")}`);
    }
    const text = textParts.join("\n\n");
    const inputParts: CodexTurnInputPart[] = [
      { type: "text", text },
      ...images.map((image): CodexTurnInputPart => ({ type: "localImage", path: image.localPath })),
      ...files.map((file): CodexTurnInputPart => ({ type: "mention", name: file.name, path: file.localPath }))
    ];

    return this.deps.handleIncomingUserText({
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
      text,
      inputParts: images.length > 0 || files.length > 0 ? inputParts : undefined,
      queue: input.queue
    });
  }
}
