import { select, checkbox, input, password, confirm } from "@inquirer/prompts";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeInstaller } from "./installers/claude-code-installer";
import { ensureHome, homePath, PKG_ROOT } from "./paths";

const CLAUDE_CODE_EVENTS = [
  { name: "Notification — 需要用户注意时", value: "Notification", defaultEnabled: true },
  { name: "Stop — 任务完成停止时", value: "Stop", defaultEnabled: true },
  { name: "StopFailure — 任务失败停止时", value: "StopFailure", defaultEnabled: true },
  { name: "SessionEnd — 会话结束时", value: "SessionEnd", defaultEnabled: true },
  { name: "SessionStart — 会话开始时", value: "SessionStart", defaultEnabled: false },
  { name: "PreToolUse — 工具调用前", value: "PreToolUse", defaultEnabled: false },
  { name: "PostToolUse — 工具调用后", value: "PostToolUse", defaultEnabled: false },
];

function getLocalIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

function readEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  const raw = readFileSync(envPath, "utf8");
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function writeEnvFile(envPath: string, vars: Record<string, string>): void {
  // Read existing content to preserve comments and ordering
  let lines: string[] = [];
  if (existsSync(envPath)) {
    lines = readFileSync(envPath, "utf8").split("\n");
  }

  const written = new Set<string>();

  // Update existing lines
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in vars) {
      lines[i] = `${key}=${vars[key]}`;
      written.add(key);
    }
  }

  // Append new vars
  for (const [key, value] of Object.entries(vars)) {
    if (!written.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  writeFileSync(envPath, lines.join("\n").trimEnd() + "\n", "utf8");
}

export async function runSetup(): Promise<void> {
  console.log("\n🔧 AgentWake 配置向导\n");

  ensureHome();
  const envPath = homePath(".env");

  // Step 1: Select AI tool
  const aiTool = await select({
    message: "选择要配置的 AI 工具",
    choices: [
      { name: "Claude Code", value: "claude-code" },
      { name: "Cursor", value: "cursor" },
      { name: "全部", value: "all" },
    ],
  });

  // Step 2: Select Claude Code events (if applicable)
  let selectedEvents: string[] = [];
  if (aiTool === "claude-code" || aiTool === "all") {
    selectedEvents = await checkbox({
      message: "选择要监听的 Claude Code 事件",
      choices: CLAUDE_CODE_EVENTS.map((e) => ({
        name: e.name,
        value: e.value,
        checked: e.defaultEnabled,
      })),
    });
  }

  // Step 2.5: Customize notification titles per event
  const eventTitleVars: Record<string, string> = {};
  if (selectedEvents.length > 0) {
    const wantCustom = await confirm({
      message: "是否自定义每个事件的通知标题？（否则使用默认标题）",
      default: false,
    });
    if (wantCustom) {
      const defaultTitles: Record<string, string> = {
        Stop: "Claude Code: 任务完成",
        StopFailure: "Claude Code: 任务异常终止",
        Notification: "Claude Code: 需要你的注意",
        SessionEnd: "Claude Code: 会话已结束",
        SessionStart: "Claude Code: 会话已开始",
        PreToolUse: "Claude Code: 工具调用前",
        PostToolUse: "Claude Code: 工具调用后",
      };
      for (const evt of selectedEvents) {
        const defaultTitle = defaultTitles[evt] ?? `Claude Code: ${evt}`;
        const title = await input({
          message: `"${evt}" 事件的通知标题：`,
          default: defaultTitle,
        });
        if (title !== defaultTitle) {
          // AGENTWAKE_CLAUDE_TITLE_STOP, AGENTWAKE_CLAUDE_TITLE_STOP_FAILURE, etc.
          const envKey = `AGENTWAKE_CLAUDE_TITLE_${evt.replace(/([A-Z])/g, "_$1").replace(/^_/, "").toUpperCase()}`;
          eventTitleVars[envKey] = title;
        }
      }
    }
  }

  // Step 3: Select notification channels
  const channels = await checkbox({
    message: "选择通知渠道（PWA 和桌面通知默认启用）",
    choices: [
      { name: "钉钉 Webhook", value: "dingtalk" },
      { name: "飞书 Webhook", value: "feishu" },
      { name: "企业微信 Webhook", value: "wecom" },
      { name: "PWA 网页推送（已内置，无需配置）", value: "pwa", checked: true, disabled: "默认启用" },
      { name: "桌面系统通知（已内置，无需配置）", value: "desktop", checked: true, disabled: "默认启用" },
    ],
  });

  // Step 4: Collect webhook configs
  const envVars: Record<string, string> = {};

  if (channels.includes("dingtalk")) {
    const webhook = await input({
      message: "输入钉钉 Webhook URL：",
      validate: (v) => v.startsWith("https://") || "请输入有效的 HTTPS URL",
    });
    const secret = await password({
      message: "输入钉钉安全密钥（可选，直接回车跳过）：",
    });
    envVars.AGENTWAKE_DINGTALK_WEBHOOK = webhook;
    if (secret) envVars.AGENTWAKE_DINGTALK_SECRET = secret;
  }

  if (channels.includes("feishu")) {
    const webhook = await input({
      message: "输入飞书 Webhook URL：",
      validate: (v) => v.startsWith("https://") || "请输入有效的 HTTPS URL",
    });
    const secret = await password({
      message: "输入飞书签名校验密钥（可选，直接回车跳过）：",
    });
    envVars.AGENTWAKE_FEISHU_WEBHOOK = webhook;
    if (secret) envVars.AGENTWAKE_FEISHU_SECRET = secret;
  }

  if (channels.includes("wecom")) {
    const webhook = await input({
      message: "输入企业微信群机器人 Webhook URL：",
      validate: (v) =>
        v.startsWith("https://qyapi.weixin.qq.com/") || "请输入有效的企业微信 Webhook URL",
    });
    envVars.AGENTWAKE_WECOM_WEBHOOK = webhook;
  }

  // Step 5: Ensure .env exists in ~/.agentwake/
  if (!existsSync(envPath)) {
    const exampleSrc = path.join(PKG_ROOT, ".env.example");
    if (existsSync(exampleSrc)) {
      copyFileSync(exampleSrc, envPath);
    }
    console.log(`📄 已创建 ${envPath}`);
  }

  // Merge title vars into envVars
  Object.assign(envVars, eventTitleVars);

  // Write config to .env
  if (Object.keys(envVars).length > 0) {
    writeEnvFile(envPath, envVars);
    console.log(`\n✅ 配置已写入 ${envPath}`);
  }

  // Step 6: Install Claude Code hooks
  if (aiTool === "claude-code" || aiTool === "all") {
    if (selectedEvents.length > 0) {
      const existing = readEnvFile(envPath);
      const httpsEnabled = existing.AGENTWAKE_HTTPS_ENABLED === "1";
      const port = existing.AGENTWAKE_PORT || "3199";
      const protocol = httpsEnabled ? "https" : "http";
      const gatewayUrl = `${protocol}://127.0.0.1:${port}`;

      const installer = new ClaudeCodeInstaller(gatewayUrl);
      await installer.install(selectedEvents);
      console.log(`✅ Claude Code hooks 已安装 (${selectedEvents.length} 个事件)`);
      console.log(`   脚本路径: ${path.join(os.homedir(), ".agentwake", "hooks", "claude-hook-relay.sh")}`);
    }
  }

  // Step 7: Start server
  const shouldStart = await confirm({
    message: "是否立即启动服务？",
    default: true,
  });

  if (shouldStart) {
    // Load env and start
    const dotenv = await import("dotenv");
    dotenv.config({ path: envPath });
    // Apply our new env vars too
    for (const [key, value] of Object.entries(envVars)) {
      process.env[key] = value;
    }
    process.env.AGENTWAKE_HTTPS_ENABLED = "1";

    const { runGateway } = await import("./run-gateway");
    await runGateway();
  }

  const localIp = getLocalIp();
  if (localIp) {
    const existing = readEnvFile(envPath);
    const port = existing.AGENTWAKE_PORT || "3199";
    const protocol = existing.AGENTWAKE_HTTPS_ENABLED === "1" ? "https" : "http";
    console.log(`\n📱 手机浏览器打开：${protocol}://${localIp}:${port}`);
  }

  console.log("\n🎉 配置完成！\n");
}
