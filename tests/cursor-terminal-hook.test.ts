import { describe, expect, it } from "vitest";
import {
  createCursorLifecycleEvents,
  isPotentiallyDangerousCommand,
  parseCursorSessionEndEvent,
  parseCursorTerminalHookEvent,
  parseCursorTerminalSignal,
} from "../src/adapters/cursor-terminal-hook";

describe("parseCursorTerminalHookEvent", () => {
  it("ignores normal beforeShellExecution without approval wait signal", () => {
    const event = parseCursorTerminalHookEvent({
      hook_event_name: "beforeShellExecution",
      command: "git status",
      cwd: "/tmp/project",
      generation_id: "gen-1",
    });

    expect(event).toBeNull();
  });

  it("parses approval waiting beforeShellExecution payload", () => {
    const event = parseCursorTerminalHookEvent({
      hook_event_name: "beforeShellExecution",
      command: "rm -rf /",
      permission: "ask",
      generation_id: "gen-2",
    });

    expect(event).not.toBeNull();
    expect(event?.level).toBe("warn");
    expect(event?.title).toContain("等待用户同意");
  });

  it("supports text based approval waiting signal", () => {
    const event = parseCursorTerminalHookEvent({
      hook_event_name: "beforeShellExecution",
      command: "npm run build",
      message: "waiting for user approval",
      generation_id: "gen-3",
    });

    expect(event).not.toBeNull();
    expect(event?.level).toBe("warn");
  });

  it("creates qoder event when marker is qoder", () => {
    const event = parseCursorTerminalHookEvent({
      hook_event_name: "beforeShellExecution",
      command: "sleep 20",
      qoder_agent: true,
      agent_marker: "qoder",
      permission: "ask",
      generation_id: "gen-qoder-1",
    });
    expect(event).not.toBeNull();
    expect(event?.editor).toBe("qoder");
    expect(event?.title).toContain("Qoder");
    expect(event?.dedupeKey.startsWith("qoder:approval:")).toBe(true);
  });

  it("parses afterShellExecution duration signal", () => {
    const signal = parseCursorTerminalSignal({
      hook_event_name: "afterShellExecution",
      command: "sudo rm -rf /tmp/x",
      duration: 3500,
      exit_code: 1,
      generation_id: "gen-after",
    });
    expect(signal).not.toBeNull();
    expect(signal?.hookEvent).toBe("afterShellExecution");
    expect(signal?.durationMs).toBe(3500);
    expect(signal?.exitCode).toBe(1);
  });

  it("does not create lifecycle events for successful afterShellExecution", () => {
    const signal = parseCursorTerminalSignal({
      hook_event_name: "afterShellExecution",
      command: "npm run build",
      generation_id: "gen-resolved",
      cursor_agent: true,
      has_child_process: true,
      parent_child_count: 1,
      exit_code: 0,
    });
    expect(signal).not.toBeNull();
    if (!signal) {
      return;
    }
    const events = createCursorLifecycleEvents({ signal });
    expect(events.length).toBe(0);
  });

  it("creates lifecycle events from failed afterShellExecution signal", () => {
    const signal = parseCursorTerminalSignal({
      hook_event_name: "afterShellExecution",
      command: "npm run build",
      generation_id: "gen-failed",
      cursor_agent: true,
      has_child_process: true,
      parent_child_count: 1,
      exit_code: 1,
    });
    expect(signal).not.toBeNull();
    if (!signal) {
      return;
    }
    const events = createCursorLifecycleEvents({ signal });
    expect(events.length).toBe(1);
    expect(events[0]?.title).toContain("任务异常终止");
    expect(events[0]?.dedupeKey.startsWith("cursor:lifecycle:StopFailure:")).toBe(true);
  });

  it("parses session end lifecycle event from SessionEnd hook", () => {
    const event = parseCursorSessionEndEvent({
      hook_event_name: "SessionEnd",
      conversation_id: "conv-1",
      message: "session closed",
      status: "done",
      cwd: "/tmp/project",
    });
    expect(event).not.toBeNull();
    expect(event?.title).toContain("会话已结束");
    expect(event?.level).toBe("info");
    expect(event?.dedupeKey.startsWith("cursor:lifecycle:SessionEnd:")).toBe(true);
  });

  it("parses agent marker and child process hints", () => {
    const signal = parseCursorTerminalSignal({
      hook_event_name: "beforeShellExecution",
      command: "npm run build",
      cursor_agent: true,
      has_child_process: true,
      parent_child_count: 2,
      generation_id: "gen-marker",
    });
    expect(signal).not.toBeNull();
    expect(signal?.agentMarker).toBe("cursor");
    expect(signal?.hasChildProcess).toBe(true);
    expect(signal?.parentChildCount).toBe(2);
  });

  it("detects potentially dangerous command", () => {
    expect(isPotentiallyDangerousCommand("sudo rm -rf /tmp/test")).toBe(true);
    expect(isPotentiallyDangerousCommand("git status")).toBe(false);
  });

});
