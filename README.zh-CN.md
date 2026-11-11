# MCP Windows 完整部署工具包 ⚡

> **一个包，把 ChatGPT 网页版接到你自己的电脑上。**
> 本地优先 · 不携带账号与密钥 · 一条命令拉起隧道 · 网页控制台统一管理

**构建标识：20261109-rc21-r1 · Windows 10/11 x64**

> ⭐ **如果这个项目帮你省了时间，请点右上角 Star —— 你的一个 Star 是这个工具继续更新的最大动力！**

---

## 这是什么？为什么值得用？

MCP（Model Context Protocol）让 ChatGPT、Claude 这类模型可以调用**真实工具**——读写文件、编译论文、操作 IDE。但它默认需要你有一台常驻、能被外网访问的服务器，配置繁琐、门槛很高。

**本项目把这些门槛全部打平**：

- 🚀 **一个部署包，覆盖四类服务**：Overleaf 论文编译、Antigravity IDE 操作、DSH ChatGPT 桥接、以及本地账号控制台。
- 🖥️ **图形化控制台**：在浏览器里点几下，就能添加/编辑/启停 MCP 服务、配置隧道凭据、一键热切换账号。不用手写 YAML。
- 🔒 **安全默认**：控制台只绑定 `127.0.0.1`，密钥加密落盘、只读解密、掩码自愈保护；不收集任何账号或 Cookie。
- 🌐 **MCP + Tunnel 自动联动**：控制台或 `start-tunnels.mjs` 会读取你保存的 Runtime API Key，自动为每个服务拉起独立的 tunnel-client，把本地 MCP 进程安全地暴露给 ChatGPT 网页版。
- 📦 **开箱即用**：自带 Node.js v25.9.0 运行时与 Overleaf 的 npm 生产依赖，解压即跑，无需 `npm install`。
- 🧹 **优雅退出**：`Stop-Mcp` 一键停掉隧道与控制台，且绝不误杀你的 IDE、DSH、Codex 等宿主进程。

一句话：**把你电脑变成 ChatGPT 的私人工具箱，而不用变成运维工程师。**

---

## 📁 包里有什么

| 组件 | 说明 |
| --- | --- |
| **账号控制台 / Web 界面** | [console](<console/>)，本地 `http://127.0.0.1:17642`，管理 MCP 服务、隧道与账号切换 |
| **Node.js v25.9.0 (win-x64)** | [console/runtime](<console/runtime/>)，控制台与 Overleaf 共用，无需另装 Node |
| **tunnel-client 0.0.19 + cloudflared 2026.10.2** | [tunnel-client](<tunnel-client/>)，把本地 MCP 安全暴露给 ChatGPT 的隧道客户端 |
| **Overleaf MCP 0.3.9** | [servers/overleaf-mcp](<servers/overleaf-mcp/>)，含 npm 生产依赖与锁文件（需 Node ≥ 22.14.0） |
| **Antigravity MCP 1.1.0** | [servers/antigravity-mcp](<servers/antigravity-mcp/>)，Python 纯标准库实现（需 Python 3.9+ 与已登录的 Antigravity IDE） |
| **DSH ChatGPT 桥接 0.6.0** | [servers/deepseek-mcp](<servers/deepseek-mcp/>)，可选；**不捆绑** DSH 主程序与桥接依赖 |
| **账号 / API Key / Tunnel ID / 登录授权** | ❌ **不包含**，目标机必须用自己的配置 |

> “包含依赖”只代表本地运行文件齐全，不代表所有外部服务都能离线用；Python、IDE、DSH 主程序需要目标机自行准备。

---

## 🧭 快速上手（5 分钟）

1. 解压整个包到固定目录（如 `C:\MCP-Tools`）—— **不要在 ZIP 里直接运行**。
2. 双击 `Verify-Package.cmd` 校验文件。
3. 双击 `Start-Console.cmd` 打开控制台。
4. 用 bootstrap code 设置管理密码。
5. 在网页控制台里添加 MCP 服务 → 填 Tunnel ID / Runtime API Key → 启动隧道。

**第一次初始化密码**：`%LOCALAPPDATA%\McpTunnelAccountManager\bootstrap-code.txt` 里有本机新生成的初始化码。不要把它发给任何人。

**可选——创建桌面一键启动**：双击 一键启动/oneclick 目录里的 [Install-Desktop-Shortcut.cmd](<oneclick/Install-Desktop-Shortcut.cmd>)，桌面会出现「MCP Tunnel 一键启动」，双击即开控制台（它只负责控制台，不启动隧道）。详见 [oneclick/README.zh-CN.md](<oneclick/README.zh-CN.md>)。

