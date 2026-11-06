import type { KnownBlock } from "@slack/types";

import type { ActionSpec, MessageBodyPart, MessageSpec } from "../bridge/messages/types.js";
import { splitMessageSpecByRenderedLength } from "../bridge/messages/chunks.js";
import { renderLegacyMessage } from "../bridge/messages/legacy-adapter.js";
import { buildSlackButton } from "./buttons.js";
import { slackSurfaceBlockId } from "./surfaces.js";

export const SLACK_MARKDOWN_BLOCK_TEXT_LIMIT = 12_000;
const SLACK_CONTEXT_TEXT_LIMIT = 3_000;

export function renderSlackMessageSpec(
  chatId: string,
  spec: MessageSpec,
  callbackSecret: string | null
): KnownBlock[] {
  const blocks: KnownBlock[] = spec.presentation === "activity" ? renderActivity(spec) : [{
    type: "markdown",
    ...(spec.surface ? { block_id: slackSurfaceBlockId(spec.surface) } : {}),
    text: truncateSlackMarkdown(renderMessageText(spec))
  }];
  blocks.push(...renderActions(chatId, spec.actions, callbackSecret, spec.title));
  return blocks;
}

export function renderSlackMessageSpecChunks(
  spec: MessageSpec,
  maxLength = SLACK_MARKDOWN_BLOCK_TEXT_LIMIT
): MessageSpec[] {
  return splitMessageSpecByRenderedLength(
    spec,
    maxLength,
    (candidate) => candidate.presentation === "activity"
      ? renderLegacyMessage(candidate).length
      : renderMessageText(candidate).length
  );
}

function renderActivity(spec: MessageSpec): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  let text = spec.title;
  const flush = () => {
    if (text) blocks.push(...renderContextText(text));
    text = "";
  };
  for (const part of spec.body) {
    if (part.type === "code") {
      flush();
      // Sections remain editable to context and retain code formatting during file edits.
      // A literal fence in the source cannot be represented safely inside Slack mrkdwn.
      if (part.text.includes("```")) {
        blocks.push(...renderContextText(part.text));
      } else {
        let code = "";
        for (const character of Array.from(part.text)) {
          const escaped = escapeSlackText(character);
          if (code.length + escaped.length > SLACK_CONTEXT_TEXT_LIMIT - 8) {
            blocks.push(codeSection(code));
            code = "";
          }
          code += escaped;
        }
        if (code) blocks.push(codeSection(code));
      }
    } else {
      text += `${text ? "\n" : ""}${part.type === "field" ? `${part.label}: ${part.value}` : part.text}`;
    }
  }
  flush();
  if (spec.surface && blocks[0]) blocks[0].block_id = slackSurfaceBlockId(spec.surface);
  return blocks;
}

function codeSection(code: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text: `\`\`\`\n${code}\n\`\`\``, verbatim: true } };
}

function renderContextText(text: string): KnownBlock[] {
  const characters = Array.from(text);
  const blocks: KnownBlock[] = [];
  for (let offset = 0; offset < characters.length; offset += SLACK_CONTEXT_TEXT_LIMIT) {
    blocks.push({
      type: "context",
      elements: [{
        type: "plain_text",
        text: characters.slice(offset, offset + SLACK_CONTEXT_TEXT_LIMIT).join(""),
        emoji: false
      }]
    });
  }
  return blocks;
}

function renderActions(
  chatId: string,
  actions: ActionSpec[],
  callbackSecret: string | null,
  messageTitle: string
): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  let currentGroup: string | undefined;
  const messageTitleLabel = messageTitle.split(" · ", 1)[0];
  for (let offset = 0; offset < actions.length;) {
    const group = actions[offset]?.group;
    let groupEnd = offset + 1;
    while (groupEnd < actions.length && actions[groupEnd]?.group === group) {
      groupEnd += 1;
    }
    if (group && group !== currentGroup && group !== messageTitleLabel) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${escapeSlackText(group)}*` } });
      currentGroup = group;
    }
    for (let rowStart = offset; rowStart < groupEnd; rowStart += 5) {
      const row = actions.slice(rowStart, Math.min(rowStart + 5, groupEnd));
      blocks.push({
        type: "actions",
        elements: row.map((action, index) => buildSlackButton({
          chatId,
          label: action.label,
          callbackSecret,
          destination: { callback: action.callback },
          actionId: `bridge_callback_${action.id}_${rowStart + index}`,
          ...(action.style === "primary" || action.style === "danger" ? { style: action.style } : {})
        }))
      });
    }
    offset = groupEnd;
  }
  return blocks;
}

function renderBodyPart(part: MessageBodyPart): string {
  switch (part.type) {
    case "text":
      return escapeSlackMarkdown(part.text);
    case "markdown":
      return part.text;
    case "code":
      return renderMarkdownCode(part.text);
    case "field":
      return `**${escapeSlackMarkdown(part.label)}**  ${part.value}`;
    case "heading":
      return `**${escapeSlackMarkdown(part.text)}**`;
  }
}

function renderMessageText(spec: MessageSpec): string {
  const body = spec.body.map(renderBodyPart).filter(Boolean).join("\n");
  const title = `**${escapeSlackMarkdown(spec.title)}**`;
  return body ? `${title}\n${body}` : title;
}

function renderMarkdownCode(text: string): string {
  if (text.includes("\n") || text.includes("`")) {
    const fence = text.includes("```") ? "````" : "```";
    return `${fence}\n${text}\n${fence}`;
  }
  return `\`${text}\``;
}

function escapeSlackMarkdown(text: string): string {
  return text.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&");
}

function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncateSlackMarkdown(text: string): string {
  return text.length <= SLACK_MARKDOWN_BLOCK_TEXT_LIMIT
    ? text
    : `${text.slice(0, SLACK_MARKDOWN_BLOCK_TEXT_LIMIT - 3)}...`;
}
