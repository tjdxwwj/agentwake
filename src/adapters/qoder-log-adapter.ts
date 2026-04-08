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
      type: "agent_suspended";
    }
  | {
      type: "agent_resumed";
    };

type PendingRequest = {
  toolName: string;
  requestLogSec: number | undefined;
  notifyTimer: ReturnType<typeof setTimeout>;
};

type FileCursor = {
  cursor: number;
};

const REQUEST_NOTIFY_DELAY_MS = 1_000;
const WAIT_THRESHOLD_SEC = 2;
const WAIT_THRESHOLD_MS = WAIT_THRESHOLD_SEC * 1_000;
const FILE_POLL_MS = 500;
const DISCOVERY_POLL_MS = 5_000;

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
    if (!existsSync(configPath)) {
      return [];
    }
    const stats = statSync(configPath);
    if (stats.isFile()) {
      return [configPath];
    }
    if (stats.isDirectory()) {
      return collectAgentLogsRecursively(configPath);
    }
    return [];
  }

  const qoderBase = path.join(os.homedir(), "Library", "Application Support", "Qoder", "logs");
  const latestSessionDir = findLatestQoderSessionDir(qoderBase);
  if (!latestSessionDir) {
    return [];
  }
  return collectAgentLogsRecursively(latestSessionDir);
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

  if (/streaming -> suspended.*permission_request/i.test(text)) {
    return { type: "agent_suspended" };
  }

  if (/suspended -> (streaming|cancelled)/i.test(text)) {
    return { type: "agent_resumed" };
  }

  return null;
}

export function createQoderLogAdapter(): GatewayAdapter {
  return {
    id: "qoder-log-adapter",
    async start(context) {
      const pendingRequests = new Map<string, PendingRequest>();
      const cursors = new Map<string, FileCursor>();
      let filePollTimer: ReturnType<typeof setInterval> | undefined;
      let discoveryPollTimer: ReturnType<typeof setInterval> | undefined;
      let reading = false;

      const emitWaitingNotification = async (toolCallId: string, toolName: string): Promise<void> => {
        const event: NotifyEvent = createNotifyEvent({
          source: "qoder-log",
          editor: "qoder",
          level: "warn",
          title: "Qoder waiting for approval",
          body: `${toolName || "tool"} waiting for your approval`,
          dedupeKey: `qoder-log:pending:${toolCallId}`,
          meta: {
            toolCallId,
            toolName,
          },
        });
        await context.emit(event);
      };

      const handleSignal = async (signal: QoderLogSignal): Promise<void> => {
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
          }, Math.max(REQUEST_NOTIFY_DELAY_MS, WAIT_THRESHOLD_MS));

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
            pendingRequests.delete(signal.toolCallId);
          }
          return;
        }

        if (signal.type === "agent_suspended") {
          logger.debug("qoder agent suspended for permission request");
          return;
        }

        logger.debug("qoder agent resumed");
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
      };

      return stop;
    },
  };
}
