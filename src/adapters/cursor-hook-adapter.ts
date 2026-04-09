import type { Response } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GatewayAdapter } from "../gateway/adapter";
import {
  forbidden,
  parseHookEvent,
  validateHookSourceIp,
} from "./hook-common";
import {
  createCursorApprovalEvent,
  createCursorLifecycleEvents,
  parseCursorSessionEndEvent,
  parseCursorTerminalHookEvent,
  parseCursorTerminalSignal,
  resolveCursorSignalKey,
  type CursorTerminalSignal,
} from "./cursor-terminal-hook";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);

export function createCursorHookAdapter(): GatewayAdapter {
  return {
    id: "cursor-hook-adapter",
    start(context) {
      const pendingSignals = new Map<
        string,
        {
          signal: CursorTerminalSignal;
          requestedAtMs: number;
          notifyTimer: ReturnType<typeof setTimeout>;
          notified: boolean;
          probeCount: number;
        }
      >();
      const WAIT_NOTIFY_DELAY_MS = 2_000;
      const WAIT_CONFIRM_DELAY_MS = 2_000;

      const emitInBackground = (event: ReturnType<typeof createCursorApprovalEvent>): void => {
        void context.emit(event).catch((error) =>
          logger.error("cursor notify emit failed", { error: String(error) }),
        );
      };
      const accept = (res: Response): void => {
        res.status(200).json({ ok: true, accepted: true });
      };
      const shouldNotifyByMarker = (signal: CursorTerminalSignal): boolean =>
        (signal.agentMarker === "cursor" || signal.agentMarker === "qoder") && signal.hasChildProcess === true;
      const countChildProcessesByParentPid = async (parentPid: number): Promise<number | undefined> => {
        try {
          const { stdout } = await execFileAsync("ps", ["-axo", "ppid=,pid="]);
          const lines = String(stdout || "").split("\n");
          let count = 0;
          const targetParent = String(parentPid);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            const [ppid, pid] = trimmed.split(/\s+/);
            if (ppid === targetParent && pid) {
              count += 1;
            }
          }
          return count;
        } catch {
          return undefined;
        }
      };
      const cleanupPendingSignal = (key: string): void => {
        const pending = pendingSignals.get(key);
        if (!pending) {
          return;
        }
        clearTimeout(pending.notifyTimer);
        pendingSignals.delete(key);
      };
      const schedulePendingSignalWatch = (key: string, signal: CursorTerminalSignal): void => {
        cleanupPendingSignal(key);
        const requestedAtMs = Date.now();
        const runProbe = (delayMs: number): ReturnType<typeof setTimeout> =>
          setTimeout(() => {
            const pending = pendingSignals.get(key);
            if (!pending || pending.notified) {
              return;
            }
            void (async () => {
              const latestCount =
                typeof pending.signal.parentPid === "number"
                  ? await countChildProcessesByParentPid(pending.signal.parentPid)
                  : undefined;
              const hasLatestChildProcess = typeof latestCount === "number" ? latestCount > 0 : false;
              if (hasLatestChildProcess) {
                logger.debug("cursor pending watch skipped: command still executing", {
                  key,
                  parentPid: pending.signal.parentPid,
                  latestChildCount: latestCount,
                });
                cleanupPendingSignal(key);
                return;
              }

              pending.probeCount += 1;
              if (pending.probeCount < 2) {
                pending.notifyTimer = runProbe(WAIT_CONFIRM_DELAY_MS);
                return;
              }

              const waitMs = Math.max(0, Date.now() - pending.requestedAtMs);
              pending.notified = true;
              const event = createCursorApprovalEvent({
                signal: pending.signal,
                reason: "time-gap-without-child-process",
                waitMs,
              });
              emitInBackground(event);
              logger.info("cursor hook accepted", {
                dedupeKey: event.dedupeKey,
                title: event.title,
                level: event.level,
                reason: "time-gap-without-child-process",
                waitMs,
                latestChildCount: latestCount,
                probeCount: pending.probeCount,
              });
            })();
          }, delayMs);
        const notifyTimer = runProbe(WAIT_NOTIFY_DELAY_MS);
        pendingSignals.set(key, {
          signal,
          requestedAtMs,
          notifyTimer,
          notified: false,
          probeCount: 0,
        });
      };

      context.app.post(context.config.cursorHookPath, async (req, res) => {
        logger.info("cursor hook incoming", {
          event: req.body?.hook_event_name,
          command: req.body?.command,
          permission: req.body?.permission,
          requiresApproval: req.body?.requiresApproval,
          agentMarker: req.body?.agent_marker,
          hasChildProcess: req.body?.has_child_process,
          parentChildCount: req.body?.parent_child_count,
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
              emitInBackground(event);
              logger.info("cursor hook accepted", {
                dedupeKey: event.dedupeKey,
                title: event.title,
                level: event.level,
                reason: "explicit-hook-signal",
              });
              accept(res);
              return;
            }

            if (shouldNotifyByMarker(signal)) {
              const event = createCursorApprovalEvent({
                signal,
                reason: "agent-marker-with-child-process",
              });
              emitInBackground(event);
              logger.info("cursor hook accepted", {
                dedupeKey: event.dedupeKey,
                title: event.title,
                level: event.level,
                reason: "agent-marker-with-child-process",
                agentMarker: signal.agentMarker,
                hasChildProcess: signal.hasChildProcess,
                parentChildCount: signal.parentChildCount,
              });
              accept(res);
              return;
            }

            logger.info("cursor hook ignored by marker guard", {
              key,
              command: signal.command,
              agentMarker: signal.agentMarker,
              hasChildProcess: signal.hasChildProcess,
              parentChildCount: signal.parentChildCount,
            });
            schedulePendingSignalWatch(key, signal);
            res.status(202).json({ ok: true, accepted: false, reason: "marker-guard-not-hit" });
            return;
          }

          const pending = pendingSignals.get(key);
          if (pending) {
            clearTimeout(pending.notifyTimer);
            pendingSignals.delete(key);
          }

          logger.debug("cursor afterShellExecution observed", {
            key,
            durationMs: signal.durationMs,
            exitCode: signal.exitCode,
            agentMarker: signal.agentMarker,
            hasChildProcess: signal.hasChildProcess,
            parentChildCount: signal.parentChildCount,
          });
          const events = createCursorLifecycleEvents({ signal });
          for (const event of events) {
            emitInBackground(event);
          }
          logger.info("cursor hook accepted", {
            reason: "lifecycle-after-shell",
            exitCode: signal.exitCode,
            agentMarker: signal.agentMarker,
            emitted: events.map((event) => ({
              dedupeKey: event.dedupeKey,
              title: event.title,
              level: event.level,
            })),
          });
          accept(res);
          return;
        }

        const event =
          parseCursorSessionEndEvent(req.body) ??
          parseCursorTerminalHookEvent(req.body) ??
          parseHookEvent("cursor", "cursor-hook", req.body);
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
        accept(res);
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
