# AgentWake

跨编辑器的 AI 编程通知网关。支持 Cursor / Claude Code / Qoder，当 AI 任务完成、异常终止或等待授权时，实时推送通知到桌面、手机和 IM 群。

## 效果预览

<p align="center">
  <img src="docs/screenshots/web.jpg" width="48%" alt="Web 界面" />
  <img src="docs/screenshots/mobile_notify.jpg" width="48%" alt="手机通知" />
</p>

<p align="center">
  <img src="docs/screenshots/cursor.png" width="48%" alt="Cursor 通知" />
  <img src="docs/screenshots/qoder.png" width="48%" alt="Qoder 通知" />
</p>

---

## 核心特性

- **多编辑器支持** — Cursor Hook、Claude Code Hook、Qoder 日志监听
- **多通知渠道** — 桌面系统通知、PWA 网页推送、钉钉、飞书、企业微信
- **Claude Code 深度集成** — 支持 Stop / Notification / StopFailure / SessionEnd 等全部 Hook 事件，可自定义每个事件的通知标题
- **移动端实时推送** — 内置 PWA Web App，HTTPS + WebSocket 毫秒级推送，支持扫码连接
- **智能防打扰** — 事件去重 + 速率限流，避免消息轰炸
- **交互式配置** — `agentwake setup` 一步步引导完成全部配置

---

## 快速开始

### 环境要求

