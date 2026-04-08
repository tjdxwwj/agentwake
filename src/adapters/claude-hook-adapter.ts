import type { GatewayAdapter } from "../gateway/adapter";
import {
  forbidden,
  parseHookEvent,
  validateHookSourceIp,
} from "./hook-common";

export function createClaudeHookAdapter(): GatewayAdapter {
  return {
    id: "claude-hook-adapter",
    start(context) {
      context.app.post(context.config.claudeHookPath, async (req, res) => {
        if (!validateHookSourceIp(req, context.config.allowedHookIps)) {
          forbidden(res);
          return;
        }

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
