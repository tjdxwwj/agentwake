import { existsSync } from "node:fs";
import os from "node:os";
import dotenv from "dotenv";
import { homePath } from "./paths";

// Load .env from ~/.agentwake/.env (or cwd/.env as fallback for local dev)
const homeEnv = homePath(".env");
if (existsSync(homeEnv)) {
  dotenv.config({ path: homeEnv });
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
      });
      printAccessQr(config.host, config.port, config.httpsEnabled);
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