- Node.js >= 18
- [mkcert](https://github.com/FiloSottile/mkcert)（生成本地 HTTPS 证书，移动端推送必需）

### 安装

```bash
npm i -g agentwake
```

### 方式一：交互式引导（推荐）

```bash
agentwake init     # 生成 HTTPS 证书到 ~/.agentwake/certs/
agentwake setup    # 交互式配置向导
```

`setup` 会引导你完成：
1. 选择 AI 工具（Claude Code / Cursor / 全部）
2. 选择监听的事件类型
3. 自定义每个事件的通知标题（可选）
4. 选择通知渠道（钉钉 / 飞书 / 企业微信）
5. 输入 Webhook 地址和密钥
6. 自动安装 Claude Code Hooks 到 `~/.claude/settings.json`
7. 启动服务

### 方式二：手动配置

```bash
agentwake init    # 生成 ~/.agentwake/.env 和 HTTPS 证书
# 编辑 ~/.agentwake/.env 填入配置
agentwake start
```

所有数据存放在 `~/.agentwake/` 目录下，无需手动创建工作目录。

### 方式三：从源码启动

```bash
git clone https://github.com/tjdxwwj/agentwake.git
cd agentwake
npm install

# 初始化（生成 HTTPS 证书和 .env）
npm run init

# 交互式配置
npm run setup

# 启动开发服务器
npm run dev
```

启动后服务运行在 `https://localhost:3199`。

---

## 通知渠道

| 渠道 | 配置方式 | 说明 |
|------|---------|------|
| 桌面系统通知 | 内置，无需配置 | macOS / Windows / Linux |
| PWA 网页推送 | 内置，手机浏览器打开服务地址 | 需 HTTPS，支持 Service Worker 系统通知 |
| 钉钉 | `AGENTWAKE_DINGTALK_WEBHOOK` | 群机器人 Webhook，支持签名校验 |
| 飞书 | `AGENTWAKE_FEISHU_WEBHOOK` | 群机器人 Webhook，支持签名校验 |
| 企业微信 | `AGENTWAKE_WECOM_WEBHOOK` | 群机器人 Webhook，安全性由 URL Key 保证 |

### 钉钉配置

在钉钉群 -> 群设置 -> 智能群助手 -> 添加机器人 -> 自定义 Webhook，复制 Webhook 地址。

```env
AGENTWAKE_DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=xxx
AGENTWAKE_DINGTALK_SECRET=SECxxx   # 可选，签名密钥
```

### 飞书配置

在飞书群 -> 设置 -> 群机器人 -> 添加自定义机器人，复制 Webhook 地址。

```env
AGENTWAKE_FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
AGENTWAKE_FEISHU_SECRET=xxx   # 可选，签名校验密钥
```

### 企业微信配置

在企业微信群 -> 群机器人 -> 添加群机器人，复制 Webhook 地址。

```env
AGENTWAKE_WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
```

---

## 编辑器接入

### Claude Code

运行 `agentwake setup` 会自动完成以下操作：
- 生成 Hook 转发脚本到 `~/.agentwake/hooks/claude-hook-relay.sh`
- 写入 Hook 配置到 `~/.claude/settings.json`

支持的 Hook 事件：

| 事件 | 说明 | 默认启用 |
|------|------|---------|
| Notification | 需要用户注意 | 是 |
| Stop | 任务完成 | 是 |
| StopFailure | 任务异常终止 | 是 |
| SessionEnd | 会话结束 | 是 |
| SessionStart | 会话开始 | 否 |
| PreToolUse | 工具调用前 | 否 |
| PostToolUse | 工具调用后 | 否 |

### Cursor

1. 在项目中执行 `agentwake init`
2. 保持 `agentwake start` 运行
3. Cursor 终端触发授权等待时自动通知

### Qoder

自动发现日志目录，或手动指定：

```bash
AGENTWAKE_QODER_LOG_PATH=”/path/to/agent.log” agentwake start
```

---

## 自定义通知标题

通过 `agentwake setup` 交互式设置，或直接在 `.env` 中配置：

```env
AGENTWAKE_CLAUDE_TITLE_STOP=AI搞定了
AGENTWAKE_CLAUDE_TITLE_STOP_FAILURE=AI挂了
AGENTWAKE_CLAUDE_TITLE_NOTIFICATION=AI喊你看一眼
AGENTWAKE_CLAUDE_TITLE_SESSION_END=会话结束了
```

未配置的事件使用默认标题。

---

## 移动端 PWA 设置

手机需要信任本地 HTTPS 证书才能接收 Service Worker 系统通知。

1. 获取根证书路径：`mkcert -CAROOT`，找到 `rootCA.pem`
2. 安装到手机：
   - **iOS** — 发送到手机安装描述文件，然后在 设置 > 通用 > 关于本机 > 证书信任设置 中启用完全信任
   - **Android** — 在安全设置中安装 CA 证书（可能需要改后缀为 `.crt`）
3. 手机浏览器打开 `https://<局域网IP>:3199`，确认 HTTPS 连接安全后允许通知权限

---

## 全部环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENTWAKE_HOST` | `0.0.0.0` | 监听地址 |
| `AGENTWAKE_PORT` | `3199` | 监听端口 |
| `AGENTWAKE_HTTPS_ENABLED` | `1` | 是否启用 HTTPS |
| `AGENTWAKE_HTTPS_CERT_PATH` | `certs/dev-cert.pem` | HTTPS 证书路径 |
| `AGENTWAKE_HTTPS_KEY_PATH` | `certs/dev-key.pem` | HTTPS 私钥路径 |
| `AGENTWAKE_DESKTOP_ENABLED` | `1` | 是否启用桌面系统通知（`0` 关闭） |
| `AGENTWAKE_PWA_ENABLED` | `1` | 是否启用 PWA/WebSocket 推送（`0` 关闭） |
| `AGENTWAKE_DINGTALK_ENABLED` | `1` | 是否启用钉钉通知（`0` 关闭） |
| `AGENTWAKE_DINGTALK_WEBHOOK` | — | 钉钉 Webhook URL |
| `AGENTWAKE_DINGTALK_SECRET` | — | 钉钉签名密钥 |
| `AGENTWAKE_FEISHU_ENABLED` | `1` | 是否启用飞书通知（`0` 关闭） |
| `AGENTWAKE_FEISHU_WEBHOOK` | — | 飞书 Webhook URL |
| `AGENTWAKE_FEISHU_SECRET` | — | 飞书签名密钥 |
| `AGENTWAKE_WECOM_ENABLED` | `1` | 是否启用企业微信通知（`0` 关闭） |
| `AGENTWAKE_WECOM_WEBHOOK` | — | 企业微信 Webhook URL |
| `AGENTWAKE_CLAUDE_TITLE_*` | — | Claude 事件自定义标题 |
| `AGENTWAKE_DEDUPE_WINDOW_MS` | `10000` | 去重窗口（毫秒） |
| `AGENTWAKE_RATE_LIMIT_WINDOW_MS` | `10000` | 限流窗口（毫秒） |
| `AGENTWAKE_RATE_LIMIT_MAX_EVENTS` | `40` | 窗口内最大事件数 |
| `AGENTWAKE_WS_PATH` | `/ws` | WebSocket 路径 |
| `AGENTWAKE_QODER_LOG_PATH` | — | Qoder 日志路径（自动发现） |
| `AGENTWAKE_ALLOWED_HOOK_IPS` | — | 限制 Hook 来源 IP（逗号分隔） |

---

## 开发

```bash
git clone https://github.com/tjdxwwj/agentwake.git
cd agentwake
npm install
cp .env.example .env
npm run init     # 生成本地证书
npm run dev      # 启动开发服务器
npm test         # 运行测试
```

### 目录结构

```
src/
  adapters/       # 输入适配器（Cursor / Claude / Qoder）
  gateway/        # 核心网关（Adapter 注册、事件路由）
  notifiers/      # 通知分发（桌面 / WebSocket / 钉钉 / 飞书 / 企业微信）
  installers/     # Hook 自动安装器
web/              # PWA 前端
```

### 技术栈

Node.js + TypeScript + Express + WebSocket (ws) + Zod

---

## FAQ

**手机收不到通知？**
1. 确认手机和电脑在同一局域网
2. 确认浏览器显示安全的 HTTPS 连接（非”不安全”）
3. 确认已授予通知权限
4. 检查 Web 页面 WebSocket 状态是否为”已连接”

**如何修改端口？**
```bash
AGENTWAKE_PORT=4000 agentwake start
```

**个人微信能收通知吗？**
微信不支持 Webhook 消息推送 API。可以使用企业微信群机器人作为替代。

---

MIT License
