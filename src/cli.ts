#!/usr/bin/env node
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGateway } from "./run-gateway";

function printHelp(): void {
  console.log(`agentwake CLI

Usage:
  agentwake init
  agentwake start [--host <host>] [--port <port>]
  agentwake help
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
  const envPath = path.join(process.cwd(), ".env");
  const envExamplePath = path.join(process.cwd(), ".env.example");
  if (!existsSync(envPath) && existsSync(envExamplePath)) {
    copyFileSync(envExamplePath, envPath);
  }
}

function ensureHttpsEnv(): void {
  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    throw new Error(".env not found in current directory");
  }

  const raw = readFileSync(envPath, "utf8");
  let next = raw;
  const upserts: Array<[RegExp, string]> = [
    [/^AGENTWAKE_HTTPS_ENABLED=.*$/m, "AGENTWAKE_HTTPS_ENABLED=1"],
    [/^AGENTWAKE_HTTPS_CERT_PATH=.*$/m, "AGENTWAKE_HTTPS_CERT_PATH=certs/dev-cert.pem"],
    [/^AGENTWAKE_HTTPS_KEY_PATH=.*$/m, "AGENTWAKE_HTTPS_KEY_PATH=certs/dev-key.pem"],
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
  const envPath = path.join(process.cwd(), ".env");
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

function setupMkcert(): void {
  const certDir = path.join(process.cwd(), "certs");
  if (!existsSync(certDir)) {
    execSync(`mkdir -p "${certDir}"`);
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
  run(`mkcert -cert-file certs/dev-cert.pem -key-file certs/dev-key.pem ${san.join(" ")}`);

  try {
    const caRoot = execSync("mkcert -CAROOT", { encoding: "utf8" }).trim();
    console.log(`[agentwake] export this for Node.js trust:`);
    console.log(`export NODE_EXTRA_CA_CERTS="${caRoot}/rootCA.pem"`);
  } catch {
    // ignore
  }
}

function initProject(): void {
  ensureEnvFile();
  ensureHttpsEnv();
  ensureHooksHttps();
  setupMkcert();
  ensureNodeExtraCaEnvHint();
  console.log("[agentwake] init completed with HTTPS defaults.");
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
  if (cmd === "start") {
    parseStartFlags(rest);
    process.env.AGENTWAKE_HTTPS_ENABLED = "1";
    await runGateway();
    return;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

void main().catch((error) => {
  console.error(`[agentwake] ${String((error as Error).message || error)}`);
  process.exit(1);
});
