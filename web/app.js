const APP_VERSION = "debug11";
const statusEl = document.getElementById("status");
const eventsEl = document.getElementById("events");
const notificationBtn = document.getElementById("btn-notification");
const installCheckBtn = document.getElementById("btn-install-check");
const debugLogEl = document.getElementById("debug-log");

let wsPath = "/ws";
let wsRetryTimer = null;
let wsConnected = false;
let lastTimestamp = 0;
const seenEventKeys = new Set();
const debugLines = [];
let swRegistration = null;
let swRegisterError = null;

function debugLog(message, meta) {
  const ts = new Date().toISOString();
  const payload = meta ? `${message} ${JSON.stringify(meta)}` : message;
  const line = `[${ts}] ${payload}`;
  console.log("[AgentWake]", message, meta || "");
  debugLines.push(line);
  if (debugLines.length > 80) {
    debugLines.splice(0, debugLines.length - 80);
  }
  if (debugLogEl) {
    debugLogEl.textContent = debugLines.join("\n");
  }
}

function hapticFeedback() {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    try {
      navigator.vibrate(50); // 50ms 轻微震动反馈
    } catch (e) {
      // 忽略可能产生的震动错误
    }
  }
}

function getEventFingerprint(evt) {
  return `${evt.dedupeKey}#${evt.timestamp}`;
}

function setStatus(text) {
  if (statusEl) {
    statusEl.textContent = text;
  }
  debugLog("status", { text });
}

function appendEvent(evt) {
  const fingerprint = getEventFingerprint(evt);
  if (seenEventKeys.has(fingerprint)) {
    debugLog("skip duplicate event", { fingerprint });
    return;
  }
  seenEventKeys.add(fingerprint);
  lastTimestamp = Math.max(lastTimestamp, Number(evt.timestamp || 0));
  debugLog("append event", {
    fingerprint,
    source: evt.source,
    title: evt.title,
    timestamp: evt.timestamp,
    lastTimestamp,
  });

  const node = document.createElement("div");
  node.className = "event";
  node.innerHTML = `<div><strong>${evt.title}</strong></div><div>${evt.body}</div><div class="meta">${new Date(evt.timestamp).toLocaleString()} · ${evt.source}</div>`;
  if (eventsEl) {
    eventsEl.prepend(node);
  }
}

async function showSystemNotification(evt) {
  if (typeof Notification !== "function") {
    debugLog("notification api unavailable");
    return;
  }
  if (Notification.permission !== "granted") {
    debugLog("notification skipped", { permission: Notification.permission });
    return;
  }
  if (swRegistration && typeof swRegistration.showNotification === "function") {
    try {
      await swRegistration.showNotification(evt.title, { body: evt.body, tag: "agentwake-web" });
      debugLog("notification sent by sw", { title: evt.title });
      return;
    } catch (error) {
      debugLog("sw showNotification failed", { error: String(error) });
    }
  }
  try {
    new Notification(evt.title, { body: evt.body });
    debugLog("notification sent", { title: evt.title });
  } catch (error) {
    debugLog("notification construct failed", { error: String(error) });
    setStatus("系统通知构造失败，请先安装 PWA 并启用 Push");
  }
}

