import { checkbox, input, password, confirm } from "@inquirer/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeInstaller } from "./installers/claude-code-installer";
import { ensureHome, homePath } from "./paths";
import {
  ensureCursorShellHooks,
  ensureEnvFile,
  ensureHooksHttps,
  ensureHttpsEnv,
  ensureNodeExtraCaEnvHint,
  setupMkcert,
} from "./setup-bootstrap";

const CLAUDE_CODE_EVENTS = [
  { name: "Notification — 需要用户注意时", value: "Notification", defaultEnabled: true },
  { name: "Stop — 任务完成停止时", value: "Stop", defaultEnabled: false },
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
  ensureEnvFile();
  const envPath = homePath(".env");

  const useHttps = await confirm({
    message:
      "是否启用 HTTPS？（手机 / PWA 访问建议开启；需本机已安装 mkcert，例如 brew install mkcert）",
    default: false,
  });
  ensureHttpsEnv(useHttps);
  if (useHttps) {
    setupMkcert();
    ensureNodeExtraCaEnvHint();
  }

  // Step 1: Select AI tools（多选；↑↓ 移动，空格勾选，a 全选，i 反选，回车确认）
  const aiTools = await checkbox({
    message: "选择要配置的 AI 工具",
    required: true,
    choices: [
      { name: "Claude Code", value: "claude-code", checked: true },
      { name: "Cursor", value: "cursor", checked: true },
      { name: "Qoder", value: "qoder", checked: false },
    ],
  });

  const wantClaude = aiTools.includes("claude-code");
  const wantCursor = aiTools.includes("cursor");
  const wantQoder = aiTools.includes("qoder");

  let qoderLogPathInput = "";
  if (wantQoder) {
    qoderLogPathInput = await input({
      message: "Qoder agent.log 路径（可选，留空则按常见安装目录自动发现）：",
      default: "",
    });
  }

  // Step 2: Select Claude Code events (if applicable)
  let selectedEvents: string[] = [];
  if (wantClaude) {
    selectedEvents = await checkbox({
      message: "选择要监听的 Claude Code 事件",
      required: false,
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
    message: "选择通知渠道（桌面通知默认开启；PWA 默认关闭，需 HTTPS 时建议开启）",
    required: false,
    choices: [
      { name: "钉钉 Webhook", value: "dingtalk" },
      { name: "飞书 Webhook", value: "feishu" },
      { name: "企业微信 Webhook", value: "wecom" },
      { name: "PWA 网页推送 / WebSocket（默认关闭）", value: "pwa", checked: false },
      { name: "桌面系统通知（已内置）", value: "desktop", checked: true, disabled: "默认启用" },
    ],
  });

  // Step 4: Collect webhook configs
  const envVars: Record<string, string> = {};
  envVars.AGENTWAKE_CURSOR_ENABLED = wantCursor ? "1" : "0";
  envVars.AGENTWAKE_CLAUDE_ENABLED = wantClaude ? "1" : "0";
  envVars.AGENTWAKE_QODER_ENABLED = wantQoder ? "1" : "0";

  if (channels.includes("dingtalk")) {
    const webhook = await input({
      message: "输入钉钉 Webhook URL：",
      validate: (v: string) => v.startsWith("https://") || "请输入有效的 HTTPS URL",
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
      validate: (v: string) => v.startsWith("https://") || "请输入有效的 HTTPS URL",
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
      validate: (v: string) =>
        v.startsWith("https://qyapi.weixin.qq.com/") || "请输入有效的企业微信 Webhook URL",
    });
    envVars.AGENTWAKE_WECOM_WEBHOOK = webhook;
  }

  if (wantQoder && qoderLogPathInput.trim()) {
    envVars.AGENTWAKE_QODER_LOG_PATH = qoderLogPathInput.trim();
  } else if (!wantQoder) {
    // Disable stale explicit path to avoid confusion when Qoder adapter is turned off.
    envVars.AGENTWAKE_QODER_LOG_PATH = "";
  }

  envVars.AGENTWAKE_PWA_ENABLED = channels.includes("pwa") ? "1" : "0";

  // Merge title vars into envVars
  Object.assign(envVars, eventTitleVars);

  // Write config to .env
  if (Object.keys(envVars).length > 0) {
    writeEnvFile(envPath, envVars);
    console.log(`\n✅ 配置已写入 ${envPath}`);
  }

  // Step 6: Install Claude Code hooks
  if (wantClaude && selectedEvents.length > 0) {
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

  if (wantCursor) {
    ensureCursorShellHooks();
    console.log(
      `\n✅ Cursor：已在项目根目录写入/补全 .cursor/hooks.json（终端 stdin → cursor-hook-forwarder → 网关）\n`,
    );
  }

  ensureHooksHttps();

  // Step 7: Start server
  const shouldStart = await confirm({
    message: "是否立即启动服务？",
    default: true,
  });

  if (shouldStart) {
    // Load env and start
    const dotenv = await import("dotenv");
    dotenv.config({ path: envPath, override: true });
    // Apply our new env vars too
    for (const [key, value] of Object.entries(envVars)) {
      process.env[key] = value;
    }

    const { runGateway } = await import("./run-gateway");
    await runGateway();
  }

  const localIp = getLocalIp();
  const existing = readEnvFile(envPath);
  const pwaEnabled = existing.AGENTWAKE_PWA_ENABLED === "1";
  if (localIp && pwaEnabled) {
    const port = existing.AGENTWAKE_PORT || "3199";
    const protocol = existing.AGENTWAKE_HTTPS_ENABLED === "1" ? "https" : "http";
    console.log(`\n📱 手机浏览器打开：${protocol}://${localIp}:${port}`);
  }

  console.log("\n🎉 配置完成！\n");
}
