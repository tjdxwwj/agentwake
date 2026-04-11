import path from "node:path";
import webPush from "web-push";
import { homePath, PKG_ROOT } from "./paths";

/** Cursor 终端转发与 Qoder 日志监听共用的事件名默认集（任务完成 Stop 与异常 StopFailure 均默认开启）。 */
const DEFAULT_EDITOR_HOOK_EVENTS = [
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
] as const;

export type AppConfig = {
  host: string;
  port: number;
  httpsEnabled: boolean;
  httpsCertPath: string;
  httpsKeyPath: string;
  cursorHookPath: string;
  claudeHookPath: string;
  qoderLogPath: string | undefined;
  /** Hook/event names enabled for Cursor terminal forwarder. */
  cursorEnabledEvents: string[];
  /** Hook/event names enabled for Qoder log adapter. */
  qoderEnabledEvents: string[];
  /** Whether to register Cursor hook adapter. */
  cursorAdapterEnabled: boolean;
  /** Whether to register Claude hook adapter. */
  claudeAdapterEnabled: boolean;
  /** Whether to register Qoder log adapter. */
  qoderAdapterEnabled: boolean;
  dedupeWindowMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxEvents: number;
  webRootPath: string;
  wsPath: string;
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  vapidSubject: string;
  allowedHookIps: string[];
  dingtalkWebhook: string | undefined;
  dingtalkSecret: string | undefined;
  feishuWebhook: string | undefined;
  feishuSecret: string | undefined;
  wecomWebhook: string | undefined;
  desktopEnabled: boolean;
  pwaEnabled: boolean;
  dingtalkEnabled: boolean;
  feishuEnabled: boolean;
  wecomEnabled: boolean;
  /** Custom notification titles keyed by hook_event_name (e.g. Stop, Notification). */
  claudeEventTitles: Record<string, string>;
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function loadConfig(): AppConfig {
  const host = process.env.AGENTWAKE_HOST ?? "0.0.0.0";
  const port = numEnv("AGENTWAKE_PORT", 3199);
  const httpsEnabled = (process.env.AGENTWAKE_HTTPS_ENABLED || "0") === "1";
  const httpsCertPath = process.env.AGENTWAKE_HTTPS_CERT_PATH ?? homePath("certs", "dev-cert.pem");
  const httpsKeyPath = process.env.AGENTWAKE_HTTPS_KEY_PATH ?? homePath("certs", "dev-key.pem");
  const cursorHookPath = process.env.AGENTWAKE_CURSOR_HOOK_PATH ?? "/hooks/cursor";
  const claudeHookPath = process.env.AGENTWAKE_CLAUDE_HOOK_PATH ?? "/hooks/claude";
  const qoderLogPath = process.env.AGENTWAKE_QODER_LOG_PATH;
  const dedupeWindowMs = numEnv("AGENTWAKE_DEDUPE_WINDOW_MS", 10_000);
  const rateLimitWindowMs = numEnv("AGENTWAKE_RATE_LIMIT_WINDOW_MS", 10_000);
  const rateLimitMaxEvents = numEnv("AGENTWAKE_RATE_LIMIT_MAX_EVENTS", 40);
  const webRootPath = process.env.AGENTWAKE_WEB_ROOT ?? path.join(PKG_ROOT, "web");
  const wsPath = process.env.AGENTWAKE_WS_PATH ?? "/ws";
  const vapidPublicKey = process.env.AGENTWAKE_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.AGENTWAKE_VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.AGENTWAKE_VAPID_SUBJECT ?? "mailto:agentwake@example.com";
  const allowedHookIps = (process.env.AGENTWAKE_ALLOWED_HOOK_IPS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (vapidPublicKey && vapidPrivateKey) {
    webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  }

  const dingtalkWebhook = process.env.AGENTWAKE_DINGTALK_WEBHOOK;
  const dingtalkSecret = process.env.AGENTWAKE_DINGTALK_SECRET;
  const feishuWebhook = process.env.AGENTWAKE_FEISHU_WEBHOOK;
  const feishuSecret = process.env.AGENTWAKE_FEISHU_SECRET;
  const wecomWebhook = process.env.AGENTWAKE_WECOM_WEBHOOK;

  const boolEnv = (name: string, fallback: boolean): boolean => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    return raw === "1" || raw.toLowerCase() === "true";
  };
  const desktopEnabled = boolEnv("AGENTWAKE_DESKTOP_ENABLED", true);
  const pwaEnabled = boolEnv("AGENTWAKE_PWA_ENABLED", false);
  const dingtalkEnabled = boolEnv("AGENTWAKE_DINGTALK_ENABLED", true);
  const feishuEnabled = boolEnv("AGENTWAKE_FEISHU_ENABLED", true);
  const wecomEnabled = boolEnv("AGENTWAKE_WECOM_ENABLED", true);
  const cursorAdapterEnabled = boolEnv("AGENTWAKE_CURSOR_ENABLED", true);
  const claudeAdapterEnabled = boolEnv("AGENTWAKE_CLAUDE_ENABLED", true);
  const qoderAdapterEnabled = boolEnv("AGENTWAKE_QODER_ENABLED", true);

  const claudeEventTitles: Record<string, string> = {};
  const titlePrefix = "AGENTWAKE_CLAUDE_TITLE_";
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith(titlePrefix) && val) {
      // e.g. AGENTWAKE_CLAUDE_TITLE_STOP → "Stop"
      const eventName = key.slice(titlePrefix.length);
      // Convert UPPER_CASE env key to PascalCase hook name
      const hookName = eventName
        .toLowerCase()
        .replace(/(^|_)([a-z])/g, (_m, _sep, c: string) => c.toUpperCase());
      claudeEventTitles[hookName] = val;
    }
  }

  return {
    host,
    port,
    httpsEnabled,
    httpsCertPath,
    httpsKeyPath,
    cursorHookPath,
    claudeHookPath,
    qoderLogPath,
    cursorEnabledEvents: [...DEFAULT_EDITOR_HOOK_EVENTS],
    qoderEnabledEvents: [...DEFAULT_EDITOR_HOOK_EVENTS],
    cursorAdapterEnabled,
    claudeAdapterEnabled,
    qoderAdapterEnabled,
    dedupeWindowMs,
    rateLimitWindowMs,
    rateLimitMaxEvents,
    webRootPath,
    wsPath,
    vapidPublicKey,
    vapidPrivateKey,
    vapidSubject,
    allowedHookIps,
    dingtalkWebhook,
    dingtalkSecret,
    feishuWebhook,
    feishuSecret,
    wecomWebhook,
    desktopEnabled,
    pwaEnabled,
    dingtalkEnabled,
    feishuEnabled,
    wecomEnabled,
    claudeEventTitles,
  };
}
