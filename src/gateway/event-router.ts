import type { NotifyEvent } from "../domain/notify-event";
import type { Notifier } from "../notifiers/notifier";
import { logger } from "../utils/logger";

export type EventRouterOptions = {
  dedupeWindowMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxEvents: number;
};

export class EventRouter {
  private readonly dedupeTimestamps = new Map<string, number>();
  private readonly rateWindowStarts = new Map<string, number>();
  private readonly rateWindowCounts = new Map<string, number>();

  constructor(
    private readonly notifiers: Notifier[],
    private readonly options: EventRouterOptions,
  ) {}

  async route(event: NotifyEvent): Promise<void> {
    if (this.isDeduped(event)) {
      return;
    }
    if (!this.isRateAllowed(event)) {
      logger.warn("event dropped by rate limit", { source: event.source, dedupeKey: event.dedupeKey });
      return;
    }

    await Promise.all(
      this.notifiers.map(async (notifier) => {
        try {
          await notifier.notify(event);
        } catch (error) {
          logger.error("notifier failed", {
            notifier: notifier.id,
            error: String(error),
            source: event.source,
          });
        }
      }),
    );
  }

  private isDeduped(event: NotifyEvent): boolean {
    const now = event.timestamp;
    const last = this.dedupeTimestamps.get(event.dedupeKey);
    this.gcDedupe(now);
    if (typeof last === "number" && now - last <= this.options.dedupeWindowMs) {
      return true;
    }
    this.dedupeTimestamps.set(event.dedupeKey, now);
    return false;
  }

  private isRateAllowed(event: NotifyEvent): boolean {
    const key = event.source;
    const now = event.timestamp;
    const startedAt = this.rateWindowStarts.get(key) ?? now;
    const count = this.rateWindowCounts.get(key) ?? 0;

    if (now - startedAt > this.options.rateLimitWindowMs) {
      this.rateWindowStarts.set(key, now);
      this.rateWindowCounts.set(key, 1);
      return true;
    }

    if (count >= this.options.rateLimitMaxEvents) {
      return false;
    }

    this.rateWindowStarts.set(key, startedAt);
    this.rateWindowCounts.set(key, count + 1);
    return true;
  }

  private gcDedupe(now: number): void {
    for (const [key, ts] of this.dedupeTimestamps.entries()) {
      if (now - ts > this.options.dedupeWindowMs) {
        this.dedupeTimestamps.delete(key);
      }
    }
  }
}
