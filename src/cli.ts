#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homePath } from "./paths";
import { runGateway } from "./run-gateway";

function printHelp(): void {
  console.log(`agentwake CLI

Usage:
  agentwake setup                       交互式配置向导（含 ~/.agentwake/.env、HTTPS/mkcert、Cursor hooks）
  agentwake start [--host <host>] [--port <port>]  启动服务
  agentwake notify-test                 发送一条测试桌面通知（排查通知权限与 AGENTWAKE_DESKTOP_*）
  agentwake clean [--yes]               卸载 Hook、删除 ~/.agentwake、清理当前项目 Cursor/Qoder 残留
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

/** Load .env from ~/.agentwake/.env into process.env. */
async function loadHomeEnv(): Promise<void> {
  const envPath = homePath(".env");
  if (existsSync(envPath)) {
    const dotenv = await import("dotenv");
    dotenv.config({ path: envPath, override: true });
  }
}

async function runNotifyTest(): Promise<void> {
  const { loadConfig } = await import("./config");
  const { createNotifyEvent } = await import("./domain/notify-event");
  const { DesktopNotifier } = await import("./notifiers/desktop-notifier");

  const config = loadConfig();
  const desktop = process.env.AGENTWAKE_DESKTOP_ENABLED;
  const mode = process.env.AGENTWAKE_DESKTOP_MODE || "notification";
  console.log(
    `[agentwake] notify-test: AGENTWAKE_DESKTOP_ENABLED=${desktop ?? "(unset, default true)"} AGENTWAKE_DESKTOP_MODE=${mode}`,
  );

  if (!config.desktopEnabled) {
    console.error(
      "[agentwake] 桌面通知已在配置中关闭（AGENTWAKE_DESKTOP_ENABLED=0）。若要测试，请在 ~/.agentwake/.env 中改为 1 后重试。",
    );
    process.exit(1);
  }

  const notifier = new DesktopNotifier();
  const event = createNotifyEvent({
    source: "notify-test",
    editor: "unknown",
    level: "info",
    title: "Agentwake 通知测试",
    body: `若看到本通知则链路正常。${new Date().toISOString()}`,
    dedupeKey: `notify-test:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  });

  try {
    await notifier.notify(event);
    console.log("[agentwake] 已调用桌面通知；若未见横幅请检查：");
    console.log("  · 系统设置 → 通知 → 终端 / Cursor / Node（视你如何启动 agentwake）→ 允许通知");
    console.log("  · 是否开启专注模式 / 勿扰，或通知中心被清空");
    console.log("  · AGENTWAKE_DESKTOP_MODE=dialog 时只会弹对话框、无右上角横幅");
    console.log("  · 排查网关事件时设置 AGENTWAKE_LOG_LEVEL=info 查看 desktop notifier / 限流 / 去重日志");
  } catch (error) {
    console.error("[agentwake] notify-test 失败:", error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [cmd = "start", ...rest] = process.argv.slice(2);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "setup") {
    const { runSetup } = await import("./setup");
    await runSetup();
    return;
  }
  if (cmd === "clean") {
    const { runClean } = await import("./clean");
    const yes = rest.includes("--yes") || rest.includes("-y");
    await runClean({ yes, cwd: process.cwd() });
    return;
  }
  if (cmd === "start") {
    parseStartFlags(rest);
    await loadHomeEnv();
    await runGateway();
    return;
  }
  if (cmd === "notify-test") {
    await loadHomeEnv();
    await runNotifyTest();
    return;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

void main().catch((error) => {
  console.error(`[agentwake] ${String((error as Error).message || error)}`);
  process.exit(1);
});
