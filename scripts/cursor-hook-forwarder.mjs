#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const gatewayUrl = process.env.AGENTWAKE_GATEWAY_URL || "http://127.0.0.1:3199/hooks/cursor";
const enforceDangerousAsk = (process.env.AGENTWAKE_CURSOR_ENFORCE_ASK || "1") !== "0";
const approvalMode = (process.env.AGENTWAKE_CURSOR_APPROVAL_MODE || "cursor-ask").trim().toLowerCase();
const debugLogEnabled = (process.env.AGENTWAKE_CURSOR_DEBUG_LOG || "1") !== "0";
const debugLogFile =
  process.env.AGENTWAKE_CURSOR_DEBUG_LOG_FILE ||
  path.join(process.cwd(), ".qoder", "cursor-hook-debug.jsonl");
const approvalCacheFile =
  process.env.AGENTWAKE_CURSOR_APPROVAL_CACHE_FILE ||
  path.join(process.cwd(), ".qoder", "cursor-approval-cache.json");
const approvalCacheTtlMs = 30_000;

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\/(?!tmp\b)/i,
  /\brm\s+-rf\s+~\//i,
  /\bsudo\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bdd\s+if=/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bcurl\b.*\|\s*(sh|bash|zsh)\b/i,
];

function shouldAskForDangerousCommand(command) {
  const text = String(command || "").trim();
  if (!text) {
    return false;
  }
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

async function writeDebugLog(record) {
  if (!debugLogEnabled) {
    return;
  }
  const dir = path.dirname(debugLogFile);
  await mkdir(dir, { recursive: true });
  await appendFile(debugLogFile, `${JSON.stringify(record)}\n`, "utf8");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  return chunks.join("");
}

function resolveApprovalCacheKey(payload) {
  const generation = String(payload?.generation_id || "");
  const session = String(payload?.session_id || payload?.conversation_id || "");
  const command = String(payload?.command || "");
  if (!command) {
    return "";
  }
  return `${session}:${generation}:${command}`;
}

function loadApprovalCache() {
  try {
    if (!existsSync(approvalCacheFile)) {
      return {};
    }
    const raw = readFileSync(approvalCacheFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function saveApprovalCache(cache) {
  try {
    const dir = path.dirname(approvalCacheFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(approvalCacheFile, JSON.stringify(cache), "utf8");
  } catch {
    // ignore cache write errors
  }
}

function readCachedDecision(cacheKey) {
  if (!cacheKey) {
    return null;
  }
  const cache = loadApprovalCache();
  const now = Date.now();
  for (const [key, value] of Object.entries(cache)) {
    const ts = Number(value?.ts || 0);
    if (!ts || now - ts > approvalCacheTtlMs) {
      delete cache[key];
    }
  }
  const record = cache[cacheKey];
  saveApprovalCache(cache);
  if (!record) {
    return null;
  }
  const decision = String(record.decision || "");
  if (decision !== "allow" && decision !== "deny") {
    return null;
  }
  return decision;
}

function writeCachedDecision(cacheKey, decision) {
  if (!cacheKey) {
    return;
  }
  const cache = loadApprovalCache();
  cache[cacheKey] = { decision, ts: Date.now() };
  saveApprovalCache(cache);
}

function escapeAppleScriptText(input) {
  return String(input || "").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

async function resolveOsaDecision(command) {
  const title = "AgentWake Approval";
  const body = `检测到高风险命令:\\n${command}\\n\\n是否允许执行?`;
  const script = `display dialog "${escapeAppleScriptText(body)}" with title "${escapeAppleScriptText(title)}" buttons {"Reject","Allow"} default button "Reject" giving up after 20`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    const text = String(stdout || "");
    if (/Allow/i.test(text)) {
      return "allow";
    }
    return "deny";
  } catch {
    return "deny";
  }
}

async function forwardToGateway(params) {
  const { payload, eventName, headers } = params;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const responseText = await response.text();
    await writeDebugLog({
      ts: new Date().toISOString(),
      phase: "gateway-forwarded",
      status: response.status,
      responseText,
      eventName,
    });
  } catch (error) {
    await writeDebugLog({
      ts: new Date().toISOString(),
      phase: "forward-error",
      eventName,
      error: String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      return;
    }
    const payload = JSON.parse(raw);
    await writeDebugLog({
      ts: new Date().toISOString(),
      phase: "hook-received",
      payload,
    });
    const eventName = String(payload?.hook_event_name || "");
    if (eventName !== "beforeShellExecution" && eventName !== "afterShellExecution") {
      return;
    }
    let forwardedPayload = payload;
    if (eventName === "beforeShellExecution" && enforceDangerousAsk) {
      const command = String(payload?.command || "");
      if (shouldAskForDangerousCommand(command)) {
        const reasonText = `AgentWake risk policy matched: ${command}`;
        let reply;
        let approvalDecision = "ask";
        if (approvalMode === "osascript") {
          const cacheKey = resolveApprovalCacheKey(payload);
          const cachedDecision = readCachedDecision(cacheKey);
          approvalDecision = cachedDecision || (await resolveOsaDecision(command));
          if (!cachedDecision) {
            writeCachedDecision(cacheKey, approvalDecision);
          }
          if (approvalDecision === "allow") {
            reply = {
              continue: true,
              userMessage: `AgentWake 已同意执行: ${command}`,
              agentMessage: "User approved via AgentWake osascript dialog.",
            };
          } else {
            reply = {
              continue: false,
              permission: "deny",
              userMessage: `AgentWake 已拒绝执行: ${command}`,
              agentMessage: "User rejected via AgentWake osascript dialog.",
            };
          }
        } else {
          reply = {
            continue: false,
            permission: "ask",
            userMessage: `AgentWake 拦截到高风险命令，需手动同意后执行: ${command}`,
            agentMessage:
              "High-risk shell command detected by AgentWake policy. Request explicit user approval first.",
          };
        }
        process.stdout.write(`${JSON.stringify(reply)}\n`);
        forwardedPayload = {
          ...payload,
          permission: reply.permission,
          pendingApproval: approvalDecision === "ask",
          reason: reasonText,
          requiresApproval: true,
          approvalMode,
          approvalDecision,
        };
        await writeDebugLog({
          ts: new Date().toISOString(),
          phase: "hook-ask-returned",
          reply,
          command,
          approvalMode,
          approvalDecision,
        });
      }
    }

    const headers = {
      "content-type": "application/json",
    };
    await forwardToGateway({ payload: forwardedPayload, eventName, headers });
  } catch (error) {
    // Hook should never block Cursor's main flow.
    process.stderr.write(`[agentwake] cursor hook forward failed: ${String(error)}\n`);
    await writeDebugLog({
      ts: new Date().toISOString(),
      phase: "forward-error",
      error: String(error),
    }).catch(() => {});
  }
}

void main();
