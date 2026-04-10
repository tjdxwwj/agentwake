import { appendFile, mkdir } from "node:fs/promises";
import type { Response } from "express";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GatewayAdapter } from "../gateway/adapter";
import {
  forbidden,
  validateHookSourceIp,
} from "./hook-common";
import {
  createCursorApprovalEvent,
  createCursorLifecycleEvents,
  parseCursorLifecycleHookEvent,
  parseCursorSessionEndEvent,
  parseCursorTerminalHookEvent,
  parseCursorTerminalSignal,
  resolveCursorSignalKey,
  type CursorTerminalSignal,
} from "./cursor-terminal-hook";
import { logger } from "../utils/logger";
import {
  createEmptyCursorCommandMemory,
  isCommandInCursorMemoryAllowlist,
  type CursorCommandMemory,
} from "../utils/cursor-command-memory";

const execFileAsync = promisify(execFile);
const CURSOR_GLOBAL_STATE_DB = path.join(
  homedir(),
  "Library",
  "Application Support",
  "Cursor",
  "User",
  "globalStorage",
  "state.vscdb",
);
const CURSOR_APP_USER_STORAGE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const CURSOR_EXPLICIT_APPROVAL_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const CURSOR_MEMORY_DEBUG_LOG_ENABLED = (process.env.AGENTWAKE_CURSOR_MEMORY_DEBUG_LOG || "0") !== "0";
const CURSOR_MEMORY_DEBUG_LOG_FILE =
  process.env.AGENTWAKE_CURSOR_DEBUG_LOG_FILE || path.join(process.cwd(), ".agentwake", "cursor-hook-debug.jsonl");

type CursorAutoRunState = {
  agentAutoRun: boolean;
  agentFullAutoRun: boolean;
  yoloEnableRunEverything: boolean;
  loadedAtMs: number;
};

type CursorAgentRunMode =
  | "ask-every-time"
  | "allowlist-auto-run"
  | "full-auto-run"
  | "unknown-combination";

function createDefaultCursorAutoRunState(): CursorAutoRunState {
  return {
    agentAutoRun: false,
    agentFullAutoRun: false,
    yoloEnableRunEverything: false,
    loadedAtMs: 0,
  };
}

type CursorComposerState = {
  yoloCommandAllowlist?: unknown;
  yoloCommandDenylist?: unknown;
  smartAllowlistEnabled?: unknown;
  yoloEnableRunEverything?: unknown;
  modes4?: Array<{
    id?: unknown;
    autoRun?: unknown;
    fullAutoRun?: unknown;
  }>;
};

type CursorStorageSnapshot = {
  commandMemory: CursorCommandMemory;
  autoRunState: CursorAutoRunState;
};