async function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${proto}://${location.host}${wsPath}`;
  const ws = new WebSocket(wsUrl);
  debugLog("ws connecting", { wsUrl });
  setStatus(`WebSocket 连接中：${wsUrl}`);

  ws.addEventListener("open", () => {
    wsConnected = true;
    debugLog("ws open", { wsUrl });
    setStatus("WebSocket 已连接");
    if (wsRetryTimer) {
      clearTimeout(wsRetryTimer);
      wsRetryTimer = null;
    }
  });

  ws.addEventListener("error", (event) => {
    debugLog("ws error", { wsUrl, type: event.type });
    setStatus(`WebSocket 连接失败：${wsUrl}`);
  });

  ws.addEventListener("close", () => {
    wsConnected = false;
    debugLog("ws close", { wsUrl });
    setStatus(`WebSocket 已断开，3秒后重连：${wsUrl}`);
    if (!wsRetryTimer) {
      wsRetryTimer = setTimeout(() => {
        wsRetryTimer = null;
        void connectWs();
      }, 3000);
    }
  });

  ws.addEventListener("message", (msg) => {
    debugLog("ws message", {
      wsUrl,
      dataType: msg.data instanceof Blob ? "blob" : typeof msg.data,
    });
    if (msg.data instanceof Blob) {
      msg.data
        .text()
        .then((text) => {
          try {
            debugLog("ws blob text", { length: text.length });
            handleWsMessage(JSON.parse(text));
          } catch (error) {
            debugLog("ws blob parse failed", { error: String(error) });
            setStatus("WebSocket 消息解析失败");
          }
        })
        .catch((error) => {
          debugLog("ws blob read failed", { error: String(error) });
          setStatus("WebSocket 消息读取失败");
        });
      return;
    }

    try {
      handleWsMessage(JSON.parse(String(msg.data)));
    } catch (error) {
      debugLog("ws message parse failed", { error: String(error) });
      setStatus("WebSocket 消息解析失败");
    }
  });
}

function handleWsMessage(parsed) {
  debugLog("handle ws message", { type: parsed?.type });
  if (parsed.type === "hello") {
    setStatus("WebSocket 握手成功");
    return;
  }

  if (parsed.type === "notify-event") {
    appendEvent(parsed.payload);
    void showSystemNotification(parsed.payload);
  }
}

async function pollEvents() {
  const pollUrl = `/api/events?since=${lastTimestamp}`;
  debugLog("poll start", { pollUrl, wsConnected, lastTimestamp });
  try {
    const resp = await fetch(pollUrl);
    if (!resp.ok) {
      debugLog("poll non-200", { status: resp.status });
      return;
    }
    const data = await resp.json();
    debugLog("poll success", { count: Array.isArray(data?.events) ? data.events.length : -1 });
    if (!Array.isArray(data?.events)) {
      debugLog("poll invalid payload");
      return;
    }

    for (const evt of data.events) {
      appendEvent(evt);
      if (!wsConnected) {
        void showSystemNotification(evt);
      }
    }
    if (!wsConnected) {
      setStatus(`WebSocket 未连接，轮询补偿中（已拉取 ${data.events.length} 条）`);
    }
  } catch {
    debugLog("poll failed");
    if (!wsConnected) {
      setStatus("WebSocket 未连接，轮询也失败");
    }
  }
}

async function onRequestPermissionClick() {
  const result = await Notification.requestPermission();
  debugLog("notification permission", { result });
  setStatus(`通知权限：${result}`);
  if (result === "granted") {
    await ensurePushSubscription();
  }
}

function base64UrlToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

async function ensurePushSubscription() {
  if (!swRegistration) {
    debugLog("push skipped: sw unavailable");
    return;
  }
  if (typeof Notification !== "function" || Notification.permission !== "granted") {
    debugLog("push skipped: permission not granted", {
      permission: typeof Notification === "function" ? Notification.permission : "unavailable",
    });
    return;
  }
  if (!("PushManager" in window)) {
    debugLog("push skipped: push manager unsupported");
    return;
  }

  const keyResp = await fetch("/api/push/public-key", { cache: "no-store" }).catch(() => null);
  if (!keyResp?.ok) {
    debugLog("push public key unavailable", { status: keyResp?.status ?? 0 });
    return;
  }
  const keyData = await keyResp.json().catch(() => null);
  const publicKey = typeof keyData?.publicKey === "string" ? keyData.publicKey : "";
  if (!publicKey) {
    debugLog("push public key empty");
    return;
  }

  let subscription = await swRegistration.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(publicKey),
      });
      debugLog("push subscribed", { endpoint: subscription.endpoint });
    } catch (error) {
      debugLog("push subscribe failed", { error: String(error) });
      return;
    }
  }

  const resp = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription }),
  }).catch(() => null);
  if (!resp?.ok) {
    debugLog("push subscribe upload failed", { status: resp?.status ?? 0 });
    return;
  }

  debugLog("push subscription synced", { endpoint: subscription.endpoint });
}

