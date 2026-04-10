import { describe, expect, it } from "vitest";
import { isCommandInCursorMemoryAllowlist } from "../src/utils/cursor-command-memory";

describe("cursor command memory allowlist", () => {
  it("matches exact allowlist command", () => {
    expect(isCommandInCursorMemoryAllowlist("npm -v", ["npm -v"], [])).toBe(true);
  });

  it("matches allowlist prefix command", () => {
    expect(isCommandInCursorMemoryAllowlist("npm run build", ["npm run"], [])).toBe(true);
  });

  it("is blocked by denylist even when allowlist matches", () => {
    expect(isCommandInCursorMemoryAllowlist("rm -rf /tmp/a", ["rm"], ["rm -rf /tmp"])).toBe(false);
  });

  it("normalizes case and whitespace", () => {
    expect(isCommandInCursorMemoryAllowlist("  NPM    RUN   test  ", ["npm run"], [])).toBe(true);
  });
});
