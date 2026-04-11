import { describe, expect, it } from "vitest";
import {
  createCursorLifecycleEvents,
  isPotentiallyDangerousCommand,
  parseCursorLifecycleHookEvent,
  parseCursorSessionEndEvent,
  parseCursorTerminalHookEvent,
  parseCursorTerminalSignal,
} from "../src/adapters/cursor/cursor-terminal-hook";

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

  it("ignores text-only waiting signal without explicit approval fields", () => {
    const event = parseCursorTerminalHookEvent({
      hook_event_name: "beforeShellExecution",
      command: "npm run build",
      message: "waiting for user approval",
      generation_id: "gen-3",
    });

    expect(event).toBeNull();
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

  it("rejects after-shell-like payload without explicit hook_event_name", () => {
    const signal = parseCursorTerminalSignal({
      command: "npm test",
      output: "ok",
      duration: 1234,
      sandbox: false,
    });
    expect(signal).toBeNull();
  });

  it("rejects duration_ms-only payload without explicit hook_event_name", () => {
    const signal = parseCursorTerminalSignal({
      command: "npm run lint",
      duration_ms: 2468,
    });
    expect(signal).toBeNull();
  });

  it("creates stop lifecycle event for successful afterShellExecution", () => {
    const signal = parseCursorTerminalSignal({
      hook_event_name: "afterShellExecution",
      command: "npm run build",
      generation_id: "gen-resolved",
      exit_code: 0,
    });
    expect(signal).not.toBeNull();
    if (!signal) {
      return;
    }
    const events = createCursorLifecycleEvents({ signal });
    expect(events.length).toBe(1);
    expect(events[0]?.title).toContain("任务完成");
    expect(events[0]?.dedupeKey.startsWith("cursor:lifecycle:Stop:")).toBe(true);
  });

  it("creates lifecycle events from failed afterShellExecution signal", () => {
    const signal = parseCursorTerminalSignal({
      hook_event_name: "afterShellExecution",
      command: "npm run build",
      generation_id: "gen-failed",
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

  it("parses notification lifecycle event", () => {
    const event = parseCursorLifecycleHookEvent({
      hook_event_name: "Notification",
      conversation_id: "conv-2",
      message: "need human review",
      cwd: "/tmp/project",
    });
    expect(event).not.toBeNull();
    expect(event?.level).toBe("warn");
    expect(event?.title).toContain("需要你的注意");
    expect(event?.dedupeKey.startsWith("cursor:lifecycle:Notification:")).toBe(true);
  });

  it("parses session start lifecycle event", () => {
    const event = parseCursorLifecycleHookEvent({
      hook_event_name: "SessionStart",
      conversation_id: "conv-3",
      message: "session started",
    });
    expect(event).not.toBeNull();
    expect(event?.title).toContain("会话已开始");
    expect(event?.dedupeKey.startsWith("cursor:lifecycle:SessionStart:")).toBe(true);
  });

  it("parses lower-camel sessionStart payload fields", () => {
    const event = parseCursorLifecycleHookEvent({
      hook_event_name: "sessionStart",
      session_id: "session-1",
      is_background_agent: false,
      composer_mode: "agent",
    });
    expect(event).not.toBeNull();
    expect(event?.title).toContain("会话已开始");
    expect(event?.body).toContain("会话ID: session-1");
    expect(event?.body).toContain("模式: agent");
  });

  it("parses lower-camel stop payload fields", () => {
    const event = parseCursorLifecycleHookEvent({
      hook_event_name: "stop",
      session_id: "session-2",
      status: "completed",
      loop_count: 2,
    });
    expect(event).not.toBeNull();
    expect(event?.title).toContain("任务完成");
    expect(event?.body).toContain("结果: completed");
    expect(event?.body).toContain("循环次数: 2");
  });

  it("parses lower-camel sessionEnd payload fields", () => {
    const event = parseCursorLifecycleHookEvent({
      hook_event_name: "sessionEnd",
      session_id: "session-3",
      reason: "error",
      duration_ms: 45000,
      final_status: "error",
      error_message: "boom",
      is_background_agent: true,
    });
    expect(event).not.toBeNull();
    expect(event?.title).toContain("会话已结束");
    expect(event?.body).toContain("结束原因: error");
    expect(event?.body).toContain("会话耗时: 45.0s");
    expect(event?.body).toContain("错误: boom");
  });

  it("parses pre/post tool lifecycle events", () => {
    const pre = parseCursorLifecycleHookEvent({
      hook_event_name: "preToolUse",
      tool_name: "Shell",
      tool_input: { command: "npm install", working_directory: "/project" },
      tool_use_id: "tool-1",
      model: "claude-sonnet-4-20250514",
    });
    const post = parseCursorLifecycleHookEvent({
      hook_event_name: "postToolUse",
      tool_name: "Shell",
      tool_input: { command: "npm test" },
      tool_output: "{\"exitCode\":0,\"stdout\":\"All tests passed\"}",
      tool_use_id: "tool-1",
      duration: 5432,
    });
    expect(pre).not.toBeNull();
    expect(post).not.toBeNull();
    expect(pre?.title).toContain("工具调用前");
    expect(post?.title).toContain("工具调用后");
    expect(pre?.body).toContain("工具: Shell");
    expect(pre?.body).toContain("工具调用ID: tool-1");
    expect(post?.body).toContain("工具输出:");
  });

  it("parses postToolUseFailure payload fields", () => {
    const event = parseCursorLifecycleHookEvent({
      hook_event_name: "postToolUseFailure",
      tool_name: "Shell",
      tool_input: { command: "npm test" },
      tool_use_id: "tool-2",
      error_message: "Command timed out after 30s",
      failure_type: "timeout",
      duration: 5000,
      is_interrupt: false,
    });
    expect(event).not.toBeNull();
    expect(event?.title).toContain("工具调用失败");
    expect(event?.level).toBe("error");
    expect(event?.body).toContain("失败类型: timeout");
    expect(event?.body).toContain("错误: Command timed out after 30s");
  });

  it("handles unserializable tool_input without throwing", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const event = parseCursorLifecycleHookEvent({
      hook_event_name: "preToolUse",
      tool_name: "Shell",
      tool_input: circular,
      tool_use_id: "tool-circular",
    });
    expect(event).not.toBeNull();
    expect(event?.body).toContain("工具输入: [unserializable-tool-input]");
  });

  it("detects potentially dangerous command", () => {
    expect(isPotentiallyDangerousCommand("sudo rm -rf /tmp/test")).toBe(true);
    expect(isPotentiallyDangerousCommand("git status")).toBe(false);
  });

});