async function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    debugLog("sw not supported");
    return null;
  }
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    swRegisterError = null;
    debugLog("sw register success", { scope: swRegistration.scope });
    return swRegistration;
  } catch (error) {
    swRegisterError = String(error);
    debugLog("sw register failed", { error: String(error) });
    return null;
  }
}

async function onInstallCheckClick() {
  const manifestResp = await fetch("/manifest.webmanifest", { cache: "no-store" }).catch(() => null);
  const manifestOk = Boolean(manifestResp?.ok);
  const isAndroid = /Android/i.test(navigator.userAgent || "");
  const checklist = {
    appVersion: APP_VERSION,
    isSecureContext: window.isSecureContext,
    protocol: location.protocol,
    hasServiceWorkerApi: "serviceWorker" in navigator,
    swRegistered: Boolean(swRegistration),
    swRegisterError,
    hasManifest: manifestOk,
    isAndroid,
  };
  debugLog("installability check", checklist);

  if (!window.isSecureContext) {
    setStatus("安装失败主因：当前不是安全上下文（HTTPS 证书在手机上未受信任）");
    return;
  }
  if (!manifestOk) {
    setStatus("安装失败主因：manifest 无法访问");
    return;
  }
  if (!("serviceWorker" in navigator)) {
    setStatus("安装失败主因：浏览器不支持 Service Worker");
    return;
  }
  if (!swRegistration) {
    setStatus("安装失败主因：Service Worker 注册失败，请查看调试日志");
    return;
  }
  if (isAndroid) {
    setStatus("可手动安装：Chrome 菜单 ⋮ -> 安装应用/添加到主屏幕");
    return;
  }
  setStatus("安装条件基本满足，可继续安装");
}

if (notificationBtn) {
  notificationBtn.addEventListener("click", () => {
    hapticFeedback();
    void onRequestPermissionClick();
  });
} else {
  debugLog("btn missing", { id: "btn-notification" });
}

if (installCheckBtn) {
  installCheckBtn.addEventListener("click", () => {
    hapticFeedback();
    void onInstallCheckClick();
  });
} else {
  debugLog("btn missing", { id: "btn-install-check" });
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  
  if (target.tagName === "BUTTON" || target.closest("button")) {
    hapticFeedback();
  }

  if (target.id === "btn-notification") {
    debugLog("delegated click", { id: target.id });
    void onRequestPermissionClick();
  }
  if (target.id === "btn-install-check") {
    debugLog("delegated click", { id: target.id });
    void onInstallCheckClick();
  }
});

async function init() {
  debugLog("init start", {
    appVersion: APP_VERSION,
    href: location.href,
    protocol: location.protocol,
    host: location.host,
    notificationPermission: Notification.permission,
  });
  const runtime = await fetch("/api/runtime").then((r) => r.json()).catch(() => null);
  debugLog("runtime loaded", { runtime });
  if (runtime?.wsPath) {
    wsPath = runtime.wsPath;
    debugLog("wsPath updated", { wsPath });
  }
  await setupServiceWorker();
  if (Notification.permission === "granted") {
    await ensurePushSubscription();
  }
  void connectWs();
  setInterval(() => {
    void pollEvents();
  }, 2000);
  void pollEvents();
  debugLog("init done");
}


window.addEventListener("error", (event) => {
  debugLog("window error", { message: event.message, filename: event.filename, lineno: event.lineno });
});

window.addEventListener("unhandledrejection", (event) => {
  debugLog("unhandled rejection", { reason: String(event.reason) });
});

void init().catch((error) => {
  debugLog("init failed", { error: String(error) });
  setStatus("初始化失败，请查看调试日志");
});
