import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";

/** Telegram's Rich Markdown treats a table immediately after a paragraph as
 * inline text. Standard GFM accepts it. Add the missing block separator using
 * parsed table locations; never rewrite pipe-looking code or escaped literals.
 */
export function separateTelegramTables(markdown: string): string {
  if (!markdown.includes("|")) return markdown;
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const offsets: number[] = [];
  for (const block of root.children) {
    if (block.type !== "table" || block.position?.start.offset === undefined) continue;
    const start = markdown.lastIndexOf("\n", block.position.start.offset - 1) + 1;
    if (start === 0) continue;
    const previousEnd = markdown[start - 2] === "\r" ? start - 2 : start - 1;
    const previousStart = markdown.lastIndexOf("\n", previousEnd - 1) + 1;
    if (markdown.slice(previousStart, previousEnd).trim()) offsets.push(start);
  }
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  for (const offset of offsets.reverse()) markdown = `${markdown.slice(0, offset)}${newline}${markdown.slice(offset)}`;
  return markdown;
}
