import { describe, expect, it } from "vitest";
import {
  buildCursorHookCommand,
  resolveCursorHookGatewayFromEnvRaw,
} from "../src/setup-bootstrap";

describe("setup-bootstrap cursor hook command", () => {
  it("uses http gateway by default when https is disabled", () => {
    const gateway = resolveCursorHookGatewayFromEnvRaw(`
AGENTWAKE_HTTPS_ENABLED=0
AGENTWAKE_PORT=3199
`);
    expect(gateway).toBe("http://127.0.0.1:3199/hooks/cursor");
  });

  it("uses https gateway and custom port when enabled", () => {
    const gateway = resolveCursorHookGatewayFromEnvRaw(`
AGENTWAKE_HTTPS_ENABLED=1
AGENTWAKE_PORT=4011
`);
    expect(gateway).toBe("https://127.0.0.1:4011/hooks/cursor");
  });

  it("builds hook command with overridable gateway default", () => {
    const command = buildCursorHookCommand("https://127.0.0.1:4011/hooks/cursor");
    expect(command).toBe(
      'AGENTWAKE_GATEWAY_URL="${AGENTWAKE_GATEWAY_URL:-https://127.0.0.1:4011/hooks/cursor}" node "./scripts/cursor-hook-forwarder.mjs"',
    );
  });
});
