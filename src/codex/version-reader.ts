import { execFile } from "node:child_process";

export type VersionCommandRunner = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: VersionCommandRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});

export function parseCodexVersion(output: string): string | null {
  for (const token of output.trim().split(/\s+/)) {
    if (/^\d+\.\d+\.\d+$/.test(token)) {
      return token;
    }
  }
  return null;
}

export function compareCodexVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function readCodexVersion(
  command: string,
  runner: VersionCommandRunner = defaultRunner
): Promise<string | null> {
  const result = await runner(command, ["--version"]);
  return parseCodexVersion(`${result.stdout}\n${result.stderr}`);
}
