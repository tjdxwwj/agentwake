# AgentWake

跨编辑器通知网关：监听 `Cursor` / `Claude Code` / `Qoder` 的“等待用户允许”信号，并在 PC 与移动端通知用户。

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

默认地址：`http://localhost:3199`

## 输入通道

- Cursor Hook: `POST /hooks/cursor`
- Claude Hook: `POST /hooks/claude`
- Qoder Log: 读取 `AGENTWAKE_QODER_LOG_PATH` 对应日志

Hook 请求默认不需要 token（已关闭鉴权）。

## 先接入 Cursor 终端 Hook

根据 Cursor Hooks 文档，终端相关事件是 `beforeShellExecution` 和 `afterShellExecution`。  
本项目已提供转发脚本：`scripts/cursor-hook-forwarder.mjs`。

1) 启动网关服务

```bash
npm run dev
```

2) 在 Cursor 的 `hooks.json` 配置（项目级 `.cursor/hooks.json`）

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      {
        "command": "AGENTWAKE_GATEWAY_URL='http://127.0.0.1:3199/hooks/cursor' node /ABSOLUTE/PATH/TO/agentwake/scripts/cursor-hook-forwarder.mjs"
      }
    ],
    "afterShellExecution": [
      {
        "command": "AGENTWAKE_GATEWAY_URL='http://127.0.0.1:3199/hooks/cursor' node /ABSOLUTE/PATH/TO/agentwake/scripts/cursor-hook-forwarder.mjs"
      }
    ]
  }
}
```

3) 效果

- 只在识别到“等待用户同意/授权”的信号时触发通知（例如 `permission=ask`、`pendingApproval=true`、`waiting for user approval`）
- 普通的 `beforeShellExecution`（仅表示命令准备执行）不会触发通知，避免噪音

## 输出通道

- PC 系统通知（`node-notifier`）
- 移动端网页实时通知（WebSocket）
- PWA Push（需配置 VAPID）
