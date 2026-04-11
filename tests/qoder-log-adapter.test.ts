import { describe, expect, it } from "vitest";
import {
  commandMatchesRuleList,
  parseQoderLogLine,
  parseQoderRunConfigFromSettings,
  qoderCompletionDedupeKeys,
  qoderLogPendingProbeKey,
} from "../src/adapters/qoder/qoder-log-adapter";

describe("parseQoderLogLine", () => {
  it("parses permission requested line", () => {
    const signal = parseQoderLogLine(
      '2026-04-08 10:01:02 [info] Tool permission requested toolCallId=toolu_abc toolName=Shell',
    );
    expect(signal?.type).toBe("approval_requested");
    if (signal?.type === "approval_requested") {
      expect(signal.toolCallId).toBe("toolu_abc");
      expect(signal.toolName).toBe("Shell");
    }
  });

  it("ignores permission resolved line", () => {
    const signal = parseQoderLogLine(
      '2026-04-08 10:01:07 [info] Permission resolved toolCallId=toolu_abc payload={"name":"Allow"}',
    );
    expect(signal).toBeNull();
  });

  it("ignores suspended/resumed transitions", () => {
    const suspended = parseQoderLogLine("streaming -> suspended reason=permission_request");
    const resumed = parseQoderLogLine("suspended -> streaming");
    expect(suspended).toBeNull();
    expect(resumed).toBeNull();
  });

  it("parses session end transition", () => {
    const signal = parseQoderLogLine("2026-04-09 19:51:38.217 [info] suspended -> cancelled");
    expect(signal?.type).toBe("agent_session_end");
  });

  it("parses session start transition", () => {
    const signal = parseQoderLogLine(
      "2026-04-09 19:49:10.101 [info] [ChatViewManagerService] Created tab: tabId=foo, sessionId=411864aa-22f6-4f87-9641-01ac068997b4",
    );
    expect(signal?.type).toBe("agent_session_start");
    if (signal?.type === "agent_session_start") {
      expect(signal.sessionId).toBe("411864aa-22f6-4f87-9641-01ac068997b4");
    }
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

describe("commandMatchesRuleList", () => {
  it("matches prefix and exact rules like deny/allow lists", () => {
    expect(commandMatchesRuleList("rm -rf /tmp", ["rm"])).toBe(true);
    expect(commandMatchesRuleList("npm run build", ["npm run"])).toBe(true);
    expect(commandMatchesRuleList("echo ok", ["rm"])).toBe(false);
  });
});

describe("qoderLogPendingProbeKey", () => {
  it("prefers toolCallId when present", () => {
    expect(qoderLogPendingProbeKey("npm test", "call_123")).toBe("tc:call_123");
  });

  it("falls back to trimmed command", () => {
    expect(qoderLogPendingProbeKey("  ls -la  ", undefined)).toBe("ls -la");
  });
});

describe("qoderCompletionDedupeKeys", () => {
  it("contains specific keys and coarse fallback key", () => {
    const keys = qoderCompletionDedupeKeys({
      type: "command_completed",
      command: "npm run build",
      toolCallId: "toolu_abc",
      exitCode: 1,
      logTimestampSec: 1_744_222_222,
    });
    expect(keys).toEqual([
      "tc:toolu_abc:1",
      "cmd:npm run build:1",
      "sec:1744222222:exit:1",
    ]);
  });

  it("shares coarse key between detailed and generic completion lines", () => {
    const detailed = qoderCompletionDedupeKeys({
      type: "command_completed",
      command: "cd test",
      exitCode: 1,
      logTimestampSec: 1_744_222_333,
    });
    const generic = qoderCompletionDedupeKeys({
      type: "command_completed",
      command: undefined,
      exitCode: 1,
      logTimestampSec: 1_744_222_333,
    });
    expect(detailed.some((key) => generic.includes(key))).toBe(true);
    expect(generic).toEqual(["sec:1744222333:exit:1"]);
  });
});

describe("parseQoderLogLine command_started", () => {
  it("parses Running command: without quoted command=", () => {
    const signal = parseQoderLogLine("2026-04-09 12:00:00 [info] Running command: pnpm install");
    expect(signal?.type).toBe("command_started");
    if (signal?.type === "command_started") {
      expect(signal.command).toBe("pnpm install");
    }
  });
});

describe("parseQoderLogLine command_completed", () => {
  it("extracts toolCallId when present", () => {
    const signal = parseQoderLogLine(
      '2026-04-09 12:00:01 [info] Command completed: toolCallId=toolu_abc, exitCode=0',
    );
    expect(signal?.type).toBe("command_completed");
    if (signal?.type === "command_completed") {
      expect(signal.toolCallId).toBe("toolu_abc");
      expect(signal.exitCode).toBe(0);
    }
  });
});

describe("parseQoderRunConfigFromSettings", () => {
  it("parses command allowlist and denylist", () => {
    const config = parseQoderRunConfigFromSettings(
      JSON.stringify({
        app: {
          configChatCommandAllowlist: "node,python3,npm run",
          configChatCommandDenyList: "rm,sudo",
        },
      }),
    );
    expect(config.commandAllowlist).toEqual(["node", "python3", "npm run"]);
    expect(config.commandDenylist).toEqual(["rm", "sudo"]);
  });

  it("returns fallback on invalid settings json", () => {
    const config = parseQoderRunConfigFromSettings("{invalid");
    expect(config.commandAllowlist).toEqual([]);
    expect(config.commandDenylist).toEqual([]);
  });
});
