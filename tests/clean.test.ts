import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanCursorHooksJson, isAgentwakeCursorHookCommand } from "../src/clean";

describe("clean", () => {
  it("detects agentwake cursor hook commands", () => {
    expect(isAgentwakeCursorHookCommand('node "./scripts/cursor-hook-forwarder.mjs"')).toBe(true);
    expect(
      isAgentwakeCursorHookCommand(
        'AGENTWAKE_GATEWAY_URL="http://127.0.0.1:3199/hooks/cursor" node /path/agentwake/x.mjs',
      ),
    ).toBe(true);
    expect(isAgentwakeCursorHookCommand("echo hello")).toBe(false);
  });

  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("removes agentwake entries from hooks.json", () => {
    const dir = fsTempDir();
    tmpDirs.push(dir);
    const hooksPath = path.join(dir, "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          version: 1,
          hooks: {
            beforeShellExecution: [
              { command: 'node "./scripts/cursor-hook-forwarder.mjs"' },
              { command: "echo keep" },
            ],
            afterShellExecution: [{ command: 'node "./scripts/cursor-hook-forwarder.mjs"' }],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const { removed, changed } = cleanCursorHooksJson(hooksPath);
    expect(removed).toBe(2);
    expect(changed).toBe(true);
    const parsed = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: { beforeShellExecution: Array<{ command: string }> };
    };
    expect(parsed.hooks.beforeShellExecution).toHaveLength(1);
    expect(parsed.hooks.beforeShellExecution[0]?.command).toBe("echo keep");
    expect(parsed.hooks.afterShellExecution).toBeUndefined();
  });
});

function fsTempDir(): string {
  return mkdirSync(path.join(os.tmpdir(), `agentwake-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`), {
    recursive: true,
  });
}
