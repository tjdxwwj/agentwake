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

  it("ignores unrelated lines", () => {
    const signal = parseQoderLogLine("build completed");
    expect(signal).toBeNull();
  });
});
