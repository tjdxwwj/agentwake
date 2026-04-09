import { createReadStream, existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createNotifyEvent, type NotifyEvent } from "../domain/notify-event";
import type { AdapterStop, GatewayAdapter } from "../gateway/adapter";
import { logger } from "../utils/logger";

export type QoderLogSignal =
  | {
      type: "permission_requested";
      toolCallId: string;
      toolName: string;
      logTimestampSec: number | undefined;
    }
  | {
      type: "permission_resolved";
      toolCallId: string;
      outcome: "allow" | "reject" | "cancelled" | "unknown";
      logTimestampSec: number | undefined;
    }
  | {
      type: "command_completed";
      command: string | undefined;
      exitCode: number;
      logTimestampSec: number | undefined;
    }
  | {
      type: "agent_suspended";
    }
  | {
      type: "agent_resumed";
    }
  | {
      type: "agent_session_end";
      logTimestampSec: number | undefined;
      sessionId: string | undefined;
    };

type PendingRequest = {
  toolName: string;
  requestLogSec: number | undefined;
  notifyTimer: ReturnType<typeof setTimeout>;
};

type FileCursor = {
  cursor: number;
};

const WAIT_THRESHOLD_SEC = 2;
const WAIT_THRESHOLD_MS = WAIT_THRESHOLD_SEC * 1_000;
const WAIT_NOTIFY_DELAY_MS = WAIT_THRESHOLD_MS;
const FILE_POLL_MS = 500;
const DISCOVERY_POLL_MS = 5_000;
const COMPLETION_DEDUPE_WINDOW_MS = 3_000;

const LOG_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:[.,]\d{3,6})?/;

function extractLogTimestampSec(line: string): number | undefined {
  const match = line.match(LOG_TIMESTAMP_RE);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const timestampMs = new Date(year, month - 1, day, hour, minute, second).getTime();
  if (!Number.isFinite(timestampMs)) {
    return undefined;
  }
  return Math.floor(timestampMs / 1_000);
}

