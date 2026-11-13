# MCP Tunnel Account Manager

Windows 本地 MCP 隧道与账号管理控制台：用浏览器管理多个账号、多个 MCP 服务与各自的 tunnel-client 隧道，凭据加密保存在本机。

本 README 面向**第一次使用的新手**，按顺序做完即可：安装依赖 → 启动控制台 → 在网页里填自己的 Tunnel ID 与 Runtime API Key → 启动隧道。

> 本仓库 `final` 分支为综合合并版。旧的 `v1.2.0-preview.*` 二进制发行包与 `deployment/windows` 目录属于**历史发布物**，不是当前的安装方式，见文末「历史版本」。

---

## 1. 快速开始（本次 final 源码）

```text
1) 双击根目录 Install-Components.cmd        （安装三个外部组件，只需一次）
2) 双击根目录 Start-Console.cmd              （启动控制台并打开浏览器）
3) 在 http://127.0.0.1:17642 按页面提示初始化管理员密码
4) 在「账号配置」里为每个 MCP 服务填写自己的 Tunnel ID 与 Runtime API Key
```

命令行等价写法：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-components.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\open-portable-console.ps1
```

---

## 2. 前提条件

| 项目 | 要求 | 是否由安装脚本准备 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 x64 | 否 |
| PowerShell | 系统自带 Windows PowerShell 5.1 | 否 |
| 浏览器 | Edge / Chrome 等现代浏览器 | 否 |
| Node.js | **>= 22.14.0**（`mcp-server-overleaf@0.3.9` 的 engines 要求） | 否，需自行安装 |
| Python | **>= 3.9**，推荐 3.12（安装时勾选 Add to PATH） | 否，需自行安装 |
| 网络 | 首次安装需访问 GitHub 与 npm registry | — |
| Git for Windows | 仅当需要 Overleaf 的 Git 读写/同步时才需要 | 否，仓库不捆绑 |
| TeX / latexmk | 仅当需要本地编译 Overleaf 项目时才需要 | 否，仓库不捆绑 |
| Antigravity IDE | 使用 Antigravity MCP 时必须已安装、已登录并正在运行 | 否 |

控制台自身**没有第三方 npm 运行依赖**（`package.json` 无 `dependencies` 字段），不需要 `npm install` 就能启动。

---

## 3. 一键安装三个外部组件

### 3.1 入口

| 方式 | 命令 |
| --- | --- |
| 双击（推荐新手） | `Install-Components.cmd` |
| 全部安装 | `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-components.ps1` |
| 只装 tunnel-client | `.\scripts\install-tunnel-client.ps1` |
| 只装 overleaf-mcp | `.\scripts\install-overleaf-mcp.ps1` |
| 只装 antigravity-mcp | `.\scripts\install-antigravity-mcp.ps1` |
| 只检查不安装 | 加 `-VerifyOnly` |
| 强制重装 | 加 `-Force` |

也可以只装其中几项：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-components.ps1 -Component overleaf-mcp,antigravity-mcp
```

### 3.2 脚本行为

- 只写入**当前用户目录**，不需要管理员权限，不修改系统级环境变量。
- 固定版本 + 校验：tunnel-client 校验 SHA256，overleaf-mcp 校验 npm integrity，antigravity-mcp 校验源码归档 SHA256 并记录 commit。
- 可重复运行：已安装同版本会跳过下载；`-Force` 才会重新覆盖。
- **不会删除** `%USERPROFILE%\.openai-tunnel` 里已有的 `tunnel.env`、启动脚本或其他个人文件，只覆盖发行包内的程序与伴随资源。
- 失败时以**非零退出码**结束，并打印具体原因；已完成的组件下次会自动跳过。
- 下载缓存与安装状态都留在本机用户目录，便于离线重装与排查。

### 3.3 安装路径

| 内容 | 默认路径 |
| --- | --- |
| tunnel-client 程序 | `%USERPROFILE%\.openai-tunnel\tunnel-client.exe` |
| cloudflared 伴随程序 | `%USERPROFILE%\.openai-tunnel\cloudflared.exe` |
| Overleaf MCP 运行目录 | `%USERPROFILE%\.overleaf-mcp\runtime\node_modules\mcp-server-overleaf` |
| Antigravity MCP 虚拟环境 | `%USERPROFILE%\.antigravity-mcp\venv\Scripts\python.exe` |
| Antigravity MCP 源码（固定 commit） | `%USERPROFILE%\.antigravity-mcp\app` |
| Overleaf 隧道配置 | `%APPDATA%\tunnel-client\overleaf.yaml` |
| Antigravity 隧道配置 | `%APPDATA%\tunnel-client\antigravity-local.yaml` |
| 安装状态记录 | `%USERPROFILE%\.mcp-tunnel-kit\install-state.json` |
| 下载缓存 | `%USERPROFILE%\.mcp-tunnel-kit\cache` |
| 控制台数据目录 | `%LOCALAPPDATA%\McpTunnelAccountManager` |
| Antigravity MCP 状态目录 | 默认 `%LOCALAPPDATA%\antigravity-mcp`；安装器**不会**自动隔离，建议按下文 6.3 显式指定独立目录 |

