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
    httpsEnabled: false,
    httpsCertPath: "certs/dev-cert.pem",
    httpsKeyPath: "certs/dev-key.pem",
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
    dingtalkWebhook: undefined,
    dingtalkSecret: undefined,
    feishuWebhook: undefined,
    feishuSecret: undefined,
    wecomWebhook: undefined,
    desktopEnabled: true,
    pwaEnabled: false,
    dingtalkEnabled: false,
    feishuEnabled: false,
    wecomEnabled: false,
    qoderEnabled: true,
    cursorEnabledEvents: ["Notification", "Stop", "StopFailure", "SessionEnd", "SessionStart", "PreToolUse", "PostToolUse"],
    qoderEnabledEvents: ["Notification", "Stop", "StopFailure", "SessionEnd", "SessionStart", "PreToolUse", "PostToolUse"],
    claudeEventTitles: {},
  };
}

describe("hooks integration", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn()));
  });

  it("ignores generic approval payload without cursor hook event fields", async () => {
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

    expect(res.status).toBe(202);
    expect(notifier.events.length).toBe(0);
  });

  it("ignores text-only waiting payload without strict approval fields", async () => {
    const notifier = new CaptureNotifier();
    const gateway = createGateway(createTestConfig(), {
      notifiers: [notifier],
      adapters: [createCursorHookAdapter()],
    });
    await gateway.start();
    cleanup.push(() => gateway.stop());

    const res = await request(gateway.app).post("/hooks/cursor").send({
      message: "waiting for user approval",
      status: "awaiting_user_approval",
    });

    expect(res.status).toBe(202);
    expect(notifier.events.length).toBe(0);
  });

  it("notifies immediately when beforeShellExecution carries explicit approval signal", async () => {
    const notifier = new CaptureNotifier();
    const gateway = createGateway(createTestConfig(), {
      notifiers: [notifier],
      adapters: [createCursorHookAdapter()],
    });
    await gateway.start();
    cleanup.push(() => gateway.stop());

    const acceptedRes = await request(gateway.app).post("/hooks/cursor").send({
      hook_event_name: "beforeShellExecution",
      command: "npm run build",
      cursor_agent: true,
      generation_id: "g-marker-1",
      permission: "ask",
    });
    expect(acceptedRes.status).toBe(200);
    expect(notifier.events.length).toBe(1);
  });

  it("emits qoder event metadata when qoder marker matches", async () => {
    const notifier = new CaptureNotifier();
    const gateway = createGateway(createTestConfig(), {
      notifiers: [notifier],
      adapters: [createCursorHookAdapter()],
    });
    await gateway.start();
    cleanup.push(() => gateway.stop());

    const res = await request(gateway.app).post("/hooks/cursor").send({
      hook_event_name: "beforeShellExecution",
      command: "sleep 20",
      qoder_agent: true,
      agent_marker: "qoder",
      permission: "ask",
      generation_id: "qoder-marker-1",
    });

    expect(res.status).toBe(200);
    expect(notifier.events.length).toBe(1);
    expect(notifier.events[0]?.editor).toBe("qoder");
    expect(notifier.events[0]?.title).toContain("Qoder");
    expect(notifier.events[0]?.dedupeKey.startsWith("qoder:approval:")).toBe(true);
  });

  it("emits stop lifecycle event for successful shell execution", async () => {
    const notifier = new CaptureNotifier();
    const gateway = createGateway(createTestConfig(), {
      notifiers: [notifier],
      adapters: [createCursorHookAdapter()],
    });
    await gateway.start();
    cleanup.push(() => gateway.stop());

    const beforeRes = await request(gateway.app).post("/hooks/cursor").send({
      hook_event_name: "beforeShellExecution",
      command: "npm run build",
      cursor_agent: true,
      generation_id: "g-resolved-1",
      permission: "ask",
    });
    expect(beforeRes.status).toBe(200);

    const afterRes = await request(gateway.app).post("/hooks/cursor").send({
      hook_event_name: "afterShellExecution",
      command: "npm run build",
      cursor_agent: true,
      generation_id: "g-resolved-1",
      exit_code: 0,
    });
    expect(afterRes.status).toBe(200);
    expect(notifier.events.length).toBe(2);
    expect(notifier.events[1]?.title).toContain("任务完成");
    expect(notifier.events[1]?.dedupeKey.startsWith("cursor:lifecycle:Stop:")).toBe(true);
  });

  it("emits lifecycle events on failed afterShellExecution even without matching before signal", async () => {
    const notifier = new CaptureNotifier();
    const gateway = createGateway(createTestConfig(), {
      notifiers: [notifier],
      adapters: [createCursorHookAdapter()],
    });
    await gateway.start();
    cleanup.push(() => gateway.stop());

    const afterRes = await request(gateway.app).post("/hooks/cursor").send({
      hook_event_name: "afterShellExecution",
      command: "npm run lint",
      cursor_agent: true,
      generation_id: "g-after-only-1",
      exit_code: 1,
      duration: 1800,
    });
    expect(afterRes.status).toBe(200);
    expect(notifier.events.length).toBe(1);
    expect(notifier.events[0]?.title).toContain("任务异常终止");
    expect(notifier.events[0]?.dedupeKey.startsWith("cursor:lifecycle:StopFailure:")).toBe(true);
  });

  it("emits session end notification only for SessionEnd hook event", async () => {
    const notifier = new CaptureNotifier();
    const gateway = createGateway(createTestConfig(), {
      notifiers: [notifier],
      adapters: [createCursorHookAdapter()],
    });
    await gateway.start();
    cleanup.push(() => gateway.stop());

    const res = await request(gateway.app).post("/hooks/cursor").send({
      hook_event_name: "SessionEnd",
      conversation_id: "session-end-1",
      message: "session closed",
      status: "done",
      cwd: "/tmp/project",
    });
    expect(res.status).toBe(200);
    expect(notifier.events.length).toBe(1);
    expect(notifier.events[0]?.title).toContain("会话已结束");
    expect(notifier.events[0]?.dedupeKey.startsWith("cursor:lifecycle:SessionEnd:")).toBe(true);
  });
});
