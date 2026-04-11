import { z } from "zod";
import type { GatewayAdapter } from "../../gateway/adapter";
import { createNotifyEvent, type NotifyLevel } from "../../domain/notify-event";
import {
  forbidden,
  parseHookEvent,
  validateHookSourceIp,
} from "../shared/hook-common";

// Claude Code native hook payload schema
const claudeNativeSchema = z.object({
  hook_event_name: z.string(),
  session_id: z.string().optional(),
  last_assistant_message: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
}).passthrough();

const HOOK_LEVEL_MAP: Record<string, NotifyLevel> = {
  StopFailure: "error",
  Notification: "warn",
  Stop: "info",
  SessionEnd: "info",
  SessionStart: "info",
};

const IGNORED_HOOKS = new Set(["PreToolUse", "PostToolUse"]);

/** Default titles when no custom title is configured. */
const DEFAULT_TITLES: Record<string, string> = {
  Stop: "Claude Code: 任务完成",
  StopFailure: "Claude Code: 任务异常终止",
  Notification: "Claude Code: 需要你的注意",
  SessionEnd: "Claude Code: 会话已结束",
  SessionStart: "Claude Code: 会话已开始",
};

function buildClaudeDedupeKey(payload: z.infer<typeof claudeNativeSchema>): string {
  const messageToken = payload.last_assistant_message?.slice(0, 120) ?? "";
  return [
    "claude",
    payload.hook_event_name,
    payload.session_id ?? "unknown-session",
    payload.transcript_path ?? "",
    messageToken,
  ].join(":");
}

export function createClaudeHookAdapter(): GatewayAdapter {
  return {
    id: "claude-hook-adapter",
    start(context) {
      const customTitles = context.config.claudeEventTitles;

      context.app.post(context.config.claudeHookPath, async (req, res) => {
        if (!validateHookSourceIp(req, context.config.allowedHookIps)) {
          forbidden(res);
          return;
        }

        // Try Claude Code native format first (has hook_event_name field)
        const nativeParsed = claudeNativeSchema.safeParse(req.body);
        if (nativeParsed.success && nativeParsed.data.hook_event_name) {
          const data = nativeParsed.data;
          const hookName = data.hook_event_name;
          if (IGNORED_HOOKS.has(hookName)) {
            res.status(202).json({ ok: true, accepted: false, reason: "ignored-event" });
            return;
          }
          const level = HOOK_LEVEL_MAP[hookName] ?? "info";
          const title = customTitles[hookName] || DEFAULT_TITLES[hookName] || `Claude Code: ${hookName}`;

          const event = createNotifyEvent({
            source: "claude-hook",
            editor: "claude-code",
            level,
            title,
            body: data.last_assistant_message?.slice(0, 300) || "",
            dedupeKey: buildClaudeDedupeKey(data),
            meta: {
              eventName: hookName,
              sessionId: data.session_id,
              transcriptPath: data.transcript_path,
              cwd: data.cwd,
            },
          });
          await context.emit(event);
          res.status(200).json({ ok: true, accepted: true });
          return;
        }

        // Fallback: generic hook event parsing (approval-waiting text matching)
        const event = parseHookEvent("claude-code", "claude-hook", req.body);
        if (!event) {
          res.status(202).json({ ok: true, accepted: false, reason: "ignored" });
          return;
        }
        await context.emit(event);
        res.status(200).json({ ok: true, accepted: true });
      });
    },
  };
}
