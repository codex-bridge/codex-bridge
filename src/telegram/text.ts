
export type TelegramTextChunk = {
  plain: string;
  html?: string;
};

// COMPATIBILITY(MESSAGE_FACTORY): legacy Telegram text formatting for callers without MessageSpec.
export function formatTelegramHtml(text: string): string {
  const codeValueKeys = new Set([
    "Active turn",
    "Command",
    "Codex home",
    "Directory",
    "Session",
    "Target",
    "User agent",
    "Version"
  ]);

  return text.split("\n").map((line) => {
    if (!line) {
      return "";
    }

    if (line === "Codex" || /^(Actions|Called|Codex|Codex error|Codex stream error|Compact completed|Compact started|Edited|MCP result|System|User|Working) · /.test(line)) {
      return `<b>${escapeTelegramHtml(line)}</b>`;
    }

    const boldLine = line.match(/^\*\*([^*\n]{1,64})\*\*$/);
    if (boldLine) {
      return `<b>${escapeTelegramHtml(boldLine[1] ?? "")}</b>`;
    }

    const codeLine = line.match(/^`([^`\n]+)`$/);
    if (codeLine) {
      return `<code>${escapeTelegramHtml(codeLine[1] ?? "")}</code>`;
    }

    const boldKeyValue = line.match(/^\*\*([^*\n]{1,32})\*\*\s+(.*)$/);
    if (boldKeyValue) {
      const key = boldKeyValue[1] ?? "";
      const value = boldKeyValue[2] ?? "";
      const safeKey = escapeTelegramHtml(key);
      const safeValue = escapeTelegramHtml(value);
      const formattedValue = codeValueKeys.has(key) ? `<code>${safeValue}</code>` : safeValue;
      return `<b>${safeKey}</b> ${formattedValue}`;
    }

    const keyValue = line.match(/^([A-Za-z][A-Za-z0-9 /_-]{1,32}):\s(.*)$/);
    if (keyValue) {
      const key = keyValue[1] ?? "";
      const value = keyValue[2] ?? "";
      const safeKey = escapeTelegramHtml(key);
      const safeValue = escapeTelegramHtml(value);
      const formattedValue = codeValueKeys.has(key) ? `<code>${safeValue}</code>` : safeValue;
      return `${safeKey}: ${formattedValue}`;
    }

    const safeLine = escapeTelegramHtml(line);
    return safeLine;
  }).join("\n");
}

export function formatCodexTelegramHtml(
  text: string,
  maxLength: number
): TelegramTextChunk[] | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }

  const blocks = parseCodexMarkdownBlocks(normalized);
  const chunks: TelegramTextChunk[] = [];
  let currentPlain = "";
  let currentHtml = "";

  const flush = () => {
    if (!currentPlain.trim()) {
      currentPlain = "";
      currentHtml = "";
      return;
    }
    chunks.push({
      plain: currentPlain.trim(),
      html: currentHtml.trim()
    });
    currentPlain = "";
    currentHtml = "";
  };

  for (const block of blocks) {
    const plain = block.plain.trim();
    const html = block.html.trim();
    if (!plain || !html) {
      continue;
    }
    if (plain.length > maxLength) {
      flush();
      if (block.kind === "code") {
        chunks.push(...splitTelegramText(plain, maxLength).map((chunk) => ({ plain: chunk })));
      } else {
        for (const chunk of splitTelegramText(plain, maxLength)) {
          chunks.push({
            plain: chunk,
            html: formatCodexTextBlockHtml(chunk)
          });
        }
      }
      continue;
    }

    const nextPlain = currentPlain ? `${currentPlain}\n\n${plain}` : plain;
    const nextHtml = currentHtml ? `${currentHtml}\n\n${html}` : html;
    if (nextPlain.length > maxLength) {
      flush();
      currentPlain = plain;
      currentHtml = html;
    } else {
      currentPlain = nextPlain;
      currentHtml = nextHtml;
    }
  }
  flush();

  if (chunks.length === 0) {
    return null;
  }

  const plainLength = chunks.reduce((total, chunk) => total + chunk.plain.length, 0);
  const htmlLength = chunks.reduce((total, chunk) => total + (chunk.html?.length ?? chunk.plain.length), 0);
  if (htmlLength > Math.max(plainLength * 1.3, plainLength + 512)) {
    return null;
  }

  return chunks;
}

export function splitTelegramText(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function escapeTelegramHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseCodexMarkdownBlocks(text: string): Array<{
  html: string;
  kind: "code" | "text";
  plain: string;
}> {
  const blocks: Array<{ html: string; kind: "code" | "text"; plain: string }> = [];
  const lines = text.split("\n");
  let textLines: string[] = [];
  let codeLines: string[] | null = null;
  let codeFenceLine = "```";

  const flushText = () => {
    const plain = textLines.join("\n").trim();
    if (plain) {
      blocks.push({
        kind: "text",
        plain,
        html: formatCodexTextBlockHtml(plain)
      });
    }
    textLines = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (codeLines) {
        const code = codeLines.join("\n").trim();
        if (code) {
          blocks.push({
            kind: "code",
            plain: [codeFenceLine, code, "```"].join("\n"),
            html: `<pre>${escapeTelegramHtml(code)}</pre>`
          });
        }
        codeLines = null;
        codeFenceLine = "```";
      } else {
        flushText();
        codeLines = [];
        codeFenceLine = line.trim();
      }
      continue;
    }

    if (codeLines) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }

  if (codeLines) {
    textLines.push(codeFenceLine, ...codeLines);
  }
  flushText();
  return blocks;
}

function formatCodexTextBlockHtml(text: string): string {
  const lines = text.split("\n");
  const formattedLines: string[] = [];
  let index = 0;

  while (index < lines.length) {

    const line = lines[index] ?? "";
    const heading = line.match(/^\s{0,3}#{1,3}\s+(.+)$/);
    if (heading) {
      formattedLines.push(`<b>${formatCodexInlineHtml(heading[1] ?? "")}</b>`);
      index += 1;
      continue;
    }
    const safeLine = formatCodexInlineHtml(line);
    formattedLines.push(index === 0 && /^Codex\s·\s/.test(line) ? `<b>${safeLine}</b>` : safeLine);
    index += 1;
  }

  return formattedLines.join("\n");
}

function formatCodexInlineHtml(text: string): string {
  const parts = text.split("`");
  if (parts.length < 3 || parts.length % 2 === 0) {
    return formatCodexBoldHtml(text);
  }

  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return `<code>${escapeTelegramHtml(part)}</code>`;
    }
    return formatCodexBoldHtml(part);
  }).join("");
}

function formatCodexBoldHtml(text: string): string {
  const parts = text.split(/(\*\*[^*\n]+?\*\*)/g);
  return parts.map((part) => {
    const bold = part.match(/^\*\*([^*\n]+?)\*\*$/);
    if (bold) {
      return `<b>${escapeTelegramHtml(bold[1] ?? "")}</b>`;
    }
    return escapeTelegramHtml(part);
  }).join("");
}
