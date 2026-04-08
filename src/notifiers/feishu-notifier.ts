import { createHmac } from "node:crypto";
import type { NotifyEvent } from "../domain/notify-event";
import type { Notifier } from "./notifier";
import { logger } from "../utils/logger";

interface FeishuConfig {
  webhook: string;
  secret?: string | undefined;
}

const LEVEL_COLOR: Record<string, string> = {
  critical: "red",
  error: "red",
  warn: "orange",
  info: "blue",
};

export class FeishuNotifier implements Notifier {
  readonly id = "feishu";

  constructor(private config: FeishuConfig) {}

  async notify(event: NotifyEvent): Promise<void> {
    const body: Record<string, unknown> = {
      msg_type: "interactive",
      card: {
        header: {
          title: {
            tag: "plain_text",
            content: event.title,
          },
          template: LEVEL_COLOR[event.level] ?? "blue",
        },
        elements: [
          {
            tag: "markdown",
            content: `${event.body}\n\n---\n*${event.editor} · ${new Date(event.timestamp).toLocaleString("zh-CN")}*`,
          },
        ],
      },
    };

    if (this.config.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const stringToSign = `${timestamp}\n${this.config.secret}`;
      const sign = createHmac("sha256", stringToSign)
        .update("")
        .digest("base64");
      body.timestamp = timestamp;
      body.sign = sign;
    }

    const response = await fetch(this.config.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = (await response.json()) as { code: number; msg: string };
    if (result.code !== 0) {
      logger.error("feishu send failed", { code: result.code, msg: result.msg });
      throw new Error(result.msg);
    }
    logger.info("feishu notification sent", { title: event.title });
  }
}
