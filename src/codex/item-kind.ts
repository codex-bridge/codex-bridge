// Protocol item types and explicitly supported legacy aliases. Unknown values never imply mutation.
const ITEM_KINDS = {
  commandexecution: "command",
  command: "command",
  filechange: "fileChange",
  patch: "fileChange",
  edit: "fileChange",
  applypatch: "fileChange",
  mcptoolcall: "mcp",
  mcp: "mcp",
  toolcall: "tool",
  functioncall: "tool",
  websearch: "webSearch",
  imagegeneration: "image",
  image: "image",
  contextcompaction: "contextCompaction",
  reasoning: "reasoning",
  agentmessage: "agentMessage"
} as const;

export type ItemKind = (typeof ITEM_KINDS)[keyof typeof ITEM_KINDS] | "unknown";

export function classifyItemKind(type: unknown): ItemKind {
  if (typeof type !== "string") return "unknown";
  return ITEM_KINDS[type.toLowerCase() as keyof typeof ITEM_KINDS] ?? "unknown";
}