> ⚠️ 控制台只监听 `127.0.0.1`，**不是**公网管理后台。端口被旧版占用时会拒绝启动而非杀进程；需要并存时用独立端口/数据目录：
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Console.ps1 -Port 17643 -DataDirectory "$env:LOCALAPPDATA\McpTunnelAccountManager-Preview"
> ```

---

## 🛠️ 如何在控制台里配置 MCP（重点）

打开 `http://127.0.0.1:17642`，登录后你会看到两个主标签页：

### 1) 【MCP服务】标签页 —— 注册与启停服务

这里管理**本地 MCP 服务的定义**（不是凭据）。你可以：

- **添加 MCP 服务**：点「+ 添加 MCP 服务」，选择绑定类型：
  - **Stdio（本地进程标准输入输出）**：填写可执行程序（如内置 `node.exe` 或你的 `python.exe`）、参数、工作目录（cwd）、环境变量。这是 Overleaf / Antigravity 的常用方式。
  - **HTTP / SSE（远程）**：填写服务 URL 与请求头（如 DSH 桥接的 `http://127.0.0.1:3456/mcp`）。
- **导入配置**：把安装向导生成的 `generated-profiles/console-services.json`（标准 `mcpServers` 格式）一键导入，自动填充命令、参数、cwd。
- **查看实际生效配置路径与运行状态**：每个服务卡片会显示注册表定义、探测到的真实进程、健康状态。
- **Codex 桥接开关**（页面下方）：默认开启。关闭后启动隧道会从 PATH 移除 npm 目录，不再拉起每份约 96 MB 的 `codex app-server` 与弹窗。**MCP 工具调用不受影响**，设置持久化在 `manager.db`，修改后需重启相关隧道。

> 保存配置只会更新**注册表定义**；要让改动真正生效，需到【账号配置】页执行一次切换（页面顶部会有提醒）。

### 2) 【账号配置】标签页 —— 填凭据与切换

这里为**当前账号**配置每个 MCP 服务的独立连接参数，并触发隧道热切换：

- 为每个服务填写自己的 **Tunnel ID** 与 **Runtime API Key**（加密保存到本地库）。
- **隧道切换控制**：选择目标服务 + 待激活的账号配置 → 「确认执行」触发**安全、幂等**的热切换：校验、掩码保护、真实 PID 观测，确认旧隧道平滑退出后再拉起新隧道。
- 运行中的隧道不可直接从控制台注销——必须先平滑停止、轮询确认进程安全退出后才能移除（`MCP_RUNNING` 保护）。

**控制台背后的接口**（自动化时可直接调用，均需登录，写操作需 CSRF 令牌）：
`/api/auth/*`、`/api/state`、`/api/mcps`、`/api/discovery`、`/api/profiles`、`/api/switch`、`/api/settings/codex-bridge`。

---

## 🔌 装机指南 A：安装 MCP 控制台本身

1. 把包解压到固定、当前用户可写目录（不要放 Program Files，不要在 ZIP 内运行）。
2. 双击 [Verify-Package.cmd](<Verify-Package.cmd>) 校验；另对照 Release 的 SHA256SUMS.txt 核对 ZIP。
3. 双击 [Start-Console.cmd](<Start-Console.cmd>) → 浏览器打开 `http://127.0.0.1:17642`。
4. 首次运行用 `bootstrap-code.txt` 里的初始化码设置管理密码。
5. 可选：双击 [Install-Console-Shortcut.cmd](<Install-Console-Shortcut.cmd>) 建桌面快捷方式（同名旧链接先备份；移动目录后要重建）。

**停止控制台**（参数需与启动时一致；只停本版本进程，不按端口批量杀进程）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\console\scripts\start-manager.ps1 -Stop
```

---

## 📄 装机指南 B：安装 Overleaf MCP

Overleaf MCP 让你在 ChatGPT 里**读写 Overleaf 项目、编译 LaTeX、查看日志、同步文件**。

**前提**：只需 Node（包内已自带 `console/runtime/node.exe`），无需另装。

1. 获取一个**独立的 Tunnel ID**（见下方「Tunnel ID 从哪来」）。
2. 运行安装向导，选择 `overleaf`，生成 `generated-profiles/overleaf-local.yaml` 与 `console-services.json`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-And-Setup.ps1 -Services overleaf -OverleafTunnelId "你自己的OverleafTunnelID"
```

3. （推荐）在控制台【MCP服务】页「导入配置」选择 `generated-profiles/console-services.json`，核对服务名/程序路径/参数/cwd。
4. 首次使用 Overleaf 时，需在目标机自己完成浏览器授权/会话登录——**不要把别人的 Cookie 或浏览器目录复制过来**。

---

## 🧠 装机指南 C：安装 Antigravity MCP

Antigravity MCP 让 ChatGPT 操作你的 **Antigravity IDE**，可进行代码编辑、运行任务等 IDE 动作，共 8 个工具。

