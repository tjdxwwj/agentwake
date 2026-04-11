import fs from "node:fs";
import path from "node:path";
import { confirm } from "@inquirer/prompts";
import { ClaudeCodeInstaller } from "./installers/claude-code-installer";
import { AGENTWAKE_HOME } from "./paths";

/** True if this Cursor hook command was installed for AgentWake forwarding. */
export function isAgentwakeCursorHookCommand(command: string): boolean {
  if (!command || typeof command !== "string") {
    return false;
  }
  if (command.includes("cursor-hook-forwarder.mjs")) {
    return true;
  }
  if (/agentwake/i.test(command) && /hooks\/cursor/i.test(command)) {
    return true;
  }
  return false;
}

type CursorHooksFile = {
  version?: number;
  hooks?: Record<string, Array<{ command?: string; [key: string]: unknown }>>;
};

/**
 * Remove AgentWake hook entries from `.cursor/hooks.json`. Returns counts for logging.
 */
export function cleanCursorHooksJson(hooksPath: string): { removed: number; changed: boolean } {
  if (!fs.existsSync(hooksPath)) {
    return { removed: 0, changed: false };
  }
  let parsed: CursorHooksFile;
  try {
    parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as CursorHooksFile;
  } catch {
    console.warn(`[agentwake] 跳过无效的 hooks.json（无法解析 JSON）: ${hooksPath}`);
    return { removed: 0, changed: false };
  }
  if (!parsed.hooks || typeof parsed.hooks !== "object") {
    return { removed: 0, changed: false };
  }

  let removed = 0;
  for (const key of Object.keys(parsed.hooks)) {
    const entries = parsed.hooks[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    const next = entries.filter((entry) => {
      const cmd = typeof entry.command === "string" ? entry.command : "";
      if (isAgentwakeCursorHookCommand(cmd)) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (next.length === 0) {
      delete parsed.hooks[key];
    } else {
      parsed.hooks[key] = next;
    }
  }

  if (removed === 0) {
    return { removed: 0, changed: false };
  }

  fs.writeFileSync(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { removed, changed: true };
}

function removePathIfExists(p: string, label: string): void {
  if (!fs.existsSync(p)) {
    return;
  }
  fs.rmSync(p, { recursive: true, force: true });
  console.log(`✅ ${label}: ${p}`);
}

function unlinkIfExists(p: string, label: string): void {
  if (!fs.existsSync(p)) {
    return;
  }
  fs.unlinkSync(p);
  console.log(`✅ ${label}: ${p}`);
}

export type RunCleanOptions = {
  /** Skip confirmation prompt */
  yes: boolean;
  /** Project root used for `.cursor/hooks.json` and local artifacts */
  cwd: string;
};

/**
 * Uninstall AgentWake: Claude hooks, Cursor hooks (cwd), ~/.agentwake, local debug/cache files.
 * Qoder log tailing uses `AGENTWAKE_QODER_LOG_PATH` in ~/.agentwake/.env — removing the data dir clears it.
 */
export async function runClean(options: RunCleanOptions): Promise<void> {
  const { yes, cwd } = options;

  if (!yes) {
    const ok = await confirm({
      message: `将移除 Claude Code 中的 AgentWake Hook、删除数据目录 ${AGENTWAKE_HOME}（含证书与 .env）、并清理当前目录下 Cursor/Qoder 相关配置。是否继续？`,
      default: false,
    });
    if (!ok) {
      console.log("已取消。");
      return;
    }
  }

  const claudeInstaller = new ClaudeCodeInstaller("http://127.0.0.1:3199");
  await claudeInstaller.uninstall();
  console.log("✅ 已从 ~/.claude/settings.json 移除 AgentWake（Claude Code Hook）");

  const hooksPath = path.join(cwd, ".cursor", "hooks.json");
  const { removed, changed } = cleanCursorHooksJson(hooksPath);
  if (changed) {
    console.log(`✅ 已从 .cursor/hooks.json 移除 ${removed} 条 AgentWake 相关 Hook`);
  } else {
    console.log(`ℹ️  Cursor hooks：未找到需移除的 AgentWake 项（或文件不存在）`);
  }

  if (fs.existsSync(AGENTWAKE_HOME)) {
    fs.rmSync(AGENTWAKE_HOME, { recursive: true, force: true });
    console.log(`✅ 已删除数据目录 ${AGENTWAKE_HOME}`);
  } else {
    console.log(`ℹ️  数据目录不存在，跳过: ${AGENTWAKE_HOME}`);
  }

  removePathIfExists(path.join(cwd, ".agentwake"), "已删除项目内调试目录");

  const qoderDir = path.join(cwd, ".qoder");
  unlinkIfExists(path.join(qoderDir, "cursor-hook-debug.jsonl"), "已删除 Qoder 调试日志");
  unlinkIfExists(path.join(qoderDir, "cursor-approval-cache.json"), "已删除 Qoder 授权缓存");

  console.log("\n🎉 AgentWake 清理完成。请停止正在运行的 `agentwake start` 进程（若仍在运行）。\n");
}
