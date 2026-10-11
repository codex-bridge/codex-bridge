import fs from "node:fs";
import path from "node:path";

type LogLevel = "info" | "warn" | "error";
type ConsoleOutput = "default" | "stderr" | "none";

const logDir = path.resolve("workspaces/logs");
const loggerInstance = process.env.BRIDGE_LOG_INSTANCE?.trim() || "default";
const logFile =
  loggerInstance === "default"
    ? path.join(logDir, "bridge.log")
    : path.join(logDir, `bridge-${loggerInstance}.log`);
const maxLogBytes = 20 * 1024 * 1024;
const maxRotatedFiles = 5;
let consoleOutput: ConsoleOutput = "default";
let fileOutputEnabled = true;

fs.mkdirSync(logDir, { recursive: true });

function rotateIfNeeded(): void {
  try {
    const stats = fs.statSync(logFile);
    if (stats.size < maxLogBytes) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (let index = maxRotatedFiles - 1; index >= 1; index -= 1) {
    const source = `${logFile}.${index}`;
    const target = `${logFile}.${index + 1}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, target);
    }
  }

  if (fs.existsSync(logFile)) {
    fs.renameSync(logFile, `${logFile}.1`);
  }
}

function serialize(details: Record<string, unknown> | undefined): string {
  if (!details || Object.keys(details).length === 0) {
    return "";
  }
  return ` ${JSON.stringify(details)}`;
}

function log(level: LogLevel, event: string, details?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${event}${serialize(details)}`;
  if (fileOutputEnabled) {
    rotateIfNeeded();
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  }
  if (consoleOutput === "none") return;
  if (consoleOutput === "stderr") {
    process.stderr.write(`${line}\n`);
    return;
  }
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export const logger = {
  configureOutput(options: { console?: ConsoleOutput; file?: boolean }): void {
    if (options.console !== undefined) consoleOutput = options.console;
    if (options.file !== undefined) fileOutputEnabled = options.file;
  },
  info(event: string, details?: Record<string, unknown>): void {
    log("info", event, details);
  },
  warn(event: string, details?: Record<string, unknown>): void {
    log("warn", event, details);
  },
  error(event: string, details?: Record<string, unknown>): void {
    log("error", event, details);
  },
  getLogFile(): string {
    return logFile;
  }
};
