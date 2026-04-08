import webPush from "web-push";

export type AppConfig = {
  host: string;
  port: number;
  httpsEnabled: boolean;
  httpsCertPath: string;
  httpsKeyPath: string;
  cursorHookPath: string;
  claudeHookPath: string;
  qoderLogPath: string | undefined;
  dedupeWindowMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxEvents: number;
  webRootPath: string;
  wsPath: string;
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  vapidSubject: string;
  allowedHookIps: string[];
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
  const httpsCertPath = process.env.AGENTWAKE_HTTPS_CERT_PATH ?? "certs/dev-cert.pem";
  const httpsKeyPath = process.env.AGENTWAKE_HTTPS_KEY_PATH ?? "certs/dev-key.pem";
  const cursorHookPath = process.env.AGENTWAKE_CURSOR_HOOK_PATH ?? "/hooks/cursor";
  const claudeHookPath = process.env.AGENTWAKE_CLAUDE_HOOK_PATH ?? "/hooks/claude";
  const qoderLogPath = process.env.AGENTWAKE_QODER_LOG_PATH;
  const dedupeWindowMs = numEnv("AGENTWAKE_DEDUPE_WINDOW_MS", 10_000);
  const rateLimitWindowMs = numEnv("AGENTWAKE_RATE_LIMIT_WINDOW_MS", 10_000);
  const rateLimitMaxEvents = numEnv("AGENTWAKE_RATE_LIMIT_MAX_EVENTS", 40);
  const webRootPath = process.env.AGENTWAKE_WEB_ROOT ?? "web";
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

  return {
    host,
    port,
    httpsEnabled,
    httpsCertPath,
    httpsKeyPath,
    cursorHookPath,
    claudeHookPath,
    qoderLogPath,
    dedupeWindowMs,
    rateLimitWindowMs,
    rateLimitMaxEvents,
    webRootPath,
    wsPath,
    vapidPublicKey,
    vapidPrivateKey,
    vapidSubject,
    allowedHookIps,
  };
}
