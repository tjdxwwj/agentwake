import notifier from "node-notifier";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NotifyEvent } from "../domain/notify-event";
import { logger } from "../utils/logger";
import type { Notifier } from "./notifier";

const execFileAsync = promisify(execFile);

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

  private async sendDialog(event: NotifyEvent): Promise<void> {
    const escapedTitle = event.title.replaceAll("\"", "\\\"");
    const escapedBody = event.body.replaceAll("\"", "\\\"");
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
