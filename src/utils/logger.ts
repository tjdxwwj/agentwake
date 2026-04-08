type LogLevel = "info" | "warn" | "error" | "debug";

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (meta && Object.keys(meta).length > 0) {
    console.log(prefix, msg, JSON.stringify(meta));
    return;
  }
  console.log(prefix, msg);
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
};
