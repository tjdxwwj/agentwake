type LogLevel = "info" | "warn" | "error" | "debug";

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveMinLogLevel(): LogLevel {
  const raw = (process.env.AGENTWAKE_LOG_LEVEL || "error").trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "error";
}

const MIN_LOG_LEVEL = resolveMinLogLevel();

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (LOG_PRIORITY[level] < LOG_PRIORITY[MIN_LOG_LEVEL]) {
    return;
  }
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  const writer = level === "error" ? console.error : console.log;
  if (meta && Object.keys(meta).length > 0) {
    writer(prefix, msg, JSON.stringify(meta));
    return;
  }
  writer(prefix, msg);
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
};
