import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const RELAY_MARKER = "agentwake";

function defaultSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function defaultScriptDir(): string {
  return path.join(os.homedir(), ".agentwake", "hooks");
}

export class ClaudeCodeInstaller {
  private scriptPath: string;

  constructor(
    private gatewayUrl: string,
    private settingsPath = defaultSettingsPath(),
    scriptDir = defaultScriptDir(),
  ) {
    this.scriptPath = path.join(scriptDir, "claude-hook-relay.sh");
  }

  async install(events: string[]): Promise<void> {
    this.installScript();
    const settings = this.readSettings();
    if (!settings.hooks) settings.hooks = {};

    for (const event of events) {
      if (!settings.hooks[event]) settings.hooks[event] = [];
      const exists = settings.hooks[event].some((group: Record<string, unknown>) =>
        this.isRelayHookGroup(group),
      );
      if (!exists) {
        settings.hooks[event].push(this.createHookGroup());
      }
    }

    this.writeSettings(settings);
  }

  async uninstall(): Promise<void> {
    const settings = this.readSettings();
    if (!settings.hooks) return;

    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event].filter(
        (group: Record<string, unknown>) => !this.isRelayHookGroup(group),
      );
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }

    this.writeSettings(settings);
  }

  validate(): boolean {
    return fs.existsSync(this.scriptPath);
  }

  private installScript(): void {
    const dir = path.dirname(this.scriptPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Use -sk flag for curl to handle self-signed HTTPS certs
    const script = `#!/bin/bash
# ${RELAY_MARKER}
INPUT=$(cat)
nohup curl -sk --max-time 2 -X POST ${this.gatewayUrl}/hooks/claude \\
  -H "Content-Type: application/json" \\
  -d "$INPUT" \\
  >/dev/null 2>&1 &
exit 0
`;
    fs.writeFileSync(this.scriptPath, script);
    fs.chmodSync(this.scriptPath, 0o755);
  }

  private createHookGroup(): Record<string, unknown> {
    return {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: this.scriptPath,
          timeout: 3000,
        },
      ],
      _meta: RELAY_MARKER,
    };
  }

  private isRelayHookGroup(group: Record<string, unknown>): boolean {
    if (group._meta === RELAY_MARKER) return true;
    const hooks = group.hooks as Array<Record<string, unknown>> | undefined;
    if (!hooks) return false;
    return hooks.some((h) =>
      typeof h.command === "string" && h.command.includes("agentwake"),
    );
  }

  private readSettings(): Record<string, any> {
    if (!fs.existsSync(this.settingsPath)) return {};
    return JSON.parse(fs.readFileSync(this.settingsPath, "utf-8"));
  }

  private writeSettings(settings: Record<string, any>): void {
    const dir = path.dirname(this.settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
  }
}