**前提**：
- **Python 3.9+**（Python 标准库实现，无需第三方包；包内不含 Python 运行时）。
- **已登录、可正常使用的 Antigravity IDE**。

1. 获取独立的 Antigravity Tunnel ID。
2. 运行安装向导（可同时装 Overleaf 与 Antigravity，每个服务用不同 Tunnel ID）：

```powershell
.\Install-And-Setup.ps1 -Services overleaf,antigravity `
  -OverleafTunnelId "自己的OverleafID" -AntigravityTunnelId "自己的AntigravityID"
```

> 若 PowerShell 提示脚本被禁止执行，先只对本进程放开：`Set-ExecutionPolicy -Scope Process Bypass`。

向导只生成本机 [generated-profiles](<generated-profiles/>)，**不启动隧道、不安装插件、不写 API Key**；缺少依赖、空 ID、重复 ID 会直接拒绝；已存在配置默认不覆盖，需明确加 `-Force`。

3. Antigravity IDE 的登录与本地可用性由目标机自行完成，**不要复制他人的 IDE 账户目录**。

---

## 🌉 装机指南 D：安装 DSH MCP（可选 ChatGPT 桥接）

不用可跳过。这里带的是**桥接插件代码**，不是独立 HTTP 程序，**不能直接 `node lib/index.js` 当服务跑**。

- 本地副本版本 `0.6.0`，peer dependencies 指向 DSH `0.2.0-rc.2`。同为 `0.6.0` 的其他分发可能接口不同，别只按版本名替换。
- DSH 主程序和桥接依赖需在目标机联网安装，本包不自动装、不改变现有 DSH profile。

使用相容的 DSH 主程序时手动执行（先核对官方 CLI 版本和插件说明）：

```powershell
$bridgeFolder = (Resolve-Path .\servers\deepseek-mcp).Path
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ("file:" + $bridgeFolder)
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web
```

> **必须装在真正启动 Web 的 `web` profile**，装在别的 profile 里不会对当前 Web 自动生效。

确认桥接已在 `http://127.0.0.1:3456/mcp` 提供服务、并在目标机配好自己的桥接令牌后，再生成并运行桥接隧道：

```powershell
.\Install-And-Setup.ps1 -Services deepseek -DeepSeekTunnelId "自己的DSH隧道ID"
.\launchers\Start-DeepSeek-Bridge-Tunnel.ps1
```

> 桥接令牌与 OpenAI Runtime API Key **不是同一种凭据**，启动器会分别隐藏输入。

---

## 🚇 装机指南 E：安装 tunnel-client，并把它和 MCP 联系起来

**tunnel-client 是 MCP 的“外网门卫”**：它把本机运行的 MCP 进程（stdio 或本地 HTTP）通过 OpenAI 的控制面隧道暴露给 ChatGPT 网页版。没有它，ChatGPT 访问不到你本地的 MCP。

包内已自带 [tunnel-client/tunnel-client.exe](<tunnel-client/tunnel-client.exe>)（0.0.19）与 [tunnel-client/cloudflared.exe](<tunnel-client/cloudflared.exe>)，**无需另装**。版本与哈希见 [package-manifest.json](<package-manifest.json>)。

### 隧道配置怎么来

Tunnel 模板在 [templates](<templates/>)（`overleaf-tunnel.yaml.template`、`antigravity-tunnel.yaml.template`、`deepseek-bridge-tunnel.yaml.template`）。安装向导会把你的 Tunnel ID 填进模板，生成 `generated-profiles/<service>-local.yaml`。关键结构：

```yaml
control_plane:
  base_url: 'https://api.openai.com'
  tunnel_id: '<你的TunnelID>'
  api_key: 'env:CONTROL_PLANE_API_KEY'   # 从环境变量读取，绝不写进文件
mcp:
  commands:
    - channel: main
      command: 'env:DEPLOYMENT_MCP_COMMAND'  # 指向本地 MCP 启动命令
```

**MCP ↔ Tunnel 的关联点就在这里**：`mcp.commands`（stdio 服务）或 `mcp.server_urls`（DSH 的 `http://127.0.0.1:3456/mcp`）告诉隧道“要对外暴露哪个本地 MCP”；`control_plane` 告诉隧道“通过哪个 Tunnel ID / API Key 连到 ChatGPT”。隧道拉起后，ChatGPT 端就能看到并调用这些 MCP 工具。

### 两种启动方式（同一服务只选一种，避免抢占同一 Tunnel ID）

