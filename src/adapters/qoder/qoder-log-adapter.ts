import { createReadStream, existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createNotifyEvent } from "../../domain/notify-event";
import type { AdapterStop, GatewayAdapter } from "../../gateway/adapter";
import { logger } from "../../utils/logger";

export type QoderLogSignal =
  | {
      type: "command_started";
      command: string;
      toolCallId?: string;
      logTimestampSec: number | undefined;
    }
  | {
      type: "command_completed";
      command: string | undefined;
      toolCallId?: string;
      exitCode: number;
      logTimestampSec: number | undefined;
    }
  | {
      type: "agent_session_start";
      logTimestampSec: number | undefined;
      sessionId: string | undefined;
    }
  | {
      type: "agent_session_end";
      logTimestampSec: number | undefined;
      sessionId: string | undefined;
    }
  | {
      type: "approval_requested";
      logTimestampSec: number | undefined;
      toolCallId?: string;
      toolName?: string;
    };

type FileCursor = {
  cursor: number;
};

type PendingCommandProbe = {
  command: string;
  startedAtMs: number;
  notifyTimer: ReturnType<typeof setTimeout>;
};

export type QoderRunConfig = {
  commandAllowlist: string[];
  commandDenylist: string[];
  loadedAtMs: number;
  sourcePath?: string;
};

const FILE_POLL_MS = 500;
const DISCOVERY_POLL_MS = 5_000;
const COMPLETION_DEDUPE_WINDOW_MS = 3_000;
const WAIT_NO_AFTER_DELAY_MS = 4_000;
const QODER_USER_SETTINGS_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Qoder",
  "User",
  "settings.json",
);

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

