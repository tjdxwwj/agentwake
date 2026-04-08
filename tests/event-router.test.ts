import { describe, expect, it } from "vitest";
import { createNotifyEvent } from "../src/domain/notify-event";
import { EventRouter } from "../src/gateway/event-router";
import type { Notifier } from "../src/notifiers/notifier";

class MemoryNotifier implements Notifier {
  readonly id = "memory";
  public readonly events: string[] = [];

  async notify(event: { dedupeKey: string }): Promise<void> {
    this.events.push(event.dedupeKey);
  }
}

describe("EventRouter", () => {
  it("dedupes events in window", async () => {
    const notifier = new MemoryNotifier();
    const router = new EventRouter([notifier], {
      dedupeWindowMs: 5_000,
      rateLimitWindowMs: 60_000,
      rateLimitMaxEvents: 100,
    });

    const base = createNotifyEvent({
      source: "hook",
      editor: "cursor",
      level: "warn",
      title: "wait",
      body: "waiting for user approval",
      dedupeKey: "same",
      timestamp: 1000,
    });
    await router.route(base);
    await router.route({ ...base, timestamp: 2000 });

    expect(notifier.events).toEqual(["same"]);
  });

  it("drops events when rate limit exceeded", async () => {
    const notifier = new MemoryNotifier();
    const router = new EventRouter([notifier], {
      dedupeWindowMs: 1,
      rateLimitWindowMs: 1_000,
      rateLimitMaxEvents: 2,
    });

    await router.route(
      createNotifyEvent({
        source: "hook",
        editor: "cursor",
        level: "warn",
        title: "1",
        body: "waiting for user approval",
        dedupeKey: "k1",
        timestamp: 1000,
      }),
    );
    await router.route(
      createNotifyEvent({
        source: "hook",
        editor: "cursor",
        level: "warn",
        title: "2",
        body: "waiting for user approval",
        dedupeKey: "k2",
        timestamp: 1001,
      }),
    );
    await router.route(
      createNotifyEvent({
        source: "hook",
        editor: "cursor",
        level: "warn",
        title: "3",
        body: "waiting for user approval",
        dedupeKey: "k3",
        timestamp: 1002,
      }),
    );

    expect(notifier.events).toEqual(["k1", "k2"]);
  });
});
