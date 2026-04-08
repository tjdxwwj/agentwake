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
});

export type CursorTerminalSignal = {
  hookEvent: "beforeShellExecution" | "afterShellExecution";
  command: string;
  cwd?: string;
  conversationId?: string;
  generationId?: string;
  timestampMs: number;
  explicitApproval: boolean;
  durationMs?: number;
};

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
  return {
    hookEvent,
    command,
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
    ...(payload.conversation_id ? { conversationId: payload.conversation_id } : {}),
    ...(payload.generation_id ? { generationId: payload.generation_id } : {}),
    timestampMs: Date.now(),
    explicitApproval: resolveExplicitApproval(payload),
    ...(typeof payload.duration === "number" ? { durationMs: payload.duration } : {}),
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
    source: "cursor-hook",
    editor: "cursor",
    level: "warn",
    title: "Cursor 终端等待用户同意",
    body: bodyText,
    dedupeKey: `cursor:approval:${resolveCursorSignalKey(signal)}`,
    meta: {
      hookEvent: signal.hookEvent,
      command: signal.command,
      cwd: signal.cwd,
      conversationId: signal.conversationId,
      generationId: signal.generationId,
      reason: params.reason,
      waitMs: params.waitMs,
      explicitApproval: signal.explicitApproval,
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