这些路径与控制台代码里的默认值一致，所以安装完不需要再手工改路径。

### 3.4 依赖来源（固定版本）

| 组件 | 来源 | 版本 |
| --- | --- | --- |
| tunnel-client | `openai/tunnel-client` | **v0.0.19**（固定兼容版本，非最新版；上游最新为 v0.0.20） |
| overleaf-mcp | npm `mcp-server-overleaf`（上游 `yangzichao/mcp-server-overleaf`，MIT） | **0.3.9** |
| antigravity-mcp | `https://github.com/zwsxzy/antigravity-mcp-fork` | commit `02df3ed95aae0c5103f5db7b332d0c4e6f1eec50`，包版本 `1.1.0.post1` |

antigravity-mcp 的 `dependencies = []`（纯标准库），因此安装器**不做 pip 构建**：它把固定 commit 的源码放进 `.antigravity-mcp\app`，由独立 venv 通过 `.pth` 引用，避免在线构建依赖。

### 3.5 卸载

安装器不提供自动卸载。需要清理时，手动删除上表中对应的目录即可；**删除前请先备份** `%APPDATA%\tunnel-client\*.yaml` 与 `%LOCALAPPDATA%\McpTunnelAccountManager`（账号库、密钥、日志都在后者）。

---

## 4. 启动控制台

```powershell
# 后台启动并自动打开浏览器
.\Start-Console.cmd

# 前台调试模式（Ctrl+C 结束）
.\start-manager.cmd
```

- 地址：<http://127.0.0.1:17642>，只监听本机回环地址。
- 可用环境变量 `PORT` 改端口；`HOST` 只允许 `127.0.0.1`，填其他值会拒绝启动。
- 数据目录默认 `%LOCALAPPDATA%\McpTunnelAccountManager`，可用 `DATA_DIR` 覆盖。
- **首次初始化**：页面会要求「引导秘钥 (Bootstrap Code)」+ 管理员密码。引导秘钥在数据目录下的 `bootstrap-code.txt` 里。这个文件只在本机，**不要公开、不要提交、不要截图分享**。
- 初始化完成后用管理员密码登录。

---

## 5. 新手配置（按 Web 界面操作）

### 5.1 先理解两个页面

| 页面 | 作用 |
| --- | --- |
| **账号配置** | 一个「配置」= 一套账号凭据。为每个 MCP 服务分别填 Tunnel ID / API Key / Organization ID。 |
| **MCP 服务** | 本机 MCP 服务的注册表：程序路径、参数、工作目录、环境变量、运行状态。 |

控制台**已内置并启用** `overleaf-mcp` 与 `antigravity-mcp` 两个服务定义。新手**不需要**在「MCP 服务」页重新添加这两个服务，只要在「账号配置」里填凭据即可。

### 5.2 账号配置页

1. 打开「账号配置」标签页，点右上角 **「添加新配置」**。
2. 填 **「配置标签 / 名称」**，例如 `我的主力账号`。
3. 下方会为每个已注册的 MCP 服务显示一块凭据表单，逐项填写：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| **Tunnel ID** | 是 | 在 OpenAI 控制台为这个隧道创建的 ID，形如 `tun_xxxxxxxxxxxxxxxx`。每台电脑、每个服务建议用**不同**的 Tunnel ID。 |
| **API Key** | 是 | 该隧道的 Runtime API Key。编辑已有配置时留空表示保留原值。 |
| **Organization ID** | 否 | 只有你的账号属于某个组织时才需要填。 |

4. 点 **「保存配置」**。

> 凭据只保存在本机加密库里。界面显示的是脱敏值（如 `tun_***4a5`），**不要把脱敏值复制回输入框**，否则会被当成真实值。

### 5.3 执行切换 / 启动隧道

