import type { NotifyEvent } from "../domain/notify-event";
import type { Notifier } from "./notifier";
import { logger } from "../utils/logger";

interface WeComConfig {
  webhook: string;
}

const LEVEL_EMOJI: Record<string, string> = {
  critical: "🔴",
  error: "🔴",
  warn: "🟡",
  info: "🔵",
};

export class WeComNotifier implements Notifier {
  readonly id = "wecom";

  constructor(private config: WeComConfig) {}

  async notify(event: NotifyEvent): Promise<void> {
    const emoji = LEVEL_EMOJI[event.level] ?? "🔵";
    const body = {
      msgtype: "markdown",
      markdown: {
        content: `${emoji} **${event.title}**\n\n${event.body}\n\n<font color="comment">${event.editor} · ${new Date(event.timestamp).toLocaleString("zh-CN")}</font>`,
      },
    };

    const response = await fetch(this.config.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = (await response.json()) as { errcode: number; errmsg: string };
    if (result.errcode !== 0) {
      logger.error("wecom send failed", { errcode: result.errcode, errmsg: result.errmsg });
      throw new Error(result.errmsg);
    }
    logger.info("wecom notification sent", { title: event.title });
  }
}