**方式一：独立启动器（最适合冒烟验证）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-Overleaf-Tunnel.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\launchers\Start-Antigravity-Tunnel.ps1
```

每个启动器单独运行，隐藏输入 Runtime API Key 并仅放入该子进程环境变量；不写 YAML、不改系统环境变量，关闭窗口/Ctrl+C 即停止。

**方式二：交给控制台统一管理（推荐日常使用）**

登录控制台 → 填好各服务 Tunnel ID / Runtime API Key → 在【账号配置】执行“隧道切换控制”。也可用命令行批量拉起三个独立隧道（separate 模式；只读解密 `manager.db` 里的 Runtime API Key，密钥不打印、不落盘）：

```powershell
node tools\start-tunnels.mjs            # 启动三个独立隧道
node tools\start-tunnels.mjs --dry-run  # 只看要做什么，不启动
```

> `start-tunnels.mjs` 启动时**会从子进程 PATH 移除 npm 目录**，使 tunnel-client 探测不到 Codex，从而不再拉起 `codex app-server` 桥接。这消除了启动弹窗，并把整条链路内存从约 **382 MB 降到约 191 MB**。代价是终端里的 `tunnel-client codex assistant` 不可用——**不影响 ChatGPT 调用任何 MCP 工具**。

### 一键关闭全部服务

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Stop-Mcp.ps1
```

| 参数 | 作用 |
| :--- | :--- |
| `-TunnelsOnly` | 只停隧道，保留控制台 |
| `-ConsoleOnly` | 只停控制台，保留隧道 |
| `-Port 17642` | 指定控制台端口 |
| `-DryRun` | 只列将要停止的进程 |

行为约定：只停本部署的 `tunnel-client.exe`（核对可执行路径与创建时间，不裸 PID kill）；绝不触碰 DSH / Antigravity IDE / Codex app-server 等宿主；幂等（没运行返回 `IDLE`、退出码 0）；不修改 `manager.db` / `master.key`。

---

## 🔑 Tunnel ID 从哪来？

在 **OpenAI 隧道管理侧（控制面）** 为你需要的服务各取一个**独立 Tunnel ID** 和一个 **Runtime API Key**。

- 每个服务、每台同时在线的电脑应使用**不同的 Tunnel ID**，不要复用作者机器的 ID。
- Runtime API Key **不是** ChatGPT API Key、Overleaf Cookie，也不是 DSH 桥接令牌——别混用。

---

## 🔒 数据、安全与升级

- 本地账号库、加密主密钥、管理密码、初始化码、日志默认在 `%LOCALAPPDATA%\McpTunnelAccountManager`。**安装目录可替换，用户数据不可公开上传**；备份时连同主密钥妥善保管。
- 控制台只绑 `127.0.0.1`，不要对公网暴露。
- 升级前退出旧控制台、备份数据目录，再解压新版本；**不要两份控制台同时访问同一数据库**，也不要旧包整体覆盖新包。
- 运行向导后产生的 `generated-profiles` 不属于原始发布文件；再次校验原包时用 `powershell -File .\Verify-Package.ps1 -AllowGeneratedProfiles`。

**验证范围**：本次在同一 Windows 主机隔离目录重解压，测试校验、运行环境、登录/CSRF/加密持久化、快捷方式安装到临时目录，以及 MCP initialize / tools-list。不发送模型任务、不使用真实账号或 API Key。这不是第二台实体机验收，也不是完整上游回归或真实 Overleaf/Antigravity/DSH 外网业务认证。

---

## ❓常见问题

- **页面打不开/端口被占**：新版会拒绝而非强杀；换 `-Port 17643` 或先手动关掉旧版。
- **控制台能开但 MCP 用不了**：仅开网页 ≠ MCP 可用。需要配好 stdio/HTTP 绑定、独立 Tunnel ID、Runtime API Key，以及服务自身的登录。
- **Codex 弹窗太多/内存高**：在【MCP服务】页关闭“Codex 桥接”，重启隧道。
- **移了文件夹后配置失效**：生成的路径指向解压目录，移动后重新运行安装向导生成。

---

## 🙌 一起把它变得更好

如果这个项目让你少踩了坑：

- ⭐ **Star 本仓库**——这是最直接的支持！
- 🐞 遇到问题提 Issue，带上复现步骤和 `console/logs` 片段。
- 🔧 欢迎 PR：新的 MCP 服务适配、文档改进、Windows 兼容性修复。

---

## 📚 更多文档

- 组件与来源：[package-manifest.json](<package-manifest.json>)
- 文件哈希：[FILES.sha256](<FILES.sha256>)
- 来源差异：[console/source-provenance.json](<console/source-provenance.json>)
- 授权说明：[THIRD-PARTY-NOTICES.md](<THIRD-PARTY-NOTICES.md>)
- 控制台详情：[console/README.md](<console/README.md>)
- 一键启动：[oneclick/README.zh-CN.md](<oneclick/README.zh-CN.md>)

> 原控制台未附项目自身许可证，本包不替作者擅自选定许可；公开发布前请确认项目授权。MIT/Apache 第三方许可证不自动覆盖本项目自身代码。