1. 在「账号配置」页选择 **1. 选择目标生效服务**（可多选）。
2. 选择 **2. 选择待激活配置文件**（可多选，用于并行启动）。
3. 点 **3. 执行原子切换**；需要同时跑多个账号时用 **「并行启动」**。
4. 需要全部停止时点 **「停止全部 Tunnel Client」**。

切换是原子操作：失败会回滚到切换前的配置，并在界面上显示错误码。

### 5.4 MCP 服务页（只有新增自定义服务时才需要）

点 **「添加 MCP 服务」**，字段如下：

| 字段 | 说明 |
| --- | --- |
| **服务名称 / 标签** | 显示名称 |
| **服务类型** | stdio（本地进程）或 HTTP/SSE（远程地址） |
| **本机可执行文件路径或系统命令** | 例如 `C:\Program Files\nodejs\node.exe`、`python`、`npx.cmd` |
| **运行工作目录 (cwd)** | 选填 |
| **启动命令行参数 (Arguments)** | 逐个添加 |
| **HTTP URL 地址** | 仅 HTTP/SSE 类型 |
| **HTTP 请求头 (Headers)** | 仅 HTTP/SSE 类型 |
| **环境变量列表** | 传给该 MCP 子进程的环境变量 |

> **重要限制**：环境变量列表里**不允许** `CONTROL_PLANE_*` 与 `TUNNEL_CLIENT_*` 前缀（后端会拒绝）。Tunnel 凭据请走「账号配置」，程序路径请走服务定义或启动器设置，不要写进服务 env。

「发现本机配置」可以扫描本机已有的 MCP 配置并导入预览。

---

## 6. 三个组件分别怎么配

### 6.1 tunnel-client

- 作用：把本地 stdio MCP 服务桥接到 OpenAI 隧道，是三个服务共用的隧道程序。
- 安装位置：`%USERPROFILE%\.openai-tunnel\tunnel-client.exe`（同目录还有 `cloudflared.exe`、manifest 与许可证）。
- 需要你准备：**Tunnel ID** 与 **Runtime API Key**（在 OpenAI 控制台创建隧道时获得），填在「账号配置」页。
- 隧道配置文件由安装器生成在 `%APPDATA%\tunnel-client\`，其中 `tunnel_id` 故意留空，切换时由控制台写入真实值。
- 如果配置文件里的 MCP 命令指向了不存在的程序，安装器会把它改成当前安装路径；如果命令指向的程序仍然存在但与本次安装不同，安装器**不会**擅自改动，而是生成 `*.yaml.suggested` 供你对照。

### 6.2 overleaf-mcp

- 作用：Overleaf 论文编辑与追踪的 MCP 服务，stdio 传输，由 tunnel-client 桥接。
- 安装位置：`%USERPROFILE%\.overleaf-mcp\runtime\node_modules\mcp-server-overleaf`，入口 `dist/index.js`。
- 需要你准备：该服务的 **Tunnel ID** 与 **Runtime API Key**（填在「账号配置」页）。
- 项目配置：上游 `mcp-server-overleaf` 提供交互式向导

  ```powershell
  npx --yes mcp-server-overleaf@0.3.9 setup --clients none
  ```

  `--clients none` 表示**不为其他 MCP 客户端写配置**，只准备 Overleaf 自己的项目配置。在 Windows 上它会读取 `XDG_CONFIG_HOME` / `APPDATA`，把项目清单写到 `overleaf-mcp\projects.json`。
- 服务运行时可用 `OVERLEAF_PROJECTS_CONFIG` 指定具体的 `projects.json`；但**不要假设 setup 向导会遵从该环境变量**，向导写的是它自己的默认位置。
- 默认业务工作区：`%USERPROFILE%\.overleaf-mcp\projects`，可用 `OVERLEAF_MCP_WORKSPACE_DIR` 指定。
- **两种凭据不要混淆**：
  - **Runtime API Key**：OpenAI 隧道的凭据，填在控制台「账号配置」。
  - **个人 Git token**：Overleaf 项目 Git 读写/同步用的凭据，由 Overleaf 侧配置，与隧道无关。
- 只有需要本地编译时才要装 TeX/latexmk；只有需要 Git 同步时才要装 Git for Windows。

### 6.3 antigravity-mcp

- 作用：把 Antigravity IDE 的本地 agent 引擎暴露为 MCP 工具，stdio 传输，由 tunnel-client 桥接。
- 来源固定：`https://github.com/zwsxzy/antigravity-mcp-fork`，commit `02df3ed95aae0c5103f5db7b332d0c4e6f1eec50`，版本 `1.1.0.post1`。
- 安装位置：venv 在 `%USERPROFILE%\.antigravity-mcp\venv`，源码在 `%USERPROFILE%\.antigravity-mcp\app`。
- 启动命令（安装器写入 YAML）：

  ```text
  "<venv>\Scripts\python.exe" -X utf8 -u -m antigravity_mcp
  ```

  `-X utf8 -u` 保证中文输入输出不被 Windows 默认编码破坏。
