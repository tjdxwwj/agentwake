import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHome, homePath, PKG_ROOT } from "./paths";

function parseEnvMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    map[key] = value;
  }
  return map;
}

/** Resolve Cursor hook gateway URL from env content (protocol + port must match runtime server). */
export function resolveCursorHookGatewayFromEnvRaw(envRaw: string): string {
  const env = parseEnvMap(envRaw);
  const httpsEnabled = env.AGENTWAKE_HTTPS_ENABLED === "1";
  const port = env.AGENTWAKE_PORT?.trim() || "3199";
  const protocol = httpsEnabled ? "https" : "http";
  return `${protocol}://127.0.0.1:${port}/hooks/cursor`;
}

/** Standard Cursor hook command with overridable env var and aligned default gateway URL. */
export function buildCursorHookCommand(defaultGateway: string): string {
  return `AGENTWAKE_GATEWAY_URL="\${AGENTWAKE_GATEWAY_URL:-${defaultGateway}}" node "./scripts/cursor-hook-forwarder.mjs"`;
}

function resolveDefaultCursorHookGateway(): string {
  const envPath = homePath(".env");
  if (!existsSync(envPath)) {
    return "http://127.0.0.1:3199/hooks/cursor";
  }
  const envRaw = readFileSync(envPath, "utf8");
  return resolveCursorHookGatewayFromEnvRaw(envRaw);
}

function isAgentwakeCursorHookCommand(command: string): boolean {
  const normalized = command.trim();
  return (
    normalized.includes("cursor-hook-forwarder.mjs") ||
    (normalized.includes("AGENTWAKE_GATEWAY_URL") && normalized.includes("/hooks/cursor"))
  );
}

/** Copy `~/.agentwake/.env` from package `.env.example` when missing. */
export function ensureEnvFile(): void {
  const envPath = homePath(".env");
  if (existsSync(envPath)) {
    return;
  }
  ensureHome();
  const exampleSrc = path.join(PKG_ROOT, ".env.example");
  if (existsSync(exampleSrc)) {
    copyFileSync(exampleSrc, envPath);
  }
}

/** Create or repair `.cursor/hooks.json` so Cursor runs the shell forwarder (stdin → gateway). */
export function ensureCursorShellHooks(): void {
  const cursorDir = path.join(process.cwd(), ".cursor");
  const hooksPath = path.join(cursorDir, "hooks.json");
  const defaultGateway = resolveDefaultCursorHookGateway();
  const hookCommand = buildCursorHookCommand(defaultGateway);
  const payload = {
    version: 1,
    hooks: {
      beforeShellExecution: [{ command: hookCommand }],
      afterShellExecution: [{ command: hookCommand }],
    },
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;

  if (!existsSync(hooksPath)) {
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(hooksPath, text, "utf8");
    console.log(`[agentwake] created ${hooksPath} (Cursor shell → gateway forwarder)`);
    return;
  }

  try {
    const raw = readFileSync(hooksPath, "utf8");
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    const h = parsed.hooks;
    if (!h || typeof h !== "object" || Object.keys(h).length === 0) {
      writeFileSync(hooksPath, text, "utf8");
      console.log(`[agentwake] filled empty hooks in ${hooksPath} (Cursor shell → gateway forwarder)`);
    }
  } catch {
    console.warn(`[agentwake] skip Cursor hooks: invalid JSON at ${hooksPath}`);
  }
}

export function ensureHttpsEnv(useHttps: boolean): void {
  const envPath = homePath(".env");
  if (!existsSync(envPath)) {
    throw new Error(".env not found. Run `agentwake setup` first.");
  }

  const certDir = homePath("certs");
  const raw = readFileSync(envPath, "utf8");
  let next = raw;
  const enabled = useHttps ? "1" : "0";
  const upserts: Array<[RegExp, string]> = [
    [/^AGENTWAKE_HTTPS_ENABLED=.*$/m, `AGENTWAKE_HTTPS_ENABLED=${enabled}`],
    [/^AGENTWAKE_HTTPS_CERT_PATH=.*$/m, `AGENTWAKE_HTTPS_CERT_PATH=${certDir}/dev-cert.pem`],
    [/^AGENTWAKE_HTTPS_KEY_PATH=.*$/m, `AGENTWAKE_HTTPS_KEY_PATH=${certDir}/dev-key.pem`],
  ];
  for (const [pattern, replacement] of upserts) {
    if (pattern.test(next)) {
      next = next.replace(pattern, replacement);
    } else {
      next = `${next.trimEnd()}\n${replacement}\n`;
    }
  }
  writeFileSync(envPath, next, "utf8");
}

/** Sync `AGENTWAKE_GATEWAY_URL` default in hook commands with current HTTP/HTTPS .env. */
export function ensureHooksHttps(): void {
  const hooksPath = path.join(process.cwd(), ".cursor", "hooks.json");
  if (!existsSync(hooksPath)) {
    return;
  }
  const defaultGateway = resolveDefaultCursorHookGateway();
  const hookCommand = buildCursorHookCommand(defaultGateway);
  const raw = readFileSync(hooksPath, "utf8");
  const parsed = JSON.parse(raw) as {
    hooks?: Record<string, Array<{ command?: string }>>;
  };
  for (const hookName of ["beforeShellExecution", "afterShellExecution"]) {
    const entries = parsed.hooks?.[hookName];
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.command) {
        continue;
      }
      if (isAgentwakeCursorHookCommand(entry.command)) {
        entry.command = hookCommand;
      }
    }
  }
  writeFileSync(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export function ensureNodeExtraCaEnvHint(): void {
  const envPath = homePath(".env");
  if (!existsSync(envPath)) {
    return;
  }
  const raw = readFileSync(envPath, "utf8");
  if (/^NODE_EXTRA_CA_CERTS=.*$/m.test(raw)) {
    return;
  }
  let caRoot = "";
  try {
    caRoot = execSync("mkcert -CAROOT", { encoding: "utf8" }).trim();
  } catch {
    return;
  }
  if (!caRoot) {
    return;
  }
  const next = `${raw.trimEnd()}\nNODE_EXTRA_CA_CERTS="${caRoot}/rootCA.pem"\n`;
  writeFileSync(envPath, next, "utf8");
}

function resolveLanIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

function run(command: string): void {
  execSync(command, { stdio: "inherit" });
}

export function setupMkcert(): void {
  const certDir = homePath("certs");
  if (!existsSync(certDir)) {
    mkdirSync(certDir, { recursive: true });
  }
  try {
    run("mkcert -help > /dev/null");
  } catch {
    throw new Error("mkcert not found. Install with `brew install mkcert` first.");
  }

  try {
    run("mkcert -install");
  } catch {
    console.warn("[agentwake] mkcert -install failed, continue generating cert.");
  }

  const lanIp = resolveLanIpv4();
  const san = ["localhost", "127.0.0.1", "::1"];
  if (lanIp) {
    san.push(lanIp);
  }
  const certPath = `${certDir}/dev-cert.pem`;
  const keyPath = `${certDir}/dev-key.pem`;
  run(`mkcert -cert-file "${certPath}" -key-file "${keyPath}" ${san.join(" ")}`);

  try {
    const caRoot = execSync("mkcert -CAROOT", { encoding: "utf8" }).trim();
    console.log(`[agentwake] export this for Node.js trust:`);
    console.log(`export NODE_EXTRA_CA_CERTS="${caRoot}/rootCA.pem"`);
  } catch {
    // ignore
  }
}
