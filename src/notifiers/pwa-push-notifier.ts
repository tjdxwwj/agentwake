import type { Express } from "express";
import webPush from "web-push";
import type { NotifyEvent } from "../domain/notify-event";
import type { Notifier } from "./notifier";

type PushSubscriptionLike = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export class PwaPushNotifier implements Notifier {
  readonly id = "pwa-push-notifier";
  private readonly subscriptions = new Map<string, PushSubscriptionLike>();

  constructor(private readonly vapidPublicKey?: string) {}

  mountRoutes(app: Express): void {
    app.get("/api/push/public-key", (_req, res) => {
      if (!this.vapidPublicKey) {
        res.status(404).json({ ok: false, error: "vapid key not configured" });
        return;
      }
      res.json({ ok: true, publicKey: this.vapidPublicKey });
    });

    app.post("/api/push/subscribe", (req, res) => {
      const subscription = req.body?.subscription as PushSubscriptionLike | undefined;
      if (!subscription?.endpoint || !subscription.keys?.auth || !subscription.keys?.p256dh) {
        res.status(400).json({ ok: false, error: "invalid subscription" });
        return;
      }
      this.subscriptions.set(subscription.endpoint, subscription);
      res.json({ ok: true });
    });

    app.post("/api/push/unsubscribe", (req, res) => {
      const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
      if (!endpoint) {
        res.status(400).json({ ok: false, error: "endpoint required" });
        return;
      }
      this.subscriptions.delete(endpoint);
      res.json({ ok: true });
    });
  }

  async notify(event: NotifyEvent): Promise<void> {
    if (this.subscriptions.size === 0 || !this.vapidPublicKey) {
      return;
    }
    const payload = JSON.stringify({
      title: event.title,
      body: event.body,
      event,
    });

    const expired: string[] = [];
    await Promise.all(
      [...this.subscriptions.values()].map(async (subscription) => {
        try {
          await webPush.sendNotification(subscription, payload);
        } catch (error) {
          const code = Number((error as { statusCode?: unknown })?.statusCode ?? 0);
          if (code === 404 || code === 410) {
            expired.push(subscription.endpoint);
          }
        }
      }),
    );

    for (const endpoint of expired) {
      this.subscriptions.delete(endpoint);
    }
  }
}
