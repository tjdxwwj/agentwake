import { describe, expect, it } from "vitest";
import {
  isPotentiallyDangerousCommand,
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

  it("parses afterShellExecution duration signal", () => {
    const signal = parseCursorTerminalSignal({
      hook_event_name: "afterShellExecution",
      command: "sudo rm -rf /tmp/x",
      duration: 3500,
      generation_id: "gen-after",
    });
    expect(signal).not.toBeNull();
    expect(signal?.hookEvent).toBe("afterShellExecution");
    expect(signal?.durationMs).toBe(3500);
  });

  it("detects potentially dangerous command", () => {
    expect(isPotentiallyDangerousCommand("sudo rm -rf /tmp/test")).toBe(true);
    expect(isPotentiallyDangerousCommand("git status")).toBe(false);
  });
});
