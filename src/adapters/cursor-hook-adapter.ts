import type { GatewayAdapter } from "../gateway/adapter";
import {
  forbidden,
  validateHookSourceIp,
} from "./hook-common";
import { parseHookEvent } from "./hook-common";
import {
  createCursorApprovalEvent,
  parseCursorTerminalHookEvent,
  parseCursorTerminalSignal,
  resolveCursorSignalKey,
  type CursorTerminalSignal,
} from "./cursor-terminal-hook";
import { logger } from "../utils/logger";

export function createCursorHookAdapter(): GatewayAdapter {
  const pendingSignals = new Map<
    string,
    { signal: CursorTerminalSignal; requestedAtMs: number; notifyTimer: ReturnType<typeof setTimeout>; notified: boolean }
  >();
  const REQUEST_NOTIFY_DELAY_MS = 1_000;
  const WAIT_THRESHOLD_MS = 2_000;

  return {
    id: "cursor-hook-adapter",
    start(context) {
      const cleanupSignal = (key: string): void => {
        const pending = pendingSignals.get(key);
        if (!pending) {
          return;
        }
        clearTimeout(pending.notifyTimer);
        pendingSignals.delete(key);
      };

      const scheduleWaitingNotify = (key: string, signal: CursorTerminalSignal): void => {
        cleanupSignal(key);
        const requestedAtMs = Date.now();
        const notifyTimer = setTimeout(() => {
          const pending = pendingSignals.get(key);
          if (!pending || pending.notified) {
            return;
          }
          const waitMs = Date.now() - pending.requestedAtMs;
          pending.notified = true;
          void context
            .emit(
              createCursorApprovalEvent({
                signal: pending.signal,
                reason: "time-gap-before-after",
                waitMs,
              }),
            )
            .catch((error) => logger.error("cursor delayed notify failed", { error: String(error) }));
        }, REQUEST_NOTIFY_DELAY_MS);
        pendingSignals.set(key, {
          signal,
          requestedAtMs,
          notifyTimer,
          notified: false,
        });
      };

      context.app.post(context.config.cursorHookPath, async (req, res) => {
        logger.info("cursor hook incoming", {
          event: req.body?.hook_event_name,
          command: req.body?.command,
          permission: req.body?.permission,
          requiresApproval: req.body?.requiresApproval,
          ip: req.ip || req.socket.remoteAddress,
        });
        if (!validateHookSourceIp(req, context.config.allowedHookIps)) {
          forbidden(res);
          return;
        }

        const signal = parseCursorTerminalSignal(req.body);
        if (signal) {
          const key = resolveCursorSignalKey(signal);
          if (signal.hookEvent === "beforeShellExecution") {
            if (signal.explicitApproval) {
              const event = createCursorApprovalEvent({
                signal,
                reason: "explicit-hook-signal",
              });
              void context.emit(event).catch((error) =>
                logger.error("cursor notify emit failed", { error: String(error) }),
              );
              logger.info("cursor hook accepted", {
                dedupeKey: event.dedupeKey,
                title: event.title,
                level: event.level,
                reason: "explicit-hook-signal",
              });
              res.status(200).json({ ok: true, accepted: true });
              return;
            }
            scheduleWaitingNotify(key, signal);
            logger.info("cursor hook pending approval watch", {
              key,
              command: signal.command,
              delayMs: REQUEST_NOTIFY_DELAY_MS,
            });
            res.status(202).json({ ok: true, accepted: false, reason: "pending-time-check" });
            return;
          }

          const pending = pendingSignals.get(key);
          if (pending) {
            const waitMs = Math.max(
              typeof signal.durationMs === "number" ? signal.durationMs : 0,
              Date.now() - pending.requestedAtMs,
            );
            clearTimeout(pending.notifyTimer);
            pendingSignals.delete(key);
            if (!pending.notified && waitMs >= WAIT_THRESHOLD_MS) {
              const event = createCursorApprovalEvent({
                signal: pending.signal,
                reason: "time-gap-after-shell",
                waitMs,
              });
              void context.emit(event).catch((error) =>
                logger.error("cursor notify emit failed", { error: String(error) }),
              );
              logger.info("cursor hook accepted", {
                dedupeKey: event.dedupeKey,
                title: event.title,
                level: event.level,
                reason: "time-gap-after-shell",
                waitMs,
              });
              res.status(200).json({ ok: true, accepted: true });
              return;
            }
            logger.info("cursor hook resolved quickly", {
              key,
              waitMs,
            });
            res.status(202).json({ ok: true, accepted: false, reason: "resolved-quickly" });
            return;
          }
        }

        const event = parseCursorTerminalHookEvent(req.body) ?? parseHookEvent("cursor", "cursor-hook", req.body);
        if (!event) {
          logger.info("cursor hook ignored", {
            event: req.body?.hook_event_name,
            command: req.body?.command,
          });
          res.status(202).json({ ok: true, accepted: false, reason: "ignored" });
          return;
        }
        logger.info("cursor hook accepted", {
          dedupeKey: event.dedupeKey,
          title: event.title,
          level: event.level,
        });
        await context.emit(event);
        res.status(200).json({ ok: true, accepted: true });
      });

      return () => {
        for (const pending of pendingSignals.values()) {
          clearTimeout(pending.notifyTimer);
        }
        pendingSignals.clear();
      };
    },
  };
}
