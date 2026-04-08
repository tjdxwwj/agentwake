# AgentWake 🚀

**AgentWake** 是一个跨编辑器（Cursor / Claude Code / Qoder）的终端授权提醒网关。  
当你在使用 AI 辅助编程工具时，终端任务经常会进入“等待用户同意（Approval）”状态。AgentWake 会在桌面和移动端为你提供实时通知，让你无需时刻盯着屏幕，告别阻塞等待！

---

## 📸 预览 (Screenshots)

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/web.jpg" alt="移动端控制台" height="400" /></td>
    <td align="center"><img src="docs/screenshots/mobile_notify.jpg" alt="移动端实时通知" height="400" /></td>
  </tr>
  <tr>
    <td align="center"><strong>移动端控制台 (PWA)</strong></td>
    <td align="center"><strong>手机实时锁屏通知</strong></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/screenshots/cursor.png" alt="Cursor 提醒" width="600" /></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><strong>Cursor 终端授权提醒</strong></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><img src="docs/screenshots/qoder.png" alt="Qoder 提醒" width="600" /></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><strong>Qoder 日志授权提醒</strong></td>
  </tr>
</table>

---

## 🌟 核心特性

- **多编辑器支持**：原生支持监听 Cursor Hook、Claude Hook 以及 Qoder 日志中的授权等待信号。
- **全平台桌面通知**：支持 macOS、Windows、Linux 的系统级弹窗提醒。
- **移动端实时提醒**：内置移动端 Web 应用，支持 PWA 安装，通过 HTTPS + WebSocket 实现手机端毫秒级推送。
- **智能防打扰**：内置去重和限流机制，避免消息重复轰炸。
- **开箱即用**：提供极简的 CLI 命令行工具，一键初始化与启动。

---

## 🚀 快速开始

### 环境要求

- Node.js (推荐 v18+)
- [mkcert](https://github.com/FiloSottile/mkcert) (用于生成本地 HTTPS 证书，移动端访问必备)

### 安装与启动

1. **全局安装 CLI**
   ```bash
   npm i -g agentwake
   ```

2. **初始化项目与证书**
   ```bash
   mkdir my-agentwake && cd my-agentwake
   agentwake init
   ```
   *注意：初始化过程中会自动使用 mkcert 生成本地 HTTPS 证书。*

3. **启动网关服务**
   ```bash
   agentwake start
   ```

启动后，网关默认运行在 `https://localhost:3199` (或者局域网 IP)。

---

## 🔌 编辑器接入指南

### Cursor 接入

AgentWake 已经内置了对 Cursor 工作流的支持：
1. 确保在目标项目中执行过 `agentwake init`。
2. 保持 `agentwake start` 运行。
3. 当 Cursor 终端触发需要用户授权的命令时，你将立刻收到通知。

### Qoder 接入

AgentWake 会尝试自动发现 Qoder 的日志目录（如 macOS 下的 `~/Library/Application Support/Qoder/logs/.../agent.log`）。

如果自动发现失败，你可以通过环境变量手动指定日志路径：
```bash
AGENTWAKE_QODER_LOG_PATH="/ABSOLUTE/PATH/TO/agent.log" agentwake start
```

---

## 📱 移动端访问与证书信任（必读）

为了在手机上接收实时通知，你必须让手机信任电脑上由 `mkcert` 生成的根证书。

1. 找到根证书位置：
   在电脑终端运行 `mkcert -CAROOT`，找到目录下的 `rootCA.pem` 文件。
2. 安装到手机：
   - **iOS**：将文件发送到手机，在“设置”中安装描述文件，并在“通用 -> 关于本机 -> 证书信任设置”中开启“完全信任”。
   - **Android**：将文件发送到手机，在安全设置中“从存储设备安装” CA 证书（部分安卓系统可能需要将后缀改为 `.crt`）。
3. Node.js TLS 兼容（如果遇到本地转发报错）：
   ```bash
   export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
   ```

---

## 🛠️ 面向开发者

如果你想参与 AgentWake 的开发，请参考以下指南：

### 技术栈
- **后端**：Node.js + TypeScript + Express + WebSocket (`ws`) + Zod
- **前端**：HTML/CSS/JS (PWA 支持)
- **系统交互**：`node-notifier` (桌面通知)

### 本地开发

```bash
# 1. 克隆代码并安装依赖
git clone https://github.com/your-username/agentwake.git
cd agentwake
npm install

# 2. 准备环境变量
cp .env.example .env

# 3. 初始化（生成本地证书等）
npm run init

# 4. 启动开发服务器
npm run dev
```

### 核心目录结构
- `src/adapters/`：各类编辑器（Cursor/Claude/Qoder）的输入信号适配器。
- `src/gateway/`：核心网关，负责 Adapter 注册与事件路由。
- `src/notifiers/`：通知分发器（桌面系统通知、移动端 WebSocket、PWA Push）。
- `web/`：移动端 Web App 源码。

---

## ❓ 常见问题 (FAQ)

**Q: 为什么手机端收不到通知？**  
A: 请按顺序检查：
1. 手机是否和电脑在同一局域网下。
2. 手机浏览器是否显示“安全/受信任”的 HTTPS 连接（若显示不安全，请重新检查证书安装步骤）。
3. 检查 Web 页面上的 WebSocket 连接状态是否显示为“已连接”。

**Q: 能否自定义运行端口？**  
A: 可以，通过 CLI 参数或环境变量修改：
```bash
agentwake start --port 4000
# 或者使用环境变量
AGENTWAKE_PORT=4000 agentwake start
```

---

*AgentWake - 让 AI 编程更省心。*
