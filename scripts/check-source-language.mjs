import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceRoots = ["src", "web", "scripts", "tests"];
const rootSourceFiles = [
  "drizzle.config.ts",
  "ecosystem.config.cjs",
  "eslint.config.js",
  "tokens.css"
];
const sourceExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".mjs",
  ".ps1",
  ".sh",
  ".svg",
  ".ts",
  ".tsx"
]);
const hanCharacter = /\p{Script=Han}/u;

async function collectSourceFiles(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const childPath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(childPath));
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(childPath);
    }
  }

  return files;
}

const scannedFiles = [
  ...rootSourceFiles,
  ...(await Promise.all(sourceRoots.map(collectSourceFiles))).flat()
].sort();
const findings = [];

for (const relativePath of scannedFiles) {
  const content = await readFile(path.join(projectRoot, relativePath), "utf8");
  for (const [lineIndex, line] of content.split(/\r?\n/u).entries()) {
    const match = hanCharacter.exec(line);
    if (match) {
      findings.push(`${relativePath}:${lineIndex + 1}:${match.index + 1}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Non-English source text found:");
  for (const finding of findings) console.error(`- ${finding}`);
  console.error("Keep implementation source in English. Add a narrowly scoped locale-resource boundary with the future i18n layer.");
  process.exitCode = 1;
} else {
  console.log(`Source language check passed (${scannedFiles.length} files).`);
}
