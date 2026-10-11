import { InlineKeyboard } from "grammy";

import type { MessageBodyPart, MessageSpec } from "../bridge/messages/types.js";
import { splitMessageSpecByRenderedLength } from "../bridge/messages/chunks.js";
import { formatCodexTelegramHtml, formatTelegramHtml } from "./text.js";

export const TELEGRAM_RICH_MESSAGE_TEXT_LIMIT = 32_768;

export function renderTelegramMessageSpec(spec: MessageSpec): {
  markdown: string;
  html: string;
  keyboard?: InlineKeyboard;
} {
  const markdown = [
    `<p><b>${escapeTelegramHtml(spec.title)}</b></p>`,
    ...spec.body.map(renderRichMarkdownBodyPart)
  ].filter(Boolean).join("\n\n");
  const html = [
    `<b>${escapeTelegramHtml(spec.title)}</b>`,
    ...spec.body.map(renderHtmlBodyPart)
  ].filter(Boolean).join("\n");
  const keyboard = spec.actions.length > 0 ? new InlineKeyboard() : undefined;
  for (const [index, action] of spec.actions.entries()) {
    if (index > 0 && !action.sameRowAsPrevious) keyboard?.row();
    keyboard?.text(action.label, action.callback);
  }
  return {
    markdown,
    html,
    ...(keyboard ? { keyboard } : {})
  };
}

export function renderTelegramMessageSpecChunks(
  spec: MessageSpec,
  maxLength = TELEGRAM_RICH_MESSAGE_TEXT_LIMIT
): Array<{ spec: MessageSpec; markdown: string; html: string }> {
  return splitMessageSpecByRenderedLength(
    spec,
    maxLength,
    (candidate) => {
      const rendered = renderTelegramMessageSpec(candidate);
      return Math.max(rendered.markdown.length, rendered.html.length);
    }
  ).map((chunkSpec) => {
    const rendered = renderTelegramMessageSpec(chunkSpec);
    return {
      spec: chunkSpec,
      markdown: rendered.markdown,
      html: rendered.html
    };
  });
}

function renderRichMarkdownBodyPart(part: MessageBodyPart): string {
  switch (part.type) {
    case "text":
      return `<p>${renderRichHtmlText(part.text)}</p>`;
    case "markdown":
      return part.text;
    case "code":
      return part.text.includes("\n")
        ? `<pre><code>${escapeTelegramHtml(part.text)}</code></pre>`
        : `<p><code>${escapeTelegramHtml(part.text)}</code></p>`;
    case "field":
      return `<p><b>${escapeTelegramHtml(part.label)}</b> ${renderRichHtmlText(part.value)}</p>`;
    case "heading":
      return `<h3>${escapeTelegramHtml(part.text)}</h3>`;
  }
}

function renderHtmlBodyPart(part: MessageBodyPart): string {
  switch (part.type) {
    case "text":
      return escapeTelegramHtml(part.text);
    case "markdown":
      return renderMarkdown(part.text);
    case "code":
      return `<code>${escapeTelegramHtml(part.text)}</code>`;
    case "field":
      return `<b>${escapeTelegramHtml(part.label)}</b> ${escapeTelegramHtml(part.value)}`;
    case "heading":
      return `<b>${escapeTelegramHtml(part.text)}</b>`;
  }
}

function renderRichHtmlText(text: string): string {
  return escapeTelegramHtml(text).replaceAll("\n", "<br>");
}

function renderMarkdown(text: string): string {
  const chunks = formatCodexTelegramHtml(text, 3_500);
  if (chunks?.length === 1) return chunks[0]?.html ?? escapeTelegramHtml(text);
  return formatTelegramHtml(text);
}

function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
