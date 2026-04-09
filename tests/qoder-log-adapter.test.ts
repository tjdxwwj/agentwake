import { describe, expect, it } from "vitest";
import { parseQoderLogLine } from "../src/adapters/qoder-log-adapter";

describe("parseQoderLogLine", () => {
  it("parses permission requested", () => {
    const signal = parseQoderLogLine(
      '2026-04-08 10:01:02 [info] Tool permission requested toolCallId=toolu_abc toolName=Shell',
    );
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("permission_requested");
    if (signal?.type === "permission_requested") {
      expect(signal.toolCallId).toBe("toolu_abc");
      expect(signal.toolName).toBe("Shell");
    }
  });

  it("parses permission resolved", () => {
    const signal = parseQoderLogLine(
      '2026-04-08 10:01:07 [info] Permission resolved toolCallId=toolu_abc payload={"name":"Allow"}',
    );
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("permission_resolved");
    if (signal?.type === "permission_resolved") {
      expect(signal.outcome).toBe("allow");
    }
  });

  it("parses suspended/resumed transitions", () => {
    const suspended = parseQoderLogLine("streaming -> suspended reason=permission_request");
    const resumed = parseQoderLogLine("suspended -> streaming");
    expect(suspended?.type).toBe("agent_suspended");
    expect(resumed?.type).toBe("agent_resumed");
  });

  it("parses session end transition", () => {
    const signal = parseQoderLogLine("2026-04-09 19:51:38.217 [info] suspended -> cancelled");
    expect(signal?.type).toBe("agent_session_end");
  });

  it("parses session end from streaming completed transition", () => {
    const signal = parseQoderLogLine(
      "2026-04-09 19:50:57.892 [info] [ACPProgressStateMachine] State transition: streaming -> completed, trigger: chat_finish:end_turn:200, sessionId: 411864aa-22f6-4f87-9641-01ac068997b4",
    );
    expect(signal?.type).toBe("agent_session_end");
    if (signal?.type === "agent_session_end") {
      expect(signal.sessionId).toBe("411864aa-22f6-4f87-9641-01ac068997b4");
    }
  });

  it("parses session end from closed tab line", () => {
    const signal = parseQoderLogLine(
      "2026-04-09 19:51:14.207 [info] [ChatViewManagerService] Closed tab: tabId=10e58be0-8df9-4272-a598-a2437687ac44, sessionId=411864aa-22f6-4f87-9641-01ac068997b4",
    );
    expect(signal?.type).toBe("agent_session_end");
    if (signal?.type === "agent_session_end") {
      expect(signal.sessionId).toBe("411864aa-22f6-4f87-9641-01ac068997b4");
    }
  });

  it("parses command completed with non-zero exit code", () => {
    const signal = parseQoderLogLine(
      "2026-04-09 19:51:36.217 [info] [RichExecuteStrategy] Command finished via end event: cd test, exitCode: 1",
    );
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("command_completed");
    if (signal?.type === "command_completed") {
      expect(signal.command).toBe("cd test");
      expect(signal.exitCode).toBe(1);
    }
  });

  it("parses command completed with equals exit code format", () => {
    const signal = parseQoderLogLine(
      "2026-04-09 19:51:36.213 [info] [Terminal] Command completed: exitCode=1, outputLength=36",
    );
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("command_completed");
    if (signal?.type === "command_completed") {
      expect(signal.exitCode).toBe(1);
    }
  });

  it("ignores unrelated lines", () => {
    const signal = parseQoderLogLine("build completed");
    expect(signal).toBeNull();
  });
});
