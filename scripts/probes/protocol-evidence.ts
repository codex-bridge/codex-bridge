import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";

export async function scanProductionReferences(root: string, methods: ReadonlySet<string>): Promise<Record<string, string[]>> {
  const references = new Map<string, Set<string>>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.startsWith("protocol-registry") || entry.name.startsWith("protocol-evidence")) continue;
      const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && methods.has(node.text)) {
          const files = references.get(node.text) ?? new Set<string>();
          files.add(relative(root, path).split("\\").join("/"));
          references.set(node.text, files);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  await walk(join(root, "src"));
  return Object.fromEntries([...references].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([method, files]) => [method, [...files].sort()]));
}

export function extractGeneratedMethods(source: string): string[] {
  const file = ts.createSourceFile("protocol.ts", source, ts.ScriptTarget.Latest, true);
  const methods = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isPropertySignature(node) && node.name.getText(file).replaceAll('"', "") === "method" &&
      node.type && ts.isLiteralTypeNode(node.type) && ts.isStringLiteral(node.type.literal)) methods.add(node.type.literal.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...methods].sort();
}

export function extractRuntimeMethods(message: string): string[] {
  const match = message.match(/expected one of (.+)$/s);
  return match ? [...new Set(match[1]!.split(",").map((entry) => entry.trim().replace(/^`|`$/g, "")))].sort() : [];
}
