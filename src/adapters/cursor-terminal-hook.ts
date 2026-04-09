import { z } from "zod";
import { createNotifyEvent, type NotifyEvent } from "../domain/notify-event";
import { isApprovalWaitingText } from "../utils/approval-match";

const cursorTerminalSchema = z.object({
  hook_event_name: z.string().optional(),
  conversation_id: z.string().optional(),
  generation_id: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
  message: z.string().optional(),
  userMessage: z.string().optional(),
  agentMessage: z.string().optional(),
  reason: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  pendingApproval: z.boolean().optional(),
  permission: z.string().optional(),
  decision: z.string().optional(),
  continue: z.boolean().optional(),
  exit_code: z.number().optional(),
  duration: z.number().optional(),
  output: z.string().optional(),
  sandbox: z.boolean().optional(),
  workspace_roots: z.array(z.string()).optional(),
  agent_marker: z.enum(["cursor", "qoder"]).optional(),
  cursor_agent: z.boolean().optional(),
  qoder_agent: z.boolean().optional(),
  has_child_process: z.boolean().optional(),
  parent_child_count: z.number().optional(),
  parent_pid: z.number().optional(),
});

const DANGEROUS_COMMAND_PATTERNS = [/\brm\s+-rf\s+\/(?!tmp\b)/i, /\bsudo\b/i, /\bchmod\s+-R\s+777\b/i];

export type CursorTerminalSignal = {
  hookEvent: "beforeShellExecution" | "afterShellExecution";
  command: string;
  cwd?: string;
  conversationId?: string;
  generationId?: string;
  timestampMs: number;
  explicitApproval: boolean;
  durationMs?: number;
  exitCode?: number;
  status?: string;
  state?: string;
  agentMarker?: "cursor" | "qoder";
  hasChildProcess?: boolean;
  parentChildCount?: number;
  parentPid?: number;
};

