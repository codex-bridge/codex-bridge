import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { BridgeStore, WebDirectoryRegistration } from "../../store/index.js";

export type DirectoryRegistrationErrorReason = "required" | "not_found" | "not_directory" | "inaccessible";

export class DirectoryRegistrationError extends Error {
  constructor(readonly reason: DirectoryRegistrationErrorReason, message: string) {
    super(message);
  }
}

function expandHome(value: string): string {
  return value === "~" ? homedir() : value.startsWith("~/") ? `${homedir()}${value.slice(1)}` : value;
}

/** Registers navigation metadata only; it never creates a directory, thread, session or active selection. */
export class WebDirectoryRegistry {
  constructor(private readonly store: Pick<BridgeStore, "registerWebDirectory">) {}

  async register(input: string, assertCurrent: () => void): Promise<WebDirectoryRegistration> {
    const trimmed = input.trim();
    if (!trimmed) throw new DirectoryRegistrationError("required", "Directory path is required.");
    const directory = resolve(expandHome(trimmed));
    let stats;
    try {
      stats = await stat(directory);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      throw new DirectoryRegistrationError(code === "ENOENT" ? "not_found" : "inaccessible",
        code === "ENOENT" ? "Directory does not exist." : "Directory is not accessible.");
    }
    if (!stats.isDirectory()) throw new DirectoryRegistrationError("not_directory", "Path is not a directory.");
    try {
      await access(directory, constants.R_OK | constants.X_OK);
    } catch {
      throw new DirectoryRegistrationError("inaccessible", "Directory is not accessible.");
    }
    assertCurrent();
    return this.store.registerWebDirectory(directory);
  }
}
