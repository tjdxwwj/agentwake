import { createHmac } from "node:crypto";
import type { NotifyEvent } from "../domain/notify-event";
import type { Notifier } from "./notifier";
import { logger } from "../utils/logger";

interface DingTalkConfig {
  webhook: string;
  secret?: string | undefined;
}

const LEVEL_EMOJI: Record<string, string> = {
  critical: "🔴",
  error: "🔴",
  warn: "🟡",
  info: "🔵",
};

export class DingTalkNotifier implements Notifier {
  readonly id = "dingtalk";

  constructor(private config: DingTalkConfig) {}

  async notify(event: NotifyEvent): Promise<void> {
    const url = this.buildUrl();
    const emoji = LEVEL_EMOJI[event.level] ?? "🔵";
    const body = {
      msgtype: "markdown",
      markdown: {
        title: event.title,
        text: `${emoji} **${event.title}**\n\n${event.body}\n\n---\n\n*${event.editor} · ${new Date(event.timestamp).toLocaleString("zh-CN")}*`,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = (await response.json()) as { errcode: number; errmsg: string };
    if (result.errcode !== 0) {
      logger.error("dingtalk send failed", { errcode: result.errcode, errmsg: result.errmsg });
      throw new Error(result.errmsg);
    }
    logger.info("dingtalk notification sent", { title: event.title });
  }

  private buildUrl(): string {
    if (!this.config.secret) return this.config.webhook;

    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${this.config.secret}`;
    const hmac = createHmac("sha256", this.config.secret);
    hmac.update(stringToSign);
    const sign = encodeURIComponent(hmac.digest("base64"));

    return `${this.config.webhook}&timestamp=${timestamp}&sign=${sign}`;
  }
}
