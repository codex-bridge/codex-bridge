import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

type MarkdownBlock = ReturnType<typeof fromMarkdown>["children"][number];

/** Plain-text projection of Markdown; source content is never rewritten. */
export function markdownToText(markdown: string): string {
  function blockText(node: MarkdownBlock): string {
    if (node.type === "list" || node.type === "listItem" || node.type === "blockquote") {
      return node.children.map(blockText).join("\n");
    }
    return toString(node);
  }
  return fromMarkdown(markdown).children.map(blockText).join("\n");
}
