import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import path from "node:path";
import express, { type Express } from "express";
import { createClaudeHookAdapter } from "./adapters/claude-hook-adapter";
import { createCursorHookAdapter } from "./adapters/cursor-hook-adapter";
import { createQoderLogAdapter } from "./adapters/qoder-log-adapter";
import type { AppConfig } from "./config";
import type { NotifyEvent } from "./domain/notify-event";
import type { GatewayAdapter } from "./gateway/adapter";
import { AdapterRegistry } from "./gateway/adapter-registry";
import { EventRouter } from "./gateway/event-router";
import { DesktopNotifier } from "./notifiers/desktop-notifier";
import { DingTalkNotifier } from "./notifiers/dingtalk-notifier";
import { FeishuNotifier } from "./notifiers/feishu-notifier";
import { MobileWsNotifier } from "./notifiers/mobile-ws-notifier";
import { WeComNotifier } from "./notifiers/wecom-notifier";
import type { Notifier } from "./notifiers/notifier";

export type BootstrappedGateway = {
  app: Express;
  server: HttpServer | HttpsServer;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type GatewayOverrides = {
  notifiers?: Notifier[];
  adapters?: GatewayAdapter[];
};

export function createGateway(config: AppConfig, overrides?: GatewayOverrides): BootstrappedGateway {
  const app = express();
  const recentEvents: NotifyEvent[] = [];
  const RECENT_EVENTS_MAX = 100;
  const server =
    config.httpsEnabled === true
      ? createHttpsServer(
          {
            cert: readFileSync(path.resolve(config.httpsCertPath)),
            key: readFileSync(path.resolve(config.httpsKeyPath)),
          },
          app,
        )
      : createHttpServer(app);

  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false }));

  const mobileWsNotifier = new MobileWsNotifier();
  const desktopNotifier = new DesktopNotifier();
  const defaultNotifiers: Notifier[] = [];
  if (config.desktopEnabled) {
    defaultNotifiers.push(desktopNotifier);
  }
  if (config.pwaEnabled) {
    defaultNotifiers.push(mobileWsNotifier);
  }
  if (config.dingtalkEnabled && config.dingtalkWebhook) {
    defaultNotifiers.push(
      new DingTalkNotifier({ webhook: config.dingtalkWebhook, secret: config.dingtalkSecret }),
    );
  }
  if (config.feishuEnabled && config.feishuWebhook) {
    defaultNotifiers.push(
      new FeishuNotifier({ webhook: config.feishuWebhook, secret: config.feishuSecret }),
    );
  }
  if (config.wecomEnabled && config.wecomWebhook) {
    defaultNotifiers.push(new WeComNotifier({ webhook: config.wecomWebhook }));
  }
  const router = new EventRouter(overrides?.notifiers ?? defaultNotifiers, {
    dedupeWindowMs: config.dedupeWindowMs,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMaxEvents: config.rateLimitMaxEvents,
  });

  const registry = new AdapterRegistry();
  const adapters =
    overrides?.adapters ??
    [createCursorHookAdapter(), createClaudeHookAdapter(), createQoderLogAdapter()];
  for (const adapter of adapters) {
    registry.register(adapter);
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/runtime", (_req, res) => {
    res.json({
      ok: true,
      wsPath: config.wsPath,
      cursorHookPath: config.cursorHookPath,
      claudeHookPath: config.claudeHookPath,
    });
  });

  app.get("/api/events", (req, res) => {
    const sinceParam = req.query.since;
    const since =
      typeof sinceParam === "string" && sinceParam.trim().length > 0
        ? Number(sinceParam)
        : 0;
    const sinceTimestamp = Number.isFinite(since) ? since : 0;
    const events = recentEvents
      .filter((event) => event.timestamp > sinceTimestamp)
      .sort((a, b) => a.timestamp - b.timestamp);
    res.json({ ok: true, events, now: Date.now() });
  });

  const staticDir = path.resolve(config.webRootPath);
  app.use(
    "/",
    express.static(staticDir, {
      etag: false,
      lastModified: false,
      setHeaders: (res) => {
        // Avoid stale mobile cache while debugging PWA/websocket behavior.
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      },
    }),
  );

  let started = false;
  return {
    app,
    server,
    start: async () => {
      if (started) {
        return;
      }
      if (config.pwaEnabled) {
        mobileWsNotifier.attach(server, config.wsPath);
      }
      await registry.startAll({
        app,
        config,
        emit: (event) => {
          recentEvents.push(event);
          if (recentEvents.length > RECENT_EVENTS_MAX) {
            recentEvents.splice(0, recentEvents.length - RECENT_EVENTS_MAX);
          }
          return router.route(event);
        },
      });
      started = true;
    },
    stop: async () => {
      await registry.stopAll();
      await mobileWsNotifier.close();
    },
  };
}