function extractExitCode(line: string): number | undefined {
  const match = line.match(/exitCode[:=]\s*(-?\d+)/i);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function extractToolCallId(line: string): string | undefined {
  const match = line.match(/toolCallId[=:]["']?([^,"'\s}]+)/i);
  return match?.[1]?.trim() || undefined;
}

function extractToolName(line: string): string | undefined {
  const match = line.match(/toolName[=:]["']?([^,"'\s}]+)/i);
  return match?.[1]?.trim() || undefined;
}

function extractStartedCommand(line: string): string | undefined {
  const byQuotedCommand = line.match(/command="([^"]+)"/i);
  if (byQuotedCommand?.[1]) {
    return byQuotedCommand[1].trim();
  }
  const byRunning = line.match(/Running command:\s*(.+)$/i);
  if (byRunning?.[1]?.trim()) {
    return byRunning[1].trim();
  }
  const byExecution = line.match(/Starting command execution:\s*(.+)$/i);
  const fallback = byExecution?.[1]?.trim();
  return fallback && fallback.length > 0 ? fallback : undefined;
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

function splitCommaList(raw: unknown): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function createDefaultQoderRunConfig(): QoderRunConfig {
  return {
    commandAllowlist: [],
    commandDenylist: [],
    loadedAtMs: 0,
  };
}

export function parseQoderRunConfigFromSettings(rawJson: string): QoderRunConfig {
  const fallback = createDefaultQoderRunConfig();
  try {
    const parsed = JSON.parse(rawJson) as {
      app?: {
        configChatCommandAllowlist?: unknown;
        configChatCommandDenyList?: unknown;
      };
    };
    const app = parsed?.app;
    if (!app || typeof app !== "object") {
      return fallback;
    }
    return {
      commandAllowlist: splitCommaList(app.configChatCommandAllowlist),
      commandDenylist: splitCommaList(app.configChatCommandDenyList),
      loadedAtMs: Date.now(),
    };
  } catch {
    return fallback;
  }
}

export function loadQoderRunConfig(settingsPath = QODER_USER_SETTINGS_PATH): QoderRunConfig {
  try {
    if (!existsSync(settingsPath)) {
      return createDefaultQoderRunConfig();
    }
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = parseQoderRunConfigFromSettings(raw);
    return {
      ...parsed,
      sourcePath: settingsPath,
    };
  } catch {
    return createDefaultQoderRunConfig();
  }
}

function normalizeCommand(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function commandMatchesRule(command: string, rule: string): boolean {
  const normalizedRule = normalizeCommand(rule);
  if (!normalizedRule) {
    return false;
  }
  if (normalizedRule.endsWith("*")) {
    const prefix = normalizedRule.slice(0, -1).trimEnd();
    return prefix.length > 0 && command.startsWith(prefix);
  }
  return (
    command === normalizedRule ||
    command.startsWith(`${normalizedRule} `) ||
    command.startsWith(`${normalizedRule}/`)
  );
}

/** True if command matches any entry in the list (same matching rules as Qoder UI). */
export function commandMatchesRuleList(command: string, rules: string[]): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }
  return rules.some((rule) => commandMatchesRule(normalizedCommand, rule));
}

/**
 * Pending 通知与完成事件对齐用的 key：优先 toolCallId（日志里常见），否则退回整段 command。
 * 完成日志若只带其一，clearPendingProbesForCompletion 会两种 key 都尝试清理。
 */
export function qoderLogPendingProbeKey(command: string, toolCallId: string | undefined): string {
  const id = toolCallId?.trim();
  if (id) {
    return `tc:${id}`;
  }
  return command.trim();
}

/** Completion 去重 key：优先 toolCallId，其次 command，最后使用时间+exitCode 兜底。 */
export function qoderCompletionDedupeKeys(
  signal: Extract<QoderLogSignal, { type: "command_completed" }>,
  nowMs = Date.now(),
): string[] {
  const keys: string[] = [];
  const exitPart = String(signal.exitCode);
  const toolCallId = signal.toolCallId?.trim();
  if (toolCallId) {
    keys.push(`tc:${toolCallId}:${exitPart}`);
  }
  const command = signal.command?.trim();
  if (command) {
    keys.push(`cmd:${normalizeCommand(command)}:${exitPart}`);
  }
  const timePart =
    typeof signal.logTimestampSec === "number" && Number.isFinite(signal.logTimestampSec)
      ? String(signal.logTimestampSec)
      : String(Math.floor(nowMs / 1000));
  keys.push(`sec:${timePart}:exit:${exitPart}`);
  return keys;
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

  if (/Running command:|Starting command execution:/i.test(text)) {
    const command = extractStartedCommand(text);
    const toolCallId = extractToolCallId(text);
    if (!command) {
      return null;
    }
    return {
      type: "command_started",
      command,
      ...(toolCallId ? { toolCallId } : {}),
      logTimestampSec: extractLogTimestampSec(text),
    };
  }

  if (/Tool permission requested/i.test(text)) {
    const toolCallId = extractToolCallId(text);
    const toolName = extractToolName(text);
    return {
      type: "approval_requested",
      logTimestampSec: extractLogTimestampSec(text),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
    };
  }

  if (/Command finished via end event|Command execution completed|Command completed|Temporary command completed/i.test(text)) {
    const exitCode = extractExitCode(text);
    if (typeof exitCode !== "number") {
      return null;
    }
    const toolCallIdDone = extractToolCallId(text);
    return {
      type: "command_completed",
      command: extractCompletedCommand(text),
      exitCode,
      logTimestampSec: extractLogTimestampSec(text),
      ...(toolCallIdDone ? { toolCallId: toolCallIdDone } : {}),
    };
  }

  if (/session started|session created|Created tab:/i.test(text)) {
    return {
      type: "agent_session_start",
      logTimestampSec: extractLogTimestampSec(text),
      sessionId: extractSessionId(text),
    };
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

  return null;
}

export function createQoderLogAdapter(): GatewayAdapter {
  return {
    id: "qoder-log-adapter",
    async start(context) {
      if (context.config.qoderAdapterEnabled === false) {
        logger.info("qoder log adapter disabled by config");
        return () => {};
      }
      const enabledEvents = new Set(context.config.qoderEnabledEvents);
      const isQoderEventEnabled = (eventName: string): boolean => enabledEvents.has(eventName);
      const recentCompletionKeys = new Map<string, number>();
      const pendingCommandProbes = new Map<string, PendingCommandProbe>();
      const startedCommandsByToolCallId = new Map<string, string>();
      const cursors = new Map<string, FileCursor>();
      let filePollTimer: ReturnType<typeof setInterval> | undefined;
      let discoveryPollTimer: ReturnType<typeof setInterval> | undefined;
      let reading = false;
      let qoderRunConfig = createDefaultQoderRunConfig();

      const refreshQoderRunConfig = (reason: string): void => {
        qoderRunConfig = loadQoderRunConfig();
        logger.info("qoder run config refreshed", {
          reason,
          allowlistCount: qoderRunConfig.commandAllowlist.length,
          denylistCount: qoderRunConfig.commandDenylist.length,
          sourcePath: qoderRunConfig.sourcePath,
        });
      };

      const emitStopLifecycleNotification = async (params: {
        dedupeToken: string;
        subject: string;
        outcome: "allow" | "reject";
        exitCode?: number;
      }): Promise<void> => {
        const stopEventName = params.outcome === "allow" ? "Stop" : "StopFailure";
        if (!isQoderEventEnabled(stopEventName)) {
          return;
        }
        const stopTitle = stopEventName === "Stop" ? "Qoder: 任务完成" : "Qoder: 任务异常终止";
        const stopBody = `${params.subject} 执行结束（退出码 ${params.exitCode ?? 1}）\n来源: qoder-log`;
        await context.emit(
          createNotifyEvent({
            source: "qoder-log",
            editor: "qoder",
            level: stopEventName === "Stop" ? "info" : "error",
            title: stopTitle,
            body: stopBody,
            dedupeKey: `qoder-log:lifecycle:${stopEventName}:${params.dedupeToken}`,
            meta: {
              subject: params.subject,
              outcome: params.outcome,
              reason: "command",
              eventName: stopEventName,
            },
          }),
        );
      };

      const cleanupPendingCommandProbe = (key: string): void => {
        const pending = pendingCommandProbes.get(key);
        if (!pending) {
          return;
        }
        clearTimeout(pending.notifyTimer);
        pendingCommandProbes.delete(key);
      };

      /** 完成行可能只带 command 或只带 toolCallId，与开始行对齐时两种 key 都尝试取消延迟提醒。 */
      const clearPendingProbesForCompletion = (signal: {
        command?: string | undefined;
        toolCallId?: string | undefined;
      }): void => {
        const id = signal.toolCallId?.trim();
        const cmd = signal.command?.trim();
        if (id) {
          cleanupPendingCommandProbe(`tc:${id}`);
        }
        if (cmd) {
          cleanupPendingCommandProbe(cmd);
        }
      };

      const emitQoderApprovalNotification = async (params: {
        probeKey: string;
        command: string;
        reasonLine: string;
        meta: Record<string, unknown>;
      }): Promise<void> => {
        if (!isQoderEventEnabled("Notification")) {
          return;
        }
        await context.emit(
          createNotifyEvent({
            source: "qoder-log",
            editor: "qoder",
            level: "warn",
            title: "Qoder 终端等待用户同意",
            body: `命令: ${params.command}\n${params.reasonLine}\n来源: qoder-log`,
            dedupeKey: `qoder-log:lifecycle:Notification:${params.probeKey}`,
            meta: {
              eventName: "Notification",
              command: params.command,
              ...params.meta,
            },
          }),
        );
      };

      const schedulePendingCommandProbe = (params: { key: string; command: string }): void => {
        cleanupPendingCommandProbe(params.key);
        const startedAtMs = Date.now();
        const notifyTimer = setTimeout(() => {
          const pending = pendingCommandProbes.get(params.key);
          if (!pending) {
            return;
          }
          pendingCommandProbes.delete(params.key);
          if (!isQoderEventEnabled("Notification")) {
            return;
          }
          const waitMs = Math.max(0, Date.now() - pending.startedAtMs);
          void context.emit(
            createNotifyEvent({
              source: "qoder-log",
              editor: "qoder",
              level: "warn",
              title: "Qoder 终端等待用户同意",
              body: `命令: ${pending.command}\n原因: 既未命中 allowlist 也未命中 denylist，4s 内未见结束则提醒\n等待时长: ${(waitMs / 1000).toFixed(1)}s\n来源: qoder-log`,
              dedupeKey: `qoder-log:lifecycle:Notification:${params.key}`,
              meta: {
                eventName: "Notification",
                command: pending.command,
                reason: "not-in-allowlist-or-denylist-after-4s",
                waitMs,
              },
            }),
          ).catch((error) => {
            logger.error("qoder delayed notification failed", { error: String(error) });
          });
        }, WAIT_NO_AFTER_DELAY_MS);
        pendingCommandProbes.set(params.key, {
          command: params.command,
          startedAtMs,
          notifyTimer,
        });
      };

      const emitSessionStartNotification = async (params: {
        dedupeToken: string;
        subject?: string;
      }): Promise<void> => {
        if (!isQoderEventEnabled("SessionStart")) {
          return;
        }
        await context.emit(
          createNotifyEvent({
            source: "qoder-log",
            editor: "qoder",
            level: "info",
            title: "Qoder: 会话已开始",
            body: params.subject ? `${params.subject} 会话已开始\n来源: qoder-log` : "Qoder 会话已开始\n来源: qoder-log",
            dedupeKey: `qoder-log:lifecycle:SessionStart:${params.dedupeToken}`,
            meta: {
              eventName: "SessionStart",
              subject: params.subject,
            },
          }),
        );
      };

      const emitSessionEndNotification = async (params: {
        dedupeToken: string;
        subject?: string;
      }): Promise<void> => {
        if (!isQoderEventEnabled("SessionEnd")) {
          return;
        }
        await context.emit(
          createNotifyEvent({
            source: "qoder-log",
            editor: "qoder",
            level: "info",
            title: "Qoder: 会话已结束",
            body: params.subject ? `${params.subject} 会话已结束\n来源: qoder-log` : "Qoder 会话已结束\n来源: qoder-log",
            dedupeKey: `qoder-log:lifecycle:SessionEnd:${params.dedupeToken}`,
            meta: {
              eventName: "SessionEnd",
              subject: params.subject,
            },
          }),
        );
      };

      const handleSignal = async (signal: QoderLogSignal): Promise<void> => {
        if (signal.type === "command_started") {
          refreshQoderRunConfig("command-start-realtime");
          const probeKey = qoderLogPendingProbeKey(signal.command, signal.toolCallId);
          const startedToolCallId = signal.toolCallId?.trim();
          if (startedToolCallId) {
            startedCommandsByToolCallId.set(startedToolCallId, signal.command);
          }
          if (!probeKey) {
            return;
          }

          // 1) Denylist hit → immediate notification
          if (commandMatchesRuleList(signal.command, qoderRunConfig.commandDenylist)) {
            await emitQoderApprovalNotification({
              probeKey,
              command: signal.command,
              reasonLine: "原因: 命中 denylist",
              meta: { reason: "denylist-hit" },
            });
            return;
          }

          // 2) Allowlist hit → no command_start notification
          if (commandMatchesRuleList(signal.command, qoderRunConfig.commandAllowlist)) {
            return;
          }

          // 3) Neither list → delayed notification if the command does not complete within 4s
          schedulePendingCommandProbe({
            key: probeKey,
            command: signal.command,
          });
          return;
        }

        if (signal.type === "approval_requested") {
          const toolCallId = signal.toolCallId?.trim();
          if (!toolCallId) {
            return;
          }
          const probeKey = `tc:${toolCallId}`;
          const pending = pendingCommandProbes.get(probeKey);
          const command =
            pending?.command ??
            startedCommandsByToolCallId.get(toolCallId) ??
            (signal.toolName ? `${signal.toolName} (toolCallId=${toolCallId})` : `toolCallId=${toolCallId}`);
          cleanupPendingCommandProbe(probeKey);
          await emitQoderApprovalNotification({
            probeKey,
            command,
            reasonLine: signal.toolName ? `原因: Qoder 请求工具授权（${signal.toolName}）` : "原因: Qoder 请求工具授权",
            meta: {
              reason: "permission-requested",
              toolCallId,
              toolName: signal.toolName,
            },
          });
          return;
        }

        if (signal.type === "agent_session_start") {
          const dedupeToken =
            signal.sessionId ||
            (typeof signal.logTimestampSec === "number" && Number.isFinite(signal.logTimestampSec)
              ? String(signal.logTimestampSec)
              : String(Math.floor(Date.now() / 1000)));
          emitSessionStartNotification({
            dedupeToken,
            ...(signal.sessionId ? { subject: `session ${signal.sessionId}` } : {}),
          }).catch((error) => {
            logger.error("qoder session start notify failed", { error: String(error) });
          });
          return;
        }

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
        
        clearPendingProbesForCompletion(signal);
        const completedToolCallId = signal.toolCallId?.trim();
        if (completedToolCallId) {
          startedCommandsByToolCallId.delete(completedToolCallId);
        }

        const now = Date.now();
        for (const [key, ts] of recentCompletionKeys.entries()) {
          if (now - ts > COMPLETION_DEDUPE_WINDOW_MS) {
            recentCompletionKeys.delete(key);
          }
        }
        const completionKeys = qoderCompletionDedupeKeys(signal, now);
        if (completionKeys.some((key) => recentCompletionKeys.has(key))) {
          return;
        }
        for (const key of completionKeys) {
          recentCompletionKeys.set(key, now);
        }
        const dedupeToken = completionKeys[0] ?? `sec:${Math.floor(now / 1000)}:exit:${signal.exitCode}`;

        const outcome = signal.exitCode === 0 ? "allow" : "reject";
        emitStopLifecycleNotification({
          dedupeToken,
          subject: signal.command || "terminal 命令",
          outcome,
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

      refreshQoderRunConfig("adapter-start");
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
        refreshQoderRunConfig("periodic");
        discoverLogs();
      }, DISCOVERY_POLL_MS);

      const stop: AdapterStop = () => {
        if (filePollTimer) {
          clearInterval(filePollTimer);
        }
        if (discoveryPollTimer) {
          clearInterval(discoveryPollTimer);
        }
        for (const pending of pendingCommandProbes.values()) {
          clearTimeout(pending.notifyTimer);
        }
        pendingCommandProbes.clear();
        startedCommandsByToolCallId.clear();
        recentCompletionKeys.clear();
      };

      return stop;
    },
  };
}