async function writeCursorMemoryDebugLog(
  phase: string,
  meta: Record<string, unknown>,
): Promise<void> {
  if (!CURSOR_MEMORY_DEBUG_LOG_ENABLED) {
    return;
  }
  try {
    await mkdir(path.dirname(CURSOR_MEMORY_DEBUG_LOG_FILE), { recursive: true });
    await appendFile(
      CURSOR_MEMORY_DEBUG_LOG_FILE,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        phase,
        component: "cursor-hook-adapter",
        ...meta,
      })}\n`,
      "utf8",
    );
  } catch {
    // Keep adapter non-blocking when debug logging fails.
  }
}

function parseCursorStorageSnapshot(rawJson: string): CursorStorageSnapshot {
  const fallbackMemory = createEmptyCursorCommandMemory();
  const fallbackAutoRun = createDefaultCursorAutoRunState();
  try {
    const parsed = JSON.parse(rawJson) as {
      composerState?: CursorComposerState;
    };
    const composerState = parsed?.composerState;
    if (!composerState) {
      return {
        commandMemory: fallbackMemory,
        autoRunState: fallbackAutoRun,
      };
    }
    const now = Date.now();
    const allowlist = Array.isArray(composerState.yoloCommandAllowlist)
      ? composerState.yoloCommandAllowlist.filter((item): item is string => typeof item === "string")
      : [];
    const denylist = Array.isArray(composerState.yoloCommandDenylist)
      ? composerState.yoloCommandDenylist.filter((item): item is string => typeof item === "string")
      : [];
    const modes = Array.isArray(composerState.modes4) ? composerState.modes4 : [];
    const agentMode = modes.find((mode) => mode && mode.id === "agent");
    return {
      commandMemory: {
        allowlist,
        denylist,
        smartAllowlistEnabled: composerState.smartAllowlistEnabled === true,
        loadedAtMs: now,
      },
      autoRunState: {
        agentAutoRun: agentMode?.autoRun === true,
        agentFullAutoRun: agentMode?.fullAutoRun === true,
        yoloEnableRunEverything: composerState.yoloEnableRunEverything === true,
        loadedAtMs: now,
      },
    };
  } catch {
    return {
      commandMemory: fallbackMemory,
      autoRunState: fallbackAutoRun,
    };
  }
}

function resolveCursorAgentRunMode(state: CursorAutoRunState): CursorAgentRunMode {
  // Keep mode mapping centralized so decision points only depend on semantic mode.
  if (state.yoloEnableRunEverything === true || state.agentFullAutoRun === true) {
    return "full-auto-run";
  }
  if (state.agentAutoRun === true) {
    return "allowlist-auto-run";
  }
  if (state.agentAutoRun === false) {
    return "ask-every-time";
  }
  return "unknown-combination";
}

export function createCursorHookAdapter(): GatewayAdapter {
  return {
    id: "cursor-hook-adapter",
    start(context) {
      const cursorEnabledEvents = new Set(context.config.cursorEnabledEvents);
      const qoderEnabledEvents = new Set(context.config.qoderEnabledEvents);
      const isEditorEventEnabled = (editor: "cursor" | "qoder", eventName: string | undefined): boolean => {
        const enabledEvents = editor === "qoder" ? qoderEnabledEvents : cursorEnabledEvents;
        if (!eventName) {
          return enabledEvents.has("Notification");
        }
        return enabledEvents.has(eventName);
      };

      const emitInBackground = (event: ReturnType<typeof createCursorApprovalEvent>): void => {
        void context.emit(event).catch((error) =>
          logger.error("cursor notify emit failed", { error: String(error) }),
        );
      };
      const accept = (res: Response): void => {
        res.status(200).json({ ok: true, accepted: true });
      };
      const pendingSignals = new Map<
        string,
        {
          signal: CursorTerminalSignal;
          requestedAtMs: number;
          notifyTimer: ReturnType<typeof setTimeout>;
          notified: boolean;
        }
      >();
      const WAIT_NO_AFTER_DELAY_MS = 4_000;
      let cursorCommandMemory = createEmptyCursorCommandMemory();
      let cursorAutoRunState = createDefaultCursorAutoRunState();
      const explicitApprovalRequests = new Map<string, number>();
      const pruneExpiredExplicitApprovalRequests = (nowMs: number): void => {
        for (const [key, ts] of explicitApprovalRequests.entries()) {
          if (nowMs - ts > CURSOR_EXPLICIT_APPROVAL_REFRESH_WINDOW_MS) {
            explicitApprovalRequests.delete(key);
          }
        }
      };
      const recordExplicitApprovalRequest = (key: string): void => {
        const nowMs = Date.now();
        pruneExpiredExplicitApprovalRequests(nowMs);
        explicitApprovalRequests.set(key, nowMs);
      };
      const consumeExplicitApprovalRequest = (key: string): boolean => {
        const nowMs = Date.now();
        pruneExpiredExplicitApprovalRequests(nowMs);
        const exists = explicitApprovalRequests.has(key);
        if (exists) {
          explicitApprovalRequests.delete(key);
        }
        return exists;
      };
      const refreshCursorCommandMemory = async (reason: string): Promise<void> => {
        await writeCursorMemoryDebugLog("cursor-memory-refresh-start", { reason });
        try {
          const sql = `SELECT CAST(value AS TEXT) FROM ItemTable WHERE key='${CURSOR_APP_USER_STORAGE_KEY}' LIMIT 1;`;
          const { stdout } = await execFileAsync("sqlite3", [CURSOR_GLOBAL_STATE_DB, sql], {
            maxBuffer: 25 * 1024 * 1024,
          });
          const value = String(stdout || "").trim();
          if (!value) {
            return;
          }
          const snapshot = parseCursorStorageSnapshot(value);
          cursorCommandMemory = snapshot.commandMemory;
          cursorAutoRunState = snapshot.autoRunState;
          logger.info("cursor command memory refreshed", {
            reason,
            allowlistCount: snapshot.commandMemory.allowlist.length,
            denylistCount: snapshot.commandMemory.denylist.length,
            smartAllowlistEnabled: snapshot.commandMemory.smartAllowlistEnabled,
            agentAutoRun: snapshot.autoRunState.agentAutoRun,
            agentFullAutoRun: snapshot.autoRunState.agentFullAutoRun,
            yoloEnableRunEverything: snapshot.autoRunState.yoloEnableRunEverything,
          });
          await writeCursorMemoryDebugLog("cursor-memory-refresh-success", {
            reason,
            allowlistCount: snapshot.commandMemory.allowlist.length,
            denylistCount: snapshot.commandMemory.denylist.length,
            smartAllowlistEnabled: snapshot.commandMemory.smartAllowlistEnabled,
            agentAutoRun: snapshot.autoRunState.agentAutoRun,
            agentFullAutoRun: snapshot.autoRunState.agentFullAutoRun,
            yoloEnableRunEverything: snapshot.autoRunState.yoloEnableRunEverything,
          });
        } catch (error) {
          logger.debug("cursor command memory refresh skipped", {
            reason,
            error: String(error),
          });
          await writeCursorMemoryDebugLog("cursor-memory-refresh-failed", {
            reason,
            error: String(error),
          });
        }
      };
      void refreshCursorCommandMemory("adapter-start");
      const cleanupPendingSignal = (key: string): void => {
        const pending = pendingSignals.get(key);
        if (!pending) {
          return;
        }
        clearTimeout(pending.notifyTimer);
        pendingSignals.delete(key);
      };
      const schedulePendingSignalWatch = async (key: string, signal: CursorTerminalSignal): Promise<void> => {
        cleanupPendingSignal(key);
        const requestedAtMs = Date.now();
        const notifyTimer = setTimeout(() => {
          const pending = pendingSignals.get(key);
          if (!pending || pending.notified) {
            return;
          }
          const waitMs = Math.max(0, Date.now() - pending.requestedAtMs);
          pending.notified = true;
          const editor = pending.signal.agentMarker === "qoder" ? "qoder" : "cursor";
          if (!isEditorEventEnabled(editor, "Notification")) {
            cleanupPendingSignal(key);
            return;
          }
          const event = createCursorApprovalEvent({
            signal: pending.signal,
            reason: "allowlist-miss-and-no-after-4s",
            waitMs,
          });
          emitInBackground(event);
          logger.info("cursor hook accepted", {
            dedupeKey: event.dedupeKey,
            title: event.title,
            level: event.level,
            reason: "allowlist-miss-and-no-after-4s",
            waitMs,
          });
        }, WAIT_NO_AFTER_DELAY_MS);
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
          agentMarker: req.body?.agent_marker,
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
            await refreshCursorCommandMemory("before-shell-realtime");
            const signalEditor = signal.agentMarker === "qoder" ? "qoder" : "cursor";
            if (signal.explicitApproval) {
              recordExplicitApprovalRequest(key);
              if (!isEditorEventEnabled(signalEditor, "Notification")) {
                accept(res);
                return;
              }
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
            logger.info("cursor hook waiting for delayed no-after probe", {
              strategy: "allowlist + 4s-no-after",
              key,
              command: signal.command,
              hookEvent: signal.hookEvent,
              sandbox: signal.sandbox,
              explicitApproval: signal.explicitApproval,
              agentMarker: signal.agentMarker,
            });
            const runMode = resolveCursorAgentRunMode(cursorAutoRunState);
            if (runMode === "ask-every-time") {
              if (!isEditorEventEnabled(signalEditor, "Notification")) {
                accept(res);
                return;
              }
              const event = createCursorApprovalEvent({
                signal,
                reason: "ask-every-time-mode",
              });
              emitInBackground(event);
              logger.info("cursor hook accepted", {
                dedupeKey: event.dedupeKey,
                title: event.title,
                level: event.level,
                reason: "ask-every-time-mode",
                runMode,
              });
              void writeCursorMemoryDebugLog("cursor-memory-ask-every-time-notified", {
                key,
                command: signal.command,
                runMode,
                agentAutoRun: cursorAutoRunState.agentAutoRun,
                agentFullAutoRun: cursorAutoRunState.agentFullAutoRun,
                yoloEnableRunEverything: cursorAutoRunState.yoloEnableRunEverything,
                loadedAtMs: cursorAutoRunState.loadedAtMs,
              });
              accept(res);
              return;
            }
            if (runMode !== "allowlist-auto-run") {
              logger.info("cursor hook skipped delayed probe: autorun mode not applicable", {
                key,
                command: signal.command,
                runMode,
                agentAutoRun: cursorAutoRunState.agentAutoRun,
                agentFullAutoRun: cursorAutoRunState.agentFullAutoRun,
                yoloEnableRunEverything: cursorAutoRunState.yoloEnableRunEverything,
              });
              void writeCursorMemoryDebugLog("cursor-memory-probe-skipped-autorun-state", {
                key,
                command: signal.command,
                runMode,
                agentAutoRun: cursorAutoRunState.agentAutoRun,
                agentFullAutoRun: cursorAutoRunState.agentFullAutoRun,
                yoloEnableRunEverything: cursorAutoRunState.yoloEnableRunEverything,
                loadedAtMs: cursorAutoRunState.loadedAtMs,
              });
              res.status(202).json({ ok: true, accepted: false, reason: "autorun-state-not-applicable" });
              return;
            }
            if (
              isCommandInCursorMemoryAllowlist(
                signal.command,
                cursorCommandMemory.allowlist,
                cursorCommandMemory.denylist,
              )
            ) {
              logger.info("cursor hook skipped delayed probe: command matched cursor memory allowlist", {
                key,
                command: signal.command,
                allowlistCount: cursorCommandMemory.allowlist.length,
                loadedAtMs: cursorCommandMemory.loadedAtMs,
              });
              void writeCursorMemoryDebugLog("cursor-memory-allowlist-hit", {
                key,
                command: signal.command,
                allowlistCount: cursorCommandMemory.allowlist.length,
                denylistCount: cursorCommandMemory.denylist.length,
                loadedAtMs: cursorCommandMemory.loadedAtMs,
              });
              res.status(202).json({ ok: true, accepted: false, reason: "cursor-memory-allowlist" });
              return;
            }
            await schedulePendingSignalWatch(key, signal);
            res.status(202).json({ ok: true, accepted: false, reason: "await-no-after-4s-probe" });
            return;
          }
          const pending = pendingSignals.get(key);
          if (pending) {
            clearTimeout(pending.notifyTimer);
            pendingSignals.delete(key);
          }
          if (consumeExplicitApprovalRequest(key)) {
            void writeCursorMemoryDebugLog("cursor-memory-refresh-triggered", {
              reason: "manual-approval-observed",
              key,
              command: signal.command,
            });
            void refreshCursorCommandMemory("manual-approval-observed");
          }
          logger.debug("cursor afterShellExecution observed", {
            key,
            durationMs: signal.durationMs,
            exitCode: signal.exitCode,
            agentMarker: signal.agentMarker,
          });
          const events = createCursorLifecycleEvents({ signal });
          for (const event of events) {
            const eventName = String(event.meta?.eventName ?? "");
            const editor = event.editor === "qoder" ? "qoder" : "cursor";
            if (isEditorEventEnabled(editor, eventName)) {
              emitInBackground(event);
            }
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
          parseCursorLifecycleHookEvent(req.body) ??
          parseCursorSessionEndEvent(req.body) ??
          parseCursorTerminalHookEvent(req.body);
        if (!event) {
          logger.info("cursor hook ignored", {
            event: req.body?.hook_event_name,
            command: req.body?.command,
          });
          res.status(202).json({ ok: true, accepted: false, reason: "ignored" });
          return;
        }
        const eventName = String(event.meta?.eventName ?? "");
        const editor = event.editor === "qoder" ? "qoder" : "cursor";
        if (!isEditorEventEnabled(editor, eventName)) {
          res.status(202).json({ ok: true, accepted: false, reason: "event-disabled" });
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
        explicitApprovalRequests.clear();
      };
    },
  };
}