- 状态目录：默认 `%LOCALAPPDATA%\antigravity-mcp`（任务历史需要跨进程保留）。
  - 安装器**不会**自动把状态目录改到 `.antigravity-mcp` 下；安装状态文件里记录的 `stateDir` 就是上游默认值 `%LOCALAPPDATA%\antigravity-mcp`。
  - 如果你同时装了上游 `antigravity-mcp`，或者希望每个账号/环境互不干扰，建议显式指定独立目录：
    1. 打开「MCP 服务」页，编辑 `antigravity-mcp` 服务；
    2. 在 **环境变量列表** 里新增一条，名称为 `ANTIGRAVITY_STATE_DIR`，值为**绝对路径**，例如 `C:\Users\你的用户名\.antigravity-mcp\state`（环境变量值不会展开 `%USERPROFILE%`，必须写完整路径）；
    3. 保存后再执行一次切换，让新环境变量生效。
  - 不要把它写进 `CONTROL_PLANE_*` / `TUNNEL_CLIENT_*` 前缀（会被拒绝）。
- **必须**：本机已安装、已登录并**正在运行** Antigravity IDE。fork 的原生多父 / 多 agent 协作依赖 IDE 的本地语言服务器。
- 如果 IDE 没运行，只能走 Gemini REST API 的 fallback，**该 fallback 不支持原生多 agent 协作**。
- 只有 stdio，没有 HTTP/SSE。
- 包内的 `workflow_settings.json` 键值有严格约定，**不要随意修改**（尤其 `default_model`）。
- 不要用 `--version` 探测这个包（它会等待 stdin）。

---

## 7. 安装路径与状态目录总表

| 类别 | 路径 |
| --- | --- |
| 控制台源码 | 本仓库目录 |
| 控制台数据（账号库/密钥/日志） | `%LOCALAPPDATA%\McpTunnelAccountManager` |
| 首次初始化引导秘钥 | `%LOCALAPPDATA%\McpTunnelAccountManager\bootstrap-code.txt` |
| tunnel-client 程序 | `%USERPROFILE%\.openai-tunnel\tunnel-client.exe` |
| Overleaf MCP 运行目录 | `%USERPROFILE%\.overleaf-mcp\runtime` |
| Overleaf 项目工作区 | `%USERPROFILE%\.overleaf-mcp\projects` |
| Antigravity MCP venv | `%USERPROFILE%\.antigravity-mcp\venv` |
| Antigravity MCP 源码 | `%USERPROFILE%\.antigravity-mcp\app` |
| Antigravity MCP 状态 | `%LOCALAPPDATA%\antigravity-mcp` |
| 隧道配置 | `%APPDATA%\tunnel-client\overleaf.yaml`、`%APPDATA%\tunnel-client\antigravity-local.yaml` |
| 安装状态 / 缓存 | `%USERPROFILE%\.mcp-tunnel-kit\` |

---

### 7.1 环境变量一览

这些是控制台与其子进程实际读取的环境变量。设置方式：临时会话用 `$env:NAME = "..."`；长期使用在「系统属性 → 环境变量 → 用户变量」里添加，然后重开终端。

| 变量 | 作用域 | 说明 |
| --- | --- | --- |
| `PORT` | 控制台 | 监听端口，默认 `17642` |
| `HOST` | 控制台 | 只允许 `127.0.0.1`，其他值拒绝启动 |
| `DATA_DIR` | 控制台 | 数据目录覆盖，默认 `%LOCALAPPDATA%\McpTunnelAccountManager` |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | 隧道子进程 | 代理地址；都未设置时默认 `http://127.0.0.1:7897` |
| `OVERLEAF_PROJECTS_CONFIG` | overleaf-mcp 运行 | 指定具体的 `projects.json` 路径（setup 向导不一定遵从） |
| `OVERLEAF_MCP_WORKSPACE_DIR` | overleaf-mcp 运行 | Overleaf 项目工作区，默认 `%USERPROFILE%\.overleaf-mcp\projects` |
| `ANTIGRAVITY_STATE_DIR` | antigravity-mcp 运行 | 任务状态目录，默认 `%LOCALAPPDATA%\antigravity-mcp`；需在 MCP 服务 env 里写绝对路径 |

