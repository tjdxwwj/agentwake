import { z } from "zod";
import { createNotifyEvent, type NotifyEvent } from "../domain/notify-event";

const cursorTerminalSchema = z.object({
  hook_event_name: z.string().optional(),
  conversation_id: z.string().optional(),
  session_id: z.string().optional(),
  generation_id: z.string().optional(),
  command: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_output: z.string().optional(),
  tool_use_id: z.string().optional(),
  cwd: z.string().optional(),
  status: z.string().optional(),
  state: z.string().optional(),
  loop_count: z.number().optional(),
  is_background_agent: z.boolean().optional(),
  composer_mode: z.string().optional(),
  message: z.string().optional(),
  userMessage: z.string().optional(),
  agentMessage: z.string().optional(),
  reason: z.string().optional(),
  model: z.string().optional(),
  final_status: z.string().optional(),
  error_message: z.string().optional(),
  failure_type: z.string().optional(),
  is_interrupt: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  pendingApproval: z.boolean().optional(),
  permission: z.string().optional(),
  decision: z.string().optional(),
  continue: z.boolean().optional(),
  exit_code: z.number().optional(),
  duration: z.number().optional(),
  duration_ms: z.number().optional(),
  output: z.string().optional(),
  sandbox: z.boolean().optional(),
  workspace_roots: z.array(z.string()).optional(),
  agent_marker: z.enum(["cursor", "qoder"]).optional(),
  cursor_agent: z.boolean().optional(),
  qoder_agent: z.boolean().optional(),
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
  output?: string;
  sandbox?: boolean;
  status?: string;
  state?: string;
  agentMarker?: "cursor" | "qoder";
};

type CursorLifecycleEventName =
  | "Notification"
  | "Stop"
  | "StopFailure"
  | "SessionEnd"
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure";

const CURSOR_LIFECYCLE_EVENT_LEVEL: Record<CursorLifecycleEventName, "info" | "warn" | "error"> = {
  Notification: "warn",
  Stop: "info",
  StopFailure: "error",
  SessionEnd: "info",
  SessionStart: "info",
  PreToolUse: "info",
  PostToolUse: "info",
  PostToolUseFailure: "error",
};

function normalizeLifecycleEventName(raw: string | undefined): CursorLifecycleEventName | undefined {
  if (!raw) {
    return undefined;
  }
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  const normalized = text.toLowerCase();
  if (normalized === "notification") return "Notification";
  if (normalized === "stop") return "Stop";
  if (normalized === "stopfailure") return "StopFailure";
  if (normalized === "sessionend") return "SessionEnd";
  if (normalized === "sessionstart") return "SessionStart";
  if (normalized === "pretooluse") return "PreToolUse";
  if (normalized === "posttooluse") return "PostToolUse";
  if (normalized === "posttoolusefailure") return "PostToolUseFailure";
  return undefined;
}

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

export function hasExplicitApprovalSignal(payload: {
  requiresApproval?: boolean | undefined;
  approvalRequired?: boolean | undefined;
  pendingApproval?: boolean | undefined;
  permission?: string | undefined;
  decision?: string | undefined;
}): boolean {
  const permission = String(payload.permission ?? "").trim().toLowerCase();
  const decision = String(payload.decision ?? "").trim().toLowerCase();
  return (
    payload.requiresApproval === true ||
    payload.approvalRequired === true ||
    payload.pendingApproval === true ||
    permission === "ask" ||
    decision === "ask"
  );
}

function resolveExplicitApproval(payload: z.infer<typeof cursorTerminalSchema>): boolean {
  return hasExplicitApprovalSignal(payload);
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

function resolveHookEvent(payload: z.infer<typeof cursorTerminalSchema>): "beforeShellExecution" | "afterShellExecution" | null {
  const rawEvent = payload.hook_event_name?.trim();
  if (rawEvent === "beforeShellExecution" || rawEvent === "afterShellExecution") {
    return rawEvent;
  }
  return null;
}

export function parseCursorTerminalSignal(body: unknown): CursorTerminalSignal | null {
  const parsed = cursorTerminalSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const payload = parsed.data;
  const hookEvent = resolveHookEvent(payload);
  if (!hookEvent) {
    return null;
  }
  const command = payload.command?.trim();
  if (!command) {
    return null;
  }
  const agentMarker = resolveAgentMarker(payload);
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
    ...(typeof payload.output === "string" ? { output: payload.output } : {}),
    ...(typeof payload.sandbox === "boolean" ? { sandbox: payload.sandbox } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.state ? { state: payload.state } : {}),
    ...(agentMarker ? { agentMarker } : {}),
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
      eventName: "Notification",
      hookEvent: signal.hookEvent,
      command: signal.command,
      cwd: signal.cwd,
      conversationId: signal.conversationId,
      generationId: signal.generationId,
      reason: params.reason,
      waitMs: params.waitMs,
      explicitApproval: signal.explicitApproval,
      agentMarker: signal.agentMarker,
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
    output: signal.output,
    sandbox: signal.sandbox,
    agentMarker: signal.agentMarker,
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
  return parseCursorLifecycleHookEventInternal(body, "SessionEnd");
}

function resolveLifecycleContext(payload: z.infer<typeof cursorTerminalSchema>): {
  source: "cursor-hook" | "qoder-hook";
  editor: "cursor" | "qoder";
  baseTitle: "Cursor" | "Qoder";
  agentMarker: "cursor" | "qoder" | undefined;
} {
  const agentMarker = resolveAgentMarker(payload);
  const isQoderSignal = agentMarker === "qoder";
  return {
    source: isQoderSignal ? "qoder-hook" : "cursor-hook",
    editor: isQoderSignal ? "qoder" : "cursor",
    baseTitle: isQoderSignal ? "Qoder" : "Cursor",
    agentMarker,
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable-tool-input]";
  }
}

function parseCursorLifecycleHookEventInternal(
  body: unknown,
  expectedEventName?: CursorLifecycleEventName,
): NotifyEvent | null {
  const parsed = cursorTerminalSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const payload = parsed.data;
  const hookEvent = normalizeLifecycleEventName(payload.hook_event_name);
  if (!hookEvent) {
    return null;
  }
  if (expectedEventName && hookEvent !== expectedEventName) {
    return null;
  }
  const { source, editor, baseTitle, agentMarker } = resolveLifecycleContext(payload);
  const sessionKey =
    [
      payload.conversation_id,
      payload.session_id,
      payload.generation_id,
      payload.tool_use_id,
      payload.tool_name,
      payload.command,
      payload.cwd,
      payload.message?.slice(0, 80),
      typeof payload.loop_count === "number" ? String(payload.loop_count) : undefined,
    ]
      .map((item) => item?.trim())
      .filter((item): item is string => Boolean(item))
      .join(":") || "unknown";
  const stopStatusToken = payload.status ? `结果: ${payload.status}` : undefined;
  const loopCountToken =
    typeof payload.loop_count === "number" && Number.isFinite(payload.loop_count)
      ? `循环次数: ${payload.loop_count}`
      : undefined;
  const sessionReasonToken = payload.reason ? `结束原因: ${payload.reason}` : undefined;
  const durationToken =
    typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms)
      ? `会话耗时: ${(payload.duration_ms / 1000).toFixed(1)}s`
      : undefined;
  const finalStatusToken = payload.final_status ? `最终状态: ${payload.final_status}` : undefined;
  const errorToken = payload.error_message ? `错误: ${payload.error_message}` : undefined;
  const sessionIdToken = payload.session_id ? `会话ID: ${payload.session_id}` : undefined;
  const backgroundToken =
    typeof payload.is_background_agent === "boolean"
      ? payload.is_background_agent
        ? "后台会话: 是"
        : "后台会话: 否"
      : undefined;
  const composerModeToken = payload.composer_mode ? `模式: ${payload.composer_mode}` : undefined;
  const toolNameToken = payload.tool_name ? `工具: ${payload.tool_name}` : undefined;
  const toolUseIdToken = payload.tool_use_id ? `工具调用ID: ${payload.tool_use_id}` : undefined;
  const toolInputToken = payload.tool_input ? `工具输入: ${safeJsonStringify(payload.tool_input)}` : undefined;
  const toolOutputToken = payload.tool_output ? `工具输出: ${payload.tool_output}` : undefined;
  const modelToken = payload.model ? `模型: ${payload.model}` : undefined;
  const failureTypeToken = payload.failure_type ? `失败类型: ${payload.failure_type}` : undefined;
  const isInterruptToken =
    typeof payload.is_interrupt === "boolean"
      ? payload.is_interrupt
        ? "用户中断: 是"
        : "用户中断: 否"
      : undefined;
  const bodyText =
    compactBody([
      payload.command ? `命令: ${payload.command}` : undefined,
      toolNameToken,
      toolUseIdToken,
      toolInputToken,
      toolOutputToken,
      modelToken,
      payload.message,
      payload.userMessage,
      payload.agentMessage,
      payload.reason,
      stopStatusToken,
      loopCountToken,
      sessionReasonToken,
      durationToken,
      finalStatusToken,
      errorToken,
      failureTypeToken,
      isInterruptToken,
      sessionIdToken,
      backgroundToken,
      composerModeToken,
      payload.status ? `状态: ${payload.status}` : undefined,
      payload.state ? `阶段: ${payload.state}` : undefined,
      payload.cwd ? `目录: ${payload.cwd}` : undefined,
    ]) || `${hookEvent} 事件`;
  const eventTitleMap: Record<CursorLifecycleEventName, string> = {
    Notification: `${baseTitle}: 需要你的注意`,
    Stop: `${baseTitle}: 任务完成`,
    StopFailure: `${baseTitle}: 任务异常终止`,
    SessionEnd: `${baseTitle}: 会话已结束`,
    SessionStart: `${baseTitle}: 会话已开始`,
    PreToolUse: `${baseTitle}: 工具调用前`,
    PostToolUse: `${baseTitle}: 工具调用后`,
    PostToolUseFailure: `${baseTitle}: 工具调用失败`,
  };
  return createNotifyEvent({
    source,
    editor,
    level: CURSOR_LIFECYCLE_EVENT_LEVEL[hookEvent],
    title: eventTitleMap[hookEvent],
    body: bodyText,
    dedupeKey: `${editor}:lifecycle:${hookEvent}:${sessionKey}`,
    meta: {
      eventName: hookEvent,
      hookEvent: payload.hook_event_name,
      conversationId: payload.conversation_id,
      sessionId: payload.session_id,
      generationId: payload.generation_id,
      command: payload.command,
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
      toolOutput: payload.tool_output,
      toolUseId: payload.tool_use_id,
      model: payload.model,
      status: payload.status,
      loopCount: payload.loop_count,
      isBackgroundAgent: payload.is_background_agent,
      composerMode: payload.composer_mode,
      state: payload.state,
      cwd: payload.cwd,
      reason: payload.reason,
      durationMs: payload.duration_ms,
      finalStatus: payload.final_status,
      errorMessage: payload.error_message,
      failureType: payload.failure_type,
      isInterrupt: payload.is_interrupt,
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

export function parseCursorLifecycleHookEvent(body: unknown): NotifyEvent | null {
  return parseCursorLifecycleHookEventInternal(body, undefined);
}
