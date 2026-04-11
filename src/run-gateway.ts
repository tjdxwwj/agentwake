import { existsSync } from "node:fs";
import os from "node:os";
import dotenv from "dotenv";
import { homePath } from "./paths";

// Load .env from ~/.agentwake/.env (or cwd/.env as fallback for local dev)
const homeEnv = homePath(".env");
if (existsSync(homeEnv)) {
  dotenv.config({ path: homeEnv, override: true });
} else {
  dotenv.config();
}
import qrcode from "qrcode-terminal";
import { createGateway } from "./bootstrap";
import { loadConfig } from "./config";
import { logger } from "./utils/logger";

function resolveLanHost(): string | undefined {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return undefined;
}

function printAccessQr(host: string, port: number, httpsEnabled: boolean): void {
  const lanHost = host === "0.0.0.0" ? resolveLanHost() : host;
  if (!lanHost) {
    logger.warn("unable to resolve LAN host for QR");
    return;
  }
  const protocol = httpsEnabled ? "https" : "http";
  const url = `${protocol}://${lanHost}:${port}`;
  logger.info("mobile access url", { url });
  qrcode.generate(url, { small: true });
}

export async function runGateway(): Promise<void> {
  const config = loadConfig();
  // 直接打到 stdout，避免用户未设置 LOG_LEVEL 时看不到通知渠道状态
  const desktopOn = config.desktopEnabled;
  console.log(
    `[agentwake] 桌面系统通知: ${desktopOn ? "开启" : "关闭（AGENTWAKE_DESKTOP_ENABLED=0 则不会弹横幅）"}`,
  );
  const gateway = createGateway(config);
  await gateway.start();

  await new Promise<void>((resolve, reject) => {
    gateway.server.listen(config.port, config.host, () => {
      logger.info("agentwake started", {
        host: config.host,
        port: config.port,
        httpsEnabled: config.httpsEnabled,
        cursorHookPath: config.cursorHookPath,
        claudeHookPath: config.claudeHookPath,
        wsPath: config.wsPath,
        adapters: {
          cursor: config.cursorAdapterEnabled,
          claude: config.claudeAdapterEnabled,
          qoder: config.qoderAdapterEnabled,
        },
      });
      if (config.pwaEnabled) {
        printAccessQr(config.host, config.port, config.httpsEnabled);
      }
      resolve();
    });
    gateway.server.on("error", reject);
  });

  const shutdown = async () => {
    logger.info("shutting down");
    await gateway.stop();
    await new Promise<void>((resolve, reject) =>
      gateway.server.close((err) => (err ? reject(err) : resolve())),
    );
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
