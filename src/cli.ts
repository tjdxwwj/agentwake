#!/usr/bin/env node
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureHome, homePath, PKG_ROOT } from "./paths";
import { runGateway } from "./run-gateway";

function printHelp(): void {
  console.log(`agentwake CLI

Usage:
  agentwake setup                       交互式配置向导
  agentwake init                        非交互式初始化（HTTPS + mkcert）
  agentwake start [--host <host>] [--port <port>]  启动服务
  agentwake help                        帮助信息

数据目录: ~/.agentwake/
`);
}

function parseStartFlags(args: string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--host" && args[i + 1]) {
      process.env.AGENTWAKE_HOST = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--port" && args[i + 1]) {
      process.env.AGENTWAKE_PORT = args[i + 1];
      i += 1;
      continue;
    }
  }
}

function ensureEnvFile(): void {
  const envPath = homePath(".env");
  if (existsSync(envPath)) return;
  ensureHome();
  const candidates = [
    path.join(PKG_ROOT, ".env.example"),
  ];
  for (const src of candidates) {
    if (existsSync(src)) {
      copyFileSync(src, envPath);
      return;
    }
  }
}

function ensureHttpsEnv(): void {
  const envPath = homePath(".env");
  if (!existsSync(envPath)) {
    throw new Error(".env not found. Run `agentwake init` first.");
  }

  const certDir = homePath("certs");
  const raw = readFileSync(envPath, "utf8");
  let next = raw;
  const upserts: Array<[RegExp, string]> = [
    [/^AGENTWAKE_HTTPS_ENABLED=.*$/m, "AGENTWAKE_HTTPS_ENABLED=1"],
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

function ensureHooksHttps(): void {
  // Cursor hooks live in the project cwd, not in ~/.agentwake
  const hooksPath = path.join(process.cwd(), ".cursor", "hooks.json");
  if (!existsSync(hooksPath)) {
    return;
  }
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
      entry.command = entry.command.replace(
        /AGENTWAKE_GATEWAY_URL="\$\{AGENTWAKE_GATEWAY_URL:-https?:\/\/127\.0\.0\.1:3199\/hooks\/cursor\}"/g,
        'AGENTWAKE_GATEWAY_URL="${AGENTWAKE_GATEWAY_URL:-https://127.0.0.1:3199/hooks/cursor}"',
      );
    }
  }
  writeFileSync(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

function ensureNodeExtraCaEnvHint(): void {
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
  const os = require("node:os") as typeof import("node:os");
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

function setupMkcert(): void {
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

function initProject(): void {
  ensureHome();
  ensureEnvFile();
  ensureHttpsEnv();
  ensureHooksHttps();
  setupMkcert();
  ensureNodeExtraCaEnvHint();
  console.log(`[agentwake] init completed. Data dir: ${homePath()}`);
}

/** Load .env from ~/.agentwake/.env into process.env. */
async function loadHomeEnv(): Promise<void> {
  const envPath = homePath(".env");
  if (existsSync(envPath)) {
    const dotenv = await import("dotenv");
    dotenv.config({ path: envPath });
  }
}

async function main(): Promise<void> {
  const [cmd = "start", ...rest] = process.argv.slice(2);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "init") {
    initProject();
    return;
  }
  if (cmd === "setup") {
    const { runSetup } = await import("./setup");
    await runSetup();
    return;
  }
  if (cmd === "start") {
    parseStartFlags(rest);
    await loadHomeEnv();
    await runGateway();
    return;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

void main().catch((error) => {
  console.error(`[agentwake] ${String((error as Error).message || error)}`);
  process.exit(1);
});
