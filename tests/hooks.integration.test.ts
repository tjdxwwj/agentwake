import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createCursorHookAdapter } from "../src/adapters/cursor-hook-adapter";
import { createGateway } from "../src/bootstrap";
import type { AppConfig } from "../src/config";
import type { NotifyEvent } from "../src/domain/notify-event";
import type { Notifier } from "../src/notifiers/notifier";

class CaptureNotifier implements Notifier {
  readonly id = "capture";
  events: NotifyEvent[] = [];

  async notify(event: NotifyEvent): Promise<void> {
    this.events.push(event);
  }
}

function createTestConfig(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 3199,
    cursorHookPath: "/hooks/cursor",
    claudeHookPath: "/hooks/claude",
    qoderLogPath: undefined,
    dedupeWindowMs: 1000,
    rateLimitWindowMs: 1000,
    rateLimitMaxEvents: 20,
    webRootPath: "web",
    wsPath: "/ws",
    vapidPublicKey: undefined,
    vapidPrivateKey: undefined,
    vapidSubject: "mailto:test@example.com",
    allowedHookIps: [],
  };
}

describe("hooks integration", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn()));
  });

  it("accepts cursor hook with token and publishes event", async () => {
    const notifier = new CaptureNotifier();
    const gateway = createGateway(createTestConfig(), {
      notifiers: [notifier],
      adapters: [createCursorHookAdapter()],
    });
    await gateway.start();
    cleanup.push(() => gateway.stop());

    const res = await request(gateway.app)
      .post("/hooks/cursor")
      .send({ requiresApproval: true, message: "waiting for user approval" });

    expect(res.status).toBe(200);
    expect(notifier.events.length).toBe(1);
    expect(notifier.events[0]?.editor).toBe("cursor");
  });
});
