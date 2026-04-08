const APP_VERSION = "debug9";
const statusEl = document.getElementById("status");
const eventsEl = document.getElementById("events");
const notificationBtn = document.getElementById("btn-notification");
const testNotificationBtn = document.getElementById("btn-test-notification");
const pwaBtn = document.getElementById("btn-pwa");
const installBtn = document.getElementById("btn-install");
const installCheckBtn = document.getElementById("btn-install-check");
const debugLogEl = document.getElementById("debug-log");

let wsPath = "/ws";
let wsRetryTimer = null;
let wsConnected = false;
let lastTimestamp = 0;
const seenEventKeys = new Set();
const debugLines = [];
let swRegistration = null;
let deferredInstallPrompt = null;
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
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
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
    canPromptInstall: Boolean(deferredInstallPrompt),
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
  if (!deferredInstallPrompt && isAndroid) {
    setStatus("可手动安装：Chrome 菜单 ⋮ -> 安装应用/添加到主屏幕");
    return;
  }
  setStatus("安装条件基本满足，可继续安装");
}

async function onEnablePwaPushClick() {
  const registration = swRegistration ?? (await setupServiceWorker());
  if (!registration) {
    setStatus("Service Worker 注册失败，无法启用 PWA Push");
    return;
  }
  const keyResp = await fetch("/api/push/public-key");
  debugLog("pwa public-key response", { status: keyResp.status });
  if (!keyResp.ok) {
    setStatus("服务端未配置 VAPID，无法启用 Push");
    return;
  }
  const keyData = await keyResp.json();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
  });
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscription }),
  });
  debugLog("pwa subscribe success");
  setStatus("PWA Push 订阅成功");
}

async function onInstallClick() {
  if (!deferredInstallPrompt) {
    const ua = navigator.userAgent || "";
    const isAndroid = /Android/i.test(ua);
    if (isAndroid) {
      setStatus("Android 请点浏览器菜单 ⋮ -> 安装应用/添加到主屏幕");
    } else {
      setStatus("iOS 请在 Safari 分享菜单中“添加到主屏幕”");
    }
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  debugLog("install prompt choice", { outcome: choice?.outcome });
  deferredInstallPrompt = null;
}

function onTestNotificationClick() {
  const testEvent = {
    source: "manual-test",
    title: "AgentWake 测试通知",
    body: `测试时间：${new Date().toLocaleTimeString()}`,
    timestamp: Date.now(),
    dedupeKey: `manual-test:${Date.now()}`,
  };
  debugLog("manual notification test", { permission: Notification.permission });
  appendEvent(testEvent);
  void showSystemNotification(testEvent);
  if (Notification.permission !== "granted") {
    setStatus(`通知权限不是 granted（当前：${Notification.permission}）`);
    return;
  }
  setStatus("已触发系统通知测试");
}

if (notificationBtn) {
  notificationBtn.addEventListener("click", () => {
    hapticFeedback();
    void onRequestPermissionClick();
  });
} else {
  debugLog("btn missing", { id: "btn-notification" });
}

if (testNotificationBtn) {
  testNotificationBtn.addEventListener("click", () => {
    hapticFeedback();
    onTestNotificationClick();
  });
} else {
  debugLog("btn missing", { id: "btn-test-notification" });
}

if (pwaBtn) {
  pwaBtn.addEventListener("click", () => {
    hapticFeedback();
    void onEnablePwaPushClick();
  });
} else {
  debugLog("btn missing", { id: "btn-pwa" });
}

if (installBtn) {
  installBtn.addEventListener("click", () => {
    hapticFeedback();
    void onInstallClick();
  });
} else {
  debugLog("btn missing", { id: "btn-install" });
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

  if (target.id === "btn-test-notification") {
    debugLog("delegated click", { id: target.id });
    onTestNotificationClick();
  }
  if (target.id === "btn-notification") {
    debugLog("delegated click", { id: target.id });
    void onRequestPermissionClick();
  }
  if (target.id === "btn-pwa") {
    debugLog("delegated click", { id: target.id });
    void onEnablePwaPushClick();
  }
  if (target.id === "btn-install") {
    debugLog("delegated click", { id: target.id });
    void onInstallClick();
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
  void setupServiceWorker();
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

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  debugLog("beforeinstallprompt captured");
  setStatus("可安装应用：点击“安装应用”");
});

void init().catch((error) => {
  debugLog("init failed", { error: String(error) });
  setStatus("初始化失败，请查看调试日志");
});