> 上述变量都是**可选**的；不设置时使用代码里的默认值。`CONTROL_PLANE_*` 与 `TUNNEL_CLIENT_*` 不允许出现在 MCP 服务的环境变量列表里。

---

## 8. 常见问题

| 现象 | 处理 |
| --- | --- |
| 安装报 Node.js 版本过低 | 需要 **>= 22.14.0**，升级后重跑安装脚本。 |
| 安装报未找到 Python | 安装 Python >= 3.9（推荐 3.12），安装时勾选 Add to PATH，重开终端后重跑。 |
| 端口 17642 被占用 | 设置环境变量 `PORT` 换端口，或先停掉占用该端口的旧实例。不要按端口批量杀进程。 |
| 隧道启动失败、提示配置命令不可用 | 重跑对应组件的安装脚本；它会修复指向不存在程序的命令，或生成 `*.yaml.suggested` 供对照。 |
| 中文用户名 / 路径含空格 | 安装器已按 Windows 引号规则处理，并把 `.pth` 写成纯 ASCII 相对路径；如仍失败，请把完整报错贴出来。 |
| 需要代理 | 隧道程序使用 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`，未设置时默认 `http://127.0.0.1:7897`。 |
| 安装脚本退出码非零 | 表示至少一个组件失败；看输出里的 `[FAIL]` 行，修好后重跑，已完成的组件会自动跳过。 |
| 忘记管理员密码 | 备份后删除 `%LOCALAPPDATA%\McpTunnelAccountManager` 重新初始化（会丢失账号库）。 |

---

## 9. 历史版本

以下内容属于**历史发布物**，仅用于查阅旧版本行为，**不是**当前安装方式：

- `v1.2.0-preview.2` ~ `v1.2.0-preview.5` 的 ZIP 发行包（完整部署包 / 控制台便携包 / 源码包）与 `SHA256SUMS.txt`。
- `deployment/windows/` 目录：早期迁移工具包源码与说明。
- `packaging/windows/templates/` 下的发行外壳模板。

这些旧包自带 `node_modules`、`tunnel-client.exe` 和旧版 antigravity 源码，**不要**把它们覆盖到当前源码目录，也不要按旧文档的 Node 18 要求准备环境。当前源码的安装方式以本文第 3 节为准。

历史文档入口：

- [v1.2.0-preview.5 发布说明](docs/releases/v1.2.0-preview.5/RELEASE_NOTES.zh-CN.md)
- [v1.2.0-preview.5 中文部署说明](docs/releases/v1.2.0-preview.5/README-Release.zh-CN.md)
- [安全切换修复记录](docs/SAFE-SWITCH-FIX.zh-CN.md)
- [合并版部署与验证边界](docs/NEW-BRANCH-DEPLOY.zh-CN.md)

---

## 10. 源码运行与测试

源码运行需要 Node.js **22.14.0+**，控制台没有第三方 npm 运行依赖：

```powershell
npm.cmd start          # 前台启动（等价 node scripts/launch-manager.mjs）
npm.cmd run test:unit  # 默认单元测试（不含 tests/integration）
npm.cmd run test:all   # 含集成测试
npm.cmd run check      # 静态检查
```

测试使用临时目录、合成凭据和随机本地端口，不需要真实隧道或账号。

构建与验证文档：

- [离线构建说明](docs/BUILD-RELEASE.md)
- [v1.2.0-preview.5 隔离验证报告](docs/releases/v1.2.0-preview.5/VALIDATION.zh-CN.md)

---

## 11. 安全边界

- 控制台只监听 `127.0.0.1`，不对外网暴露。
- 仓库与发布内容**不包含**任何真实账号、密钥、Cookie、隧道 ID、初始化码或浏览器/IDE profile。
- 每台电脑独立初始化；每台同时在线的电脑、每个服务应使用**独立 Tunnel ID**。
- 不要把使用后生成的 `%LOCALAPPDATA%\McpTunnelAccountManager`、`%APPDATA%\tunnel-client\*.yaml`、日志或 `master.key` 提交到 Git。
- 停止隧道时按执行文件、入口与创建时间核对身份，不按端口或进程名批量终止。

---

## 12. 许可

项目自身许可证尚未指定，本次不代作者选择 MIT/Apache 或授予额外权利。第三方许可证、NOTICE、SPDX 及来源信息保留在相应发行包与安装目录中；公开分发仍应由维护者确认授权。
