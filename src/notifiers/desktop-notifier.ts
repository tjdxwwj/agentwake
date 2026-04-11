import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NotifyEvent } from "../domain/notify-event";
import { logger } from "../utils/logger";
import type { Notifier } from "./notifier";

const execFileAsync = promisify(execFile);

/** terminal-notifier treats empty string as missing — no banner is shown and it errors. */
const FALLBACK_BODY = " ";

function nonEmptyTitle(title: string | undefined): string {
  const t = String(title ?? "").trim();
  return t.length > 0 ? t : "AgentWake";
}

function nonEmptyBody(body: string | undefined): string {
  const b = String(body ?? "");
  return b.trim().length > 0 ? b : FALLBACK_BODY;
}

const DARWIN_NOTIFICATION_BODY_MAX = 4000;
const DARWIN_NOTIFICATION_TITLE_MAX = 120;

function truncatePlainText(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max - 1)}…`;
}

type DesktopMode = "notification" | "dialog" | "both";

export class DesktopNotifier implements Notifier {
  readonly id = "desktop-notifier";
  private readonly mode: DesktopMode;

  constructor() {
    const raw = (process.env.AGENTWAKE_DESKTOP_MODE || "notification").trim().toLowerCase();
    const desiredMode: DesktopMode = raw === "dialog" || raw === "both" ? raw : "notification";
    const approvalMode = (process.env.AGENTWAKE_CURSOR_APPROVAL_MODE || "").trim().toLowerCase();
    // When cursor approval already uses osascript dialog, avoid second dialog popup here.
    if (approvalMode === "osascript" && (desiredMode === "dialog" || desiredMode === "both")) {
      this.mode = "notification";
      logger.warn("desktop notifier mode downgraded to notification to avoid duplicate dialogs");
      return;
    }
    this.mode = desiredMode;
  }

  async notify(event: NotifyEvent): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (this.mode === "notification" || this.mode === "both") {
      tasks.push(this.sendSystemNotification(event));
    }
    if (this.mode === "dialog" || this.mode === "both") {
      tasks.push(this.sendDialog(event));
    }
    await Promise.all(tasks);
  }

  private async sendSystemNotification(event: NotifyEvent): Promise<void> {
    // macOS（含 Apple Silicon）：不用 node-notifier / 自带的 terminal-notifier 二进制
    //（stdout JSON 解析问题、且 vendor 多为 x86）。统一用 osascript。
    if (process.platform === "darwin") {
      await this.sendDarwinNotification(event);
      return;
    }

    const { default: notifier } = await import("node-notifier");
    await new Promise<void>((resolve, reject) => {
      notifier.notify(
        {
          title: event.title,
          message: event.body,
          wait: false,
          timeout: 5,
        },
        (err) => {
          if (err) {
            logger.error("desktop notifier failed", {
              mode: "notification",
              title: event.title,
              error: String(err),
            });
            reject(err);
            return;
          }
          logger.info("desktop notifier sent", { mode: "notification", title: event.title });
          resolve();
        },
      );
    });
  }

  private async sendDarwinNotification(event: NotifyEvent): Promise<void> {
    const title = truncatePlainText(nonEmptyTitle(event.title), DARWIN_NOTIFICATION_TITLE_MAX);
    // 空正文时部分 macOS 版本不展示横幅，与弹窗路径一致使用占位空格
    const body = truncatePlainText(nonEmptyBody(event.body), DARWIN_NOTIFICATION_BODY_MAX);
    try {
      await execFileAsync("osascript", [
        "-e",
        "on run argv",
        "-e",
        'display notification (item 1 of argv) with title (item 2 of argv) subtitle "AgentWake" sound name "Glass"',
        "-e",
        "end run",
        "--",
        body,
        title,
      ]);
      logger.info("desktop notifier sent", { mode: "notification", title: event.title });
    } catch (error) {
      logger.error("desktop notifier failed", {
        mode: "notification",
        title: event.title,
        error: String(error),
      });
      throw error;
    }
  }

  private async sendDialog(event: NotifyEvent): Promise<void> {
    const title = nonEmptyTitle(event.title);
    const body = nonEmptyBody(event.body);
    const escapedTitle = title.replaceAll("\"", "\\\"");
    const escapedBody = body.replaceAll("\"", "\\\"");
    const script = `display dialog "${escapedBody}" with title "${escapedTitle}" buttons {"OK"} default button 1 giving up after 3`;
    try {
      await execFileAsync("osascript", ["-e", script]);
      logger.info("desktop notifier sent", { mode: "dialog", title: event.title });
    } catch (error) {
      logger.error("desktop notifier failed", {
        mode: "dialog",
        title: event.title,
        error: String(error),
      });
      throw error;
    }
  }
}