function extractToolCallId(line: string): string | undefined {
  const match = line.match(/toolCallId[=:]["']?([^,"'\s}]+)/i);
  return match?.[1]?.trim() || undefined;
}

function extractToolName(line: string): string | undefined {
  const match = line.match(/toolName[=:]["']?([^,"'\s}]+)/i);
  return match?.[1]?.trim() || undefined;
}

function detectResolveOutcome(line: string): "allow" | "reject" | "cancelled" | "unknown" {
  if (/cancelled/i.test(line)) {
    return "cancelled";
  }
  if (/"name":"Allow"/i.test(line)) {
    return "allow";
  }
  if (/"name":"Reject"/i.test(line)) {
    return "reject";
  }
  return "unknown";
}

function extractExitCode(line: string): number | undefined {
  const match = line.match(/exitCode[:=]\s*(-?\d+)/i);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function extractCompletedCommand(line: string): string | undefined {
  const match = line.match(/Command finished via end event:\s*(.+?),\s*exitCode[:=]/i);
  const raw = match?.[1]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function extractSessionId(line: string): string | undefined {
  const byJson = line.match(/"sessionId"\s*:\s*"([^"]+)"/i);
  if (byJson?.[1]) {
    return byJson[1];
  }
  const byToken = line.match(/\bsessionId[=:]\s*["']?([^,"'\s}]+)/i);
  if (byToken?.[1]) {
    return byToken[1];
  }
  return undefined;
}

function findLatestQoderSessionDir(baseDir: string): string | undefined {
  if (!existsSync(baseDir)) {
    return undefined;
  }
  const entries = readdirSync(baseDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length === 0) {
    return undefined;
  }

  let latestDir: string | undefined;
  let latestMtime = -1;
  for (const entry of entries) {
    const candidate = path.join(baseDir, entry.name);
    const mtime = statSync(candidate).mtimeMs;
    if (mtime > latestMtime) {
      latestMtime = mtime;
      latestDir = candidate;
    }
  }
  return latestDir;
}

function findRecentQoderSessionDirs(baseDir: string, limit: number): string[] {
  if (!existsSync(baseDir)) {
    return [];
  }
  const entries = readdirSync(baseDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return entries
    .map((entry) => {
      const fullPath = path.join(baseDir, entry.name);
      return { fullPath, mtime: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(1, limit))
    .map((item) => item.fullPath);
}

function collectAgentLogsRecursively(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const result: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "agent.log") {
        result.push(fullPath);
      }
    }
  }
  return result;
}

function resolveQoderLogPaths(configPath?: string): string[] {
  if (configPath) {
    if (existsSync(configPath)) {
      const stats = statSync(configPath);
      if (stats.isFile()) {
        return [configPath];
      }
      if (stats.isDirectory()) {
        return collectAgentLogsRecursively(configPath);
      }
      return [];
    }
    // Invalid explicit path: gracefully fall back to auto-discovery.
  }

  const qoderBase = path.join(os.homedir(), "Library", "Application Support", "Qoder", "logs");
  const latestSessionDir = findLatestQoderSessionDir(qoderBase);
  const candidateRoots = latestSessionDir
    ? [latestSessionDir, ...findRecentQoderSessionDirs(qoderBase, 5).filter((item) => item !== latestSessionDir)]
    : findRecentQoderSessionDirs(qoderBase, 5);

  const logs = new Set<string>();
  for (const root of candidateRoots) {
    for (const logPath of collectAgentLogsRecursively(root)) {
      logs.add(logPath);
    }
  }
  if (logs.size > 0) {
    return Array.from(logs);
  }

  // Fallback: scan all sessions if recent sessions don't contain agent.log yet.
  if (!existsSync(qoderBase)) {
    return [];
  }
  return collectAgentLogsRecursively(qoderBase);
}

export function parseQoderLogLine(line: string): QoderLogSignal | null {
  const text = line.trim();
  if (!text) {
    return null;
  }

  if (/Tool permission requested/i.test(text)) {
    const toolCallId = extractToolCallId(text);
    if (!toolCallId) {
      return null;
    }
    return {
      type: "permission_requested",
      toolCallId,
      toolName: extractToolName(text) ?? "tool",
      logTimestampSec: extractLogTimestampSec(text),
    };
  }

  if (/Permission (resolved|cancelled)/i.test(text)) {
    const toolCallId = extractToolCallId(text);
    if (!toolCallId) {
      return null;
    }
    return {
      type: "permission_resolved",
      toolCallId,
      outcome: detectResolveOutcome(text),
      logTimestampSec: extractLogTimestampSec(text),
    };
  }

  if (/Command finished via end event|Command execution completed|Command completed|Temporary command completed/i.test(text)) {
    const exitCode = extractExitCode(text);
    if (typeof exitCode !== "number") {
      return null;
    }
    return {
      type: "command_completed",
      command: extractCompletedCommand(text),
      exitCode,
      logTimestampSec: extractLogTimestampSec(text),
    };
  }

  if (/streaming -> suspended.*permission_request/i.test(text)) {
    return { type: "agent_suspended" };
  }

  if (
    /suspended -> cancelled|session (ended|closed)|State transition:\s*streaming\s*->\s*completed|ACP stream completed|Closed tab:/i.test(
      text,
    )
  ) {
    return {
      type: "agent_session_end",
      logTimestampSec: extractLogTimestampSec(text),
      sessionId: extractSessionId(text),
    };
  }

  if (/suspended -> streaming/i.test(text)) {
    return { type: "agent_resumed" };
  }

  return null;
}

export function createQoderLogAdapter(): GatewayAdapter {
  return {
    id: "qoder-log-adapter",
    async start(context) {
      const pendingRequests = new Map<string, PendingRequest>();
      const recentCompletionKeys = new Map<string, number>();
      const cursors = new Map<string, FileCursor>();
      let filePollTimer: ReturnType<typeof setInterval> | undefined;
      let discoveryPollTimer: ReturnType<typeof setInterval> | undefined;
      let reading = false;

      const emitWaitingNotification = async (toolCallId: string, toolName: string): Promise<void> => {
        const event: NotifyEvent = createNotifyEvent({
          source: "qoder-log",
          editor: "qoder",
          level: "warn",
          title: "Qoder 终端等待用户同意",
          body: `${toolName || "tool"} 等待你的同意`,
          dedupeKey: `qoder-log:pending:${toolCallId}`,
          meta: {
            toolCallId,
            toolName,
            eventName: "ApprovalRequired",
          },
        });
        await context.emit(event);
      };

      const emitFailureLifecycleNotification = async (params: {
        dedupeToken: string;
        subject: string;
        waitSec?: number;
        outcome: "allow" | "reject" | "cancelled" | "unknown";
        reason: "approval" | "command";
        exitCode?: number;
      }): Promise<void> => {
        const waitText =
          typeof params.waitSec === "number" && Number.isFinite(params.waitSec)
            ? `，等待 ${(Math.max(0, params.waitSec)).toFixed(1)}s`
            : "";
        if (params.outcome === "allow") {
          return;
        }
        const stopEventName = "StopFailure";
        const stopTitle = "Qoder: 任务异常终止";
        const stopBody =
          params.reason === "approval"
            ? `${params.subject} 已处理同意请求${waitText}`
            : `${params.subject} 执行结束（退出码 ${params.exitCode ?? 1}）${waitText}`;
        const commonMeta = {
          subject: params.subject,
          waitSec: params.waitSec,
          outcome: params.outcome,
          reason: params.reason,
        };
        await context.emit(
          createNotifyEvent({
            source: "qoder-log",
            editor: "qoder",
            level: "error",
            title: stopTitle,
            body: stopBody,
            dedupeKey: `qoder-log:lifecycle:${stopEventName}:${params.dedupeToken}`,
            meta: {
              ...commonMeta,
              eventName: stopEventName,
            },
          }),
        );
      };

      const emitSessionEndNotification = async (params: {
        dedupeToken: string;
        subject?: string;
      }): Promise<void> => {
        await context.emit(
          createNotifyEvent({
            source: "qoder-log",
            editor: "qoder",
            level: "info",
            title: "Qoder: 会话已结束",
            body: params.subject ? `${params.subject} 会话已结束` : "Qoder 会话已结束",
            dedupeKey: `qoder-log:lifecycle:SessionEnd:${params.dedupeToken}`,
            meta: {
              eventName: "SessionEnd",
              subject: params.subject,
            },
          }),
        );
      };

      const handleSignal = async (signal: QoderLogSignal): Promise<void> => {
        if (signal.type === "agent_session_end") {
          const dedupeToken =
            signal.sessionId ||
            (typeof signal.logTimestampSec === "number" && Number.isFinite(signal.logTimestampSec)
              ? String(signal.logTimestampSec)
              : String(Math.floor(Date.now() / 1000)));
          emitSessionEndNotification({
            dedupeToken,
            ...(signal.sessionId ? { subject: `session ${signal.sessionId}` } : {}),
          }).catch((error) => {
            logger.error("qoder session end notify failed", { error: String(error) });
          });
          return;
        }
        
        if (signal.type === "agent_suspended") {
          logger.debug("qoder agent suspended for permission request");
          return;
        }

        if (signal.type === "agent_resumed") {
          logger.debug("qoder agent resumed");
          return;
        }

        if (signal.type === "permission_requested") {
          const existing = pendingRequests.get(signal.toolCallId);
          if (existing) {
            clearTimeout(existing.notifyTimer);
          }
          const notifyTimer = setTimeout(() => {
            const pending = pendingRequests.get(signal.toolCallId);
            if (!pending) {
              return;
            }
            emitWaitingNotification(signal.toolCallId, pending.toolName).catch((error) => {
              logger.error("qoder log notify failed", { error: String(error) });
            });
          }, WAIT_NOTIFY_DELAY_MS);

          pendingRequests.set(signal.toolCallId, {
            toolName: signal.toolName,
            requestLogSec: signal.logTimestampSec,
            notifyTimer,
          });
          return;
        }

        if (signal.type === "permission_resolved") {
          const pending = pendingRequests.get(signal.toolCallId);
          if (pending) {
            clearTimeout(pending.notifyTimer);
            const waitSec =
              typeof pending.requestLogSec === "number" && typeof signal.logTimestampSec === "number"
                ? signal.logTimestampSec - pending.requestLogSec
                : undefined;

            if (typeof waitSec === "number" && waitSec >= WAIT_THRESHOLD_SEC) {
              logger.info("qoder permission waited", {
                toolCallId: signal.toolCallId,
                toolName: pending.toolName,
                waitSec,
                outcome: signal.outcome,
              });
            }
            emitFailureLifecycleNotification({
              dedupeToken: signal.toolCallId,
              subject: pending.toolName || "tool",
              ...(typeof waitSec === "number" ? { waitSec } : {}),
              outcome: signal.outcome,
              reason: "approval",
            }).catch((error) => {
              logger.error("qoder lifecycle notify failed", { error: String(error) });
            });
            pendingRequests.delete(signal.toolCallId);
          }
          return;
        }

        const now = Date.now();
        for (const [key, ts] of recentCompletionKeys.entries()) {
          if (now - ts > COMPLETION_DEDUPE_WINDOW_MS) {
            recentCompletionKeys.delete(key);
          }
        }
        const timePart =
          typeof signal.logTimestampSec === "number" && Number.isFinite(signal.logTimestampSec)
            ? String(signal.logTimestampSec)
            : String(Math.floor(now / 1000));
        const commandPart = signal.command?.trim() || "unknown-command";
        const completionKey = `${timePart}:${commandPart}:${signal.exitCode}`;
        if (recentCompletionKeys.has(completionKey)) {
          return;
        }
        recentCompletionKeys.set(completionKey, now);
        const outcome = signal.exitCode === 0 ? "allow" : "reject";
        emitFailureLifecycleNotification({
          dedupeToken: completionKey,
          subject: signal.command || "terminal 命令",
          outcome,
          reason: "command",
          exitCode: signal.exitCode,
        }).catch((error) => {
          logger.error("qoder lifecycle notify failed", { error: String(error) });
        });
      };

      const ingestLine = async (line: string): Promise<void> => {
        const signal = parseQoderLogLine(line);
        if (!signal) {
          return;
        }
        await handleSignal(signal);
      };

      const discoverLogs = (): void => {
        const paths = resolveQoderLogPaths(context.config.qoderLogPath);
        for (const logPath of paths) {
          if (!cursors.has(logPath) && existsSync(logPath)) {
            const size = statSync(logPath).size;
            // tail -n 0 behavior: only consume newly appended lines
            cursors.set(logPath, { cursor: size });
            logger.info("qoder log adapter tracking file", { path: logPath });
          }
        }
      };

      const readDelta = async (logPath: string, state: FileCursor): Promise<void> => {
        if (!existsSync(logPath)) {
          cursors.delete(logPath);
          return;
        }
        const size = statSync(logPath).size;
        if (size < state.cursor) {
          state.cursor = 0;
        }
        if (size === state.cursor) {
          return;
        }

        const stream = createReadStream(logPath, {
          start: state.cursor,
          end: size - 1,
          encoding: "utf-8",
        });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of lines) {
          await ingestLine(line);
        }
        state.cursor = size;
      };

      const pollLogs = async (): Promise<void> => {
        if (reading) {
          return;
        }
        reading = true;
        try {
          for (const [logPath, state] of cursors.entries()) {
            await readDelta(logPath, state);
          }
        } finally {
          reading = false;
        }
      };

      discoverLogs();
      if (cursors.size === 0) {
        logger.info("qoder log adapter: no agent.log found yet");
      }

      filePollTimer = setInterval(() => {
        pollLogs().catch((error) => {
          logger.error("qoder log polling failed", { error: String(error) });
        });
      }, FILE_POLL_MS);

      discoveryPollTimer = setInterval(() => {
        discoverLogs();
      }, DISCOVERY_POLL_MS);

      const stop: AdapterStop = () => {
        if (filePollTimer) {
          clearInterval(filePollTimer);
        }
        if (discoveryPollTimer) {
          clearInterval(discoveryPollTimer);
        }
        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.notifyTimer);
        }
        pendingRequests.clear();
        recentCompletionKeys.clear();
      };

      return stop;
    },
  };
}
