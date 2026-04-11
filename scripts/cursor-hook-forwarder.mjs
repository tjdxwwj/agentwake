#!/usr/bin/env node
/**
 * Cursor 专用 Hook 转发：只应配置在 Cursor 的 .cursor/hooks.json 里。
 * 默认 POST http://127.0.0.1:3199/hooks/cursor；可用 AGENTWAKE_GATEWAY_URL 覆盖（须以 /hooks/cursor 结尾）。
 */
import process from "node:process";
import path from "node:path";
import { mkdir, appendFile } from "node:fs/promises";

const gatewayUrl = process.env.AGENTWAKE_GATEWAY_URL || "http://127.0.0.1:3199/hooks/cursor";
const debugLogEnabled = (process.env.AGENTWAKE_CURSOR_DEBUG_LOG || "1") !== "0";
const debugLogFile =
  process.env.AGENTWAKE_CURSOR_DEBUG_LOG_FILE ||
  path.join(process.cwd(), ".agentwake", "cursor-hook-debug.jsonl");
const forwardTimeoutMs = Number.isFinite(Number(process.env.AGENTWAKE_CURSOR_FORWARD_TIMEOUT_MS))
  ? Math.max(100, Number(process.env.AGENTWAKE_CURSOR_FORWARD_TIMEOUT_MS))
  : 800;

function resolveClientHint() {
  const envHint = String(process.env.AGENTWAKE_CLIENT_HINT || "")
    .trim()
    .toLowerCase();
  if (envHint === "cursor" || envHint === "qoder") {
    return envHint;
  }
  const cwd = process.cwd().toLowerCase();
  if (cwd.includes("/.qoder") || cwd.includes("\\.qoder")) {
    return "qoder";
  }
  return "cursor";
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

async function forwardToGateway(params) {
  const { payload, eventName, headers } = params;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), forwardTimeoutMs);
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

function resolveEventName(payload) {
  return String(payload?.hook_event_name || "").trim();
}

function isForwardableEvent(eventName) {
  const lowered = String(eventName || "").trim().toLowerCase();
  return (
    lowered === "beforeshellexecution" ||
    lowered === "aftershellexecution" ||
    lowered === "stop" ||
    lowered === "stopfailure" ||
    lowered === "sessionstart" ||
    lowered === "sessionend" ||
    lowered === "notification" ||
    lowered === "pretooluse" ||
    lowered === "posttooluse" ||
    lowered === "posttoolusefailure"
  );
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      return;
    }
    const payload = JSON.parse(raw);
    const clientHint = resolveClientHint();
    const enrichedPayload = {
      ...payload,
      __agentwake_client_hint: clientHint,
      __agentwake_forwarder_cwd: process.cwd(),
    };
    await writeDebugLog({
      ts: new Date().toISOString(),
      phase: "hook-received",
      payload: enrichedPayload,
    });
    const eventName = resolveEventName(enrichedPayload);
    if (!isForwardableEvent(eventName)) {
      return;
    }
    const headers = {
      "content-type": "application/json",
    };
    await forwardToGateway({ payload: enrichedPayload, eventName, headers });
  } catch (error) {
    process.stderr.write(`[agentwake] cursor hook forward failed: ${String(error)}\n`);
    await writeDebugLog({
      ts: new Date().toISOString(),
      phase: "forward-error",
      error: String(error),
    }).catch(() => {});
  }
}

void main();
