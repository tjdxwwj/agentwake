export type CursorCommandMemory = {
  allowlist: string[];
  denylist: string[];
  smartAllowlistEnabled: boolean;
  loadedAtMs: number;
};

function normalizeCommand(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function commandMatchesRule(command: string, rule: string): boolean {
  const normalizedRule = normalizeCommand(rule);
  if (!normalizedRule) {
    return false;
  }
  if (normalizedRule.endsWith("*")) {
    const prefix = normalizedRule.slice(0, -1).trimEnd();
    return prefix.length > 0 && command.startsWith(prefix);
  }
  return (
    command === normalizedRule ||
    command.startsWith(`${normalizedRule} `) ||
    command.startsWith(`${normalizedRule}/`)
  );
}

export function isCommandInCursorMemoryAllowlist(
  command: string,
  allowlist: string[],
  denylist: string[],
): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }
  if (denylist.some((rule) => commandMatchesRule(normalizedCommand, rule))) {
    return false;
  }
  return allowlist.some((rule) => commandMatchesRule(normalizedCommand, rule));
}

export function createEmptyCursorCommandMemory(): CursorCommandMemory {
  return {
    allowlist: [],
    denylist: [],
    smartAllowlistEnabled: false,
    loadedAtMs: 0,
  };
}
