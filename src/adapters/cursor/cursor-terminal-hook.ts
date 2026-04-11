import type { NotifyEvent } from "../../domain/notify-event";
import {
  createShellApprovalEvent,
  createShellLifecycleStopEvents,
  hasExplicitApprovalSignal,
  isPotentiallyDangerousCommand,
  parseShellLifecycleHookEvent,
  parseShellSessionEndEvent,
  parseShellTerminalHookEvent,
  parseShellTerminalSignal,
  resolveShellSignalKey,
  type ShellTerminalSignal,
} from "../shared/terminal-hook-shared";

export type CursorTerminalSignal = ShellTerminalSignal;

export { hasExplicitApprovalSignal, isPotentiallyDangerousCommand };

export function parseCursorTerminalSignal(body: unknown): CursorTerminalSignal | null {
  return parseShellTerminalSignal(body);
}

export function resolveCursorSignalKey(signal: CursorTerminalSignal): string {
  return resolveShellSignalKey(signal);
}

export function createCursorApprovalEvent(params: {
  signal: CursorTerminalSignal;
  reason?: string;
  waitMs?: number;
}): NotifyEvent {
  return createShellApprovalEvent({ ...params, editor: "cursor" });
}

export function createCursorLifecycleEvents(params: { signal: CursorTerminalSignal }): NotifyEvent[] {
  return createShellLifecycleStopEvents({ signal: params.signal, editor: "cursor" });
}

export function parseCursorSessionEndEvent(body: unknown): NotifyEvent | null {
  return parseShellSessionEndEvent(body, "cursor");
}

export function parseCursorLifecycleHookEvent(body: unknown): NotifyEvent | null {
  return parseShellLifecycleHookEvent(body, "cursor");
}

export function parseCursorTerminalHookEvent(body: unknown): NotifyEvent | null {
  return parseShellTerminalHookEvent(body, "cursor");
}
