import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Scaffold the repository's inline migration registry, without opening a DB.
const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9_]+$/.test(name)) throw new Error("Usage: yarn db:migration:create snake_case_name");
const registryPath = resolve("src/store/migrations.ts");
let source = await readFile(registryPath, "utf8");
const versions = [...source.matchAll(/"(\d{3}_[a-z0-9_]+)"/g)].map(match => match[1]);
if (versions.some(version => version.endsWith(`_${name}`))) throw new Error("Migration already exists");
const number = String(Math.max(...versions.map(version => Number(version.slice(0, 3)))) + 1).padStart(3, "0");
const version = `${number}_${name}`, alias = `migrate${number}`, file = `migration-${version}.ts`;
const typeEnd = source.indexOf(";", source.indexOf("export type SchemaMigrationVersion"));
source = `${source.slice(0, typeEnd)}\n  | "${version}"${source.slice(typeEnd)}`;
const registryEnd = source.indexOf("\n];", source.indexOf("export const SCHEMA_MIGRATIONS"));
source = `${source.slice(0, registryEnd)},\n  "${version}"${source.slice(registryEnd)}`;
const runnersEnd = source.indexOf("\n  ];\n\n  for (const migration");
if (registryEnd < 0 || runnersEnd < 0) throw new Error("Migration registry shape changed; review the generator");
source = `${source.slice(0, runnersEnd)},\n    { version: "${version}", run: () => ${alias}(sqlite) }${source.slice(runnersEnd)}`;
source = `import { migrateGenerated as ${alias} } from "./${file.replace(/\.ts$/, ".js")}";\n${source}`;
await writeFile(resolve("src/store", file), `import type { SqliteDatabase } from "./migrations.js";\n\nexport function migrateGenerated(sqlite: SqliteDatabase): void {\n  void sqlite;\n  throw new Error("Implement ${version} before applying migrations");\n}\n`, { flag: "wx" });
await writeFile(registryPath, source);
console.log(`Created src/store/${file} and registered ${version}`);