export function isPotentiallyDangerousCommand(command: string): boolean {
  const text = command.trim();
  if (!text) {
    return false;
  }
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

function compactBody(parts: Array<string | undefined>): string {
  return parts
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .join("\n");
}

function resolveExplicitApproval(payload: z.infer<typeof cursorTerminalSchema>): boolean {
  return (
    payload.requiresApproval === true ||
    payload.approvalRequired === true ||
    payload.pendingApproval === true ||
    payload.permission === "ask" ||
    payload.decision === "ask" ||
    payload.state === "awaiting_user_approval" ||
    payload.state === "waiting_for_user_approval" ||
    payload.status === "awaiting_user_approval" ||
    payload.status === "waiting_for_user_approval" ||
    isApprovalWaitingText(payload.message ?? "") ||
    isApprovalWaitingText(payload.userMessage ?? "") ||
    isApprovalWaitingText(payload.agentMessage ?? "") ||
    isApprovalWaitingText(payload.reason ?? "")
  );
}

function resolveAgentMarker(payload: z.infer<typeof cursorTerminalSchema>): "cursor" | "qoder" | undefined {
  if (payload.agent_marker === "cursor" || payload.cursor_agent === true) {
    return "cursor";
  }
  if (payload.agent_marker === "qoder" || payload.qoder_agent === true) {
    return "qoder";
  }
  return undefined;
}

function resolveHasChildProcess(payload: z.infer<typeof cursorTerminalSchema>): boolean | undefined {
  if (typeof payload.has_child_process === "boolean") {
    return payload.has_child_process;
  }
  if (typeof payload.parent_child_count === "number" && Number.isFinite(payload.parent_child_count)) {
    return payload.parent_child_count > 0;
  }
  return undefined;
}

export function parseCursorTerminalSignal(body: unknown): CursorTerminalSignal | null {
  const parsed = cursorTerminalSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const payload = parsed.data;
  const hookEvent = payload.hook_event_name?.trim();
  if (hookEvent !== "beforeShellExecution" && hookEvent !== "afterShellExecution") {
    return null;
  }
  const command = payload.command?.trim();
  if (!command) {
    return null;
  }
  const agentMarker = resolveAgentMarker(payload);
  const hasChildProcess = resolveHasChildProcess(payload);
  const parentChildCount =
    typeof payload.parent_child_count === "number" && Number.isFinite(payload.parent_child_count)
      ? payload.parent_child_count
      : undefined;
  return {
    hookEvent,
    command,
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
    ...(payload.conversation_id ? { conversationId: payload.conversation_id } : {}),
    ...(payload.generation_id ? { generationId: payload.generation_id } : {}),
    timestampMs: Date.now(),
    explicitApproval: resolveExplicitApproval(payload),
    ...(typeof payload.duration === "number" ? { durationMs: payload.duration } : {}),
    ...(typeof payload.exit_code === "number" ? { exitCode: payload.exit_code } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.state ? { state: payload.state } : {}),
    ...(agentMarker ? { agentMarker } : {}),
    ...(typeof hasChildProcess === "boolean" ? { hasChildProcess } : {}),
    ...(typeof parentChildCount === "number" ? { parentChildCount } : {}),
    ...(typeof payload.parent_pid === "number" && Number.isFinite(payload.parent_pid)
      ? { parentPid: payload.parent_pid }
      : {}),
  };
}

export function resolveCursorSignalKey(signal: CursorTerminalSignal): string {
  const idPart = signal.generationId ?? signal.conversationId ?? "unknown";
  return `${idPart}:${signal.command}`;
}

export function createCursorApprovalEvent(params: {
  signal: CursorTerminalSignal;
  reason?: string;
  waitMs?: number;
}): NotifyEvent {
  const { signal } = params;
  const isQoderSignal = signal.agentMarker === "qoder";
  const source = isQoderSignal ? "qoder-hook" : "cursor-hook";
  const editor = isQoderSignal ? "qoder" : "cursor";
  const title = isQoderSignal ? "Qoder 终端等待用户同意" : "Cursor 终端等待用户同意";
  const waitSec =
    typeof params.waitMs === "number" && Number.isFinite(params.waitMs) ? params.waitMs / 1000 : undefined;
  const waitToken = typeof waitSec === "number" ? `${waitSec.toFixed(1)}s` : undefined;
  const bodyText =
    compactBody([
      `命令: ${signal.command}`,
      signal.cwd ? `目录: ${signal.cwd}` : undefined,
      params.reason ? `原因: ${params.reason}` : undefined,
      waitToken ? `等待时长: ${waitToken}` : undefined,
    ]) || signal.command;

  return createNotifyEvent({
    source,
    editor,
    level: "warn",
    title,
    body: bodyText,
    dedupeKey: `${editor}:approval:${resolveCursorSignalKey(signal)}`,
    meta: {
      hookEvent: signal.hookEvent,
      command: signal.command,
      cwd: signal.cwd,
      conversationId: signal.conversationId,
      generationId: signal.generationId,
      reason: params.reason,
      waitMs: params.waitMs,
      explicitApproval: signal.explicitApproval,
      agentMarker: signal.agentMarker,
      hasChildProcess: signal.hasChildProcess,
      parentChildCount: signal.parentChildCount,
      parentPid: signal.parentPid,
    },
  });
}

export function createCursorLifecycleEvents(params: {
  signal: CursorTerminalSignal;
}): NotifyEvent[] {
  const { signal } = params;
  const isQoderSignal = signal.agentMarker === "qoder";
  const source = isQoderSignal ? "qoder-hook" : "cursor-hook";
  const editor = isQoderSignal ? "qoder" : "cursor";
  const baseTitle = isQoderSignal ? "Qoder" : "Cursor";
  const stopEventName = typeof signal.exitCode === "number" && signal.exitCode !== 0 ? "StopFailure" : "Stop";
  const stopTitle = stopEventName === "StopFailure" ? `${baseTitle}: 任务异常终止` : `${baseTitle}: 任务完成`;
  const exitCodeToken = typeof signal.exitCode === "number" ? `退出码: ${signal.exitCode}` : undefined;
  const statusToken = signal.status ? `状态: ${signal.status}` : signal.state ? `状态: ${signal.state}` : undefined;
  const durationToken = typeof signal.durationMs === "number" ? `耗时: ${(signal.durationMs / 1000).toFixed(1)}s` : undefined;
  const bodyText =
    compactBody([
      `命令: ${signal.command}`,
      signal.cwd ? `目录: ${signal.cwd}` : undefined,
      durationToken,
      exitCodeToken,
      statusToken,
    ]) || signal.command;
  const stopLevel = stopEventName === "StopFailure" ? "error" : "info";
  const signalKey = resolveCursorSignalKey(signal);
  if (stopEventName === "Stop") {
    return [];
  }
  const commonMeta = {
    hookEvent: signal.hookEvent,
    command: signal.command,
    cwd: signal.cwd,
    conversationId: signal.conversationId,
    generationId: signal.generationId,
    exitCode: signal.exitCode,
    durationMs: signal.durationMs,
    status: signal.status,
    state: signal.state,
    explicitApproval: signal.explicitApproval,
    agentMarker: signal.agentMarker,
    hasChildProcess: signal.hasChildProcess,
    parentChildCount: signal.parentChildCount,
    parentPid: signal.parentPid,
  };
  return [
    createNotifyEvent({
      source,
      editor,
      level: stopLevel,
      title: stopTitle,
      body: bodyText,
      dedupeKey: `${editor}:lifecycle:${stopEventName}:${signalKey}`,
      meta: {
        ...commonMeta,
        eventName: stopEventName,
      },
    }),
  ];
}

export function parseCursorSessionEndEvent(body: unknown): NotifyEvent | null {
  const parsed = cursorTerminalSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const payload = parsed.data;
  if (payload.hook_event_name?.trim() !== "SessionEnd") {
    return null;
  }
  const agentMarker = resolveAgentMarker(payload);
  const isQoderSignal = agentMarker === "qoder";
  const source = isQoderSignal ? "qoder-hook" : "cursor-hook";
  const editor = isQoderSignal ? "qoder" : "cursor";
  const baseTitle = isQoderSignal ? "Qoder" : "Cursor";
  const sessionKey =
    [payload.conversation_id, payload.generation_id, payload.cwd, payload.message?.slice(0, 80)]
      .map((item) => item?.trim())
      .filter((item): item is string => Boolean(item))
      .join(":") || "unknown";
  const bodyText =
    compactBody([
      payload.message,
      payload.status ? `状态: ${payload.status}` : undefined,
      payload.state ? `阶段: ${payload.state}` : undefined,
      payload.cwd ? `目录: ${payload.cwd}` : undefined,
    ]) || "会话已结束";
  return createNotifyEvent({
    source,
    editor,
    level: "info",
    title: `${baseTitle}: 会话已结束`,
    body: bodyText,
    dedupeKey: `${editor}:lifecycle:SessionEnd:${sessionKey}`,
    meta: {
      eventName: "SessionEnd",
      hookEvent: payload.hook_event_name,
      conversationId: payload.conversation_id,
      generationId: payload.generation_id,
      status: payload.status,
      state: payload.state,
      cwd: payload.cwd,
      agentMarker,
    },
  });
}

export function parseCursorTerminalHookEvent(body: unknown): NotifyEvent | null {
  const signal = parseCursorTerminalSignal(body);
  if (!signal || signal.hookEvent !== "beforeShellExecution" || !signal.explicitApproval) {
    return null;
  }
  return createCursorApprovalEvent({ signal, reason: "explicit-hook-signal" });
}
