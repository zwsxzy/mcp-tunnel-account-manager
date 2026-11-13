<div align="center">

# MCP Tunnel Account Manager · macOS

### 多个账号、多种 MCP，一个 Mac 本地控制台。

把 Overleaf 写作、Antigravity Agent 和日常 MCP 隧道放进同一个管理页面。
**安装组件、保存账号、切换服务、并行运行，让重复配置少一点。**

[![GitHub Stars](https://img.shields.io/github/stars/zwsxzy/mcp-tunnel-account-manager?style=flat-square)](https://github.com/zwsxzy/mcp-tunnel-account-manager/stargazers)
![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%26%20Intel-111111?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22.14%2B-339933?style=flat-square)
[![macOS validation](https://github.com/zwsxzy/mcp-tunnel-account-manager/actions/workflows/mac.yml/badge.svg?branch=mac)](https://github.com/zwsxzy/mcp-tunnel-account-manager/actions/workflows/mac.yml?query=branch%3Amac)

**[下载 Mac 版](https://github.com/zwsxzy/mcp-tunnel-account-manager/archive/refs/heads/mac.zip) · [快速开始](#quick-start) · [第一次配置](#configuration) · [Windows 版](https://github.com/zwsxzy/mcp-tunnel-account-manager/tree/final) · [反馈问题](https://github.com/zwsxzy/mcp-tunnel-account-manager/issues)**

</div>

> 如果它帮你省去了反复配置和切换的麻烦，欢迎点亮右上角 **⭐ Star**，让更多有同样需求的人发现这个项目。

## 你可以用它做什么

| 你的需求 | 控制台里的操作 |
| --- | --- |
| 为不同用途保存不同账号 | 给配置命名，按 MCP 服务保存 Tunnel ID 与 Runtime API Key |
| 在账号之间切换 | 选择服务和账号，执行切换，查看健康检查与回滚结果 |
| 同时运行多个账号或多个 MCP | 多选并行启动，每个实例使用独立配置和健康端口 |
| 接入 Overleaf 与 Antigravity | 运行 Mac 安装入口，填写自己的账号与业务配置 |
| 管理自定义 MCP | 添加 stdio / HTTP 服务，配置程序、参数、目录与环境变量 |
| 看清当前运行情况 | 查看服务状态、实例状态、错误信息与程序位置 |

控制台默认只监听 `127.0.0.1`。账号库与加密密钥保存在当前用户目录；项目源码不包含你的账号、引导码或真实隧道配置。

### 选对分支

| 平台 | 分支 | 安装入口 | 启动入口 |
| --- | --- | --- | --- |
| **macOS：Apple Silicon / Intel** | **[`mac`](https://github.com/zwsxzy/mcp-tunnel-account-manager/tree/mac)** | `Install-Components.command` | `Start-Console.command` |
| Windows | [`final`](https://github.com/zwsxzy/mcp-tunnel-account-manager/tree/final) | `Install-Components.cmd` | `Start-Console.cmd` |

本文对应 **`mac` 分支**。Mac 版包含原生进程控制、用户目录适配、组件安装脚本和两种架构的 CI；验证范围见[验证记录](#validation)。仓库保留的旧 Windows 发布文档不作为 Mac 安装步骤。

## 导航

[快速开始](#quick-start) · [第一次配置](#configuration) · [组件说明](#components) · [安装路径](#paths) · [自定义 MCP](#custom-mcp) · [进阶设置](#advanced) · [常见问题](#faq) · [验证记录](#validation)

<a id="quick-start"></a>

## 快速开始

### 1. 准备一次基础环境

| 工具 | 要求 / 用途 |
| --- | --- |
| macOS | Apple Silicon `arm64` 或 Intel `x64`；CI 使用 macOS 15 的两种原生架构 |
| Node.js + npm | **Node.js ≥ 22.14.0**，npm 通常随 Node.js 安装 |
| Homebrew | 安装官方 `tunnel-client` Mac 分发包 |
| Python | **≥ 3.9，包含 venv**，供 Antigravity MCP 使用 |
| Git | Homebrew 安装及 Overleaf 项目 Git 同步 |
| 网络 | 首次安装可访问 Homebrew、GitHub 和 npm registry |

已经具备这些工具，可以直接进入下一步。首次使用 Mac 开发工具时，先按 [Homebrew 官网](https://brew.sh/) 的说明安装 Homebrew，完成终端显示的环境设置，然后运行：

```bash
brew install node python git
node --version
python3 --version
brew --version
```

安装器会检查基础环境并说明缺少什么。它负责安装 **tunnel-client、Overleaf MCP、Antigravity MCP**；不会代装 Homebrew、修改系统安全设置或安装 IDE。

控制台本身没有第三方 npm 运行依赖，**启动前无需 `npm install`**。

### 2. 下载 Mac 版，安装三个组件

**[点击下载 mac 分支 ZIP](https://github.com/zwsxzy/mcp-tunnel-account-manager/archive/refs/heads/mac.zip)**，解压后进入包含 `Install-Components.command` 的项目目录。

也可以通过 Git 获取：

```bash
git clone --branch mac --single-branch https://github.com/zwsxzy/mcp-tunnel-account-manager.git
cd mcp-tunnel-account-manager
```

双击 **`Install-Components.command`**。它会安装三个组件、生成两个服务的配置模板，并记录实际安装位置。

如果 Finder 没有把 `.command` 当作可执行文件，在项目目录的终端运行等价命令：

```bash
/bin/bash scripts/install-components-macos.sh --component all --yes
```

安装器支持中文、空格与单引号路径。已有配置会保留；需要合并命令时会生成 `.suggested` 文件或明确提示冲突。安装失败后修复提示的问题，再次运行即可，无需先清空目录。

### 3. 启动本地控制台

双击 **`Start-Console.command`**，浏览器会打开：

**<http://127.0.0.1:17642>**

也可以在项目目录运行：

```bash
/bin/bash Start-Console.command
# 或仅启动服务，然后手动打开浏览器：
npm start
```

保持启动它的终端窗口打开。按 **Control+C** 关闭控制台；需要停止隧道时，先在页面执行 **「关闭本控制台管理的隧道」**。

首次进入时输入引导码并设置管理员密码。引导码文件在：

```text
~/Library/Application Support/McpTunnelAccountManager/bootstrap-code.txt
```

在 Finder 中选择「前往 → 前往文件夹」，粘贴上方目录即可查找。也可以运行：

```bash
open "$HOME/Library/Application Support/McpTunnelAccountManager"
```

初始化完成后使用管理员密码登录。引导码只用于本机初始化，请勿把它贴到 Issue 或提交到 GitHub。

<a id="configuration"></a>

## 第一次配置：在网页里完成

### 分清账号与服务

| 页面 | 填写什么 |
| --- | --- |
| **账号配置** | 配置名称，以及各服务的 Tunnel ID、Runtime API Key、可选 Organization ID |
| **MCP 服务** | 本机程序路径、启动参数、工作目录、环境变量与服务类型 |

`overleaf-mcp` 与 `antigravity-mcp` 已内置。按默认路径安装后，无需再创建同名服务。

### 添加账号配置

1. 打开 **「账号配置」**，点击 **「添加新配置」**。
2. 填写易于识别的名称，例如 `论文工作区`、`日常开发`。
3. 为需要使用的服务填写下表字段，再点击 **「保存配置」**。

| 字段 | 从哪里获得 |
| --- | --- |
| **Tunnel ID** | 在 [OpenAI Tunnels 页面](https://platform.openai.com/settings/organization/tunnels) 创建或查看 |
| **API Key** | 对应账号的 **Runtime API Key**，参阅 [tunnel-client 权限说明](https://github.com/openai/tunnel-client/blob/v0.0.19/docs/permissions.md) |
| **Organization ID** | 可选，按账号的组织设置填写 |

需要相应的 Tunnels 访问权限。安装器生成的是模板，不会替你申请账号、创建远程隧道或填写真实凭据。

**同时在线的不同电脑、不同服务和并行实例，请各用一个独立 Tunnel ID。** 编辑已有配置时，API Key 留空会保留原值；请勿把页面显示的脱敏字符串填回输入框。

### 启动与切换

1. 在 **「1. 选择目标生效服务」** 中勾选服务。
2. 在 **「2. 选择待激活配置文件」** 中选择账号。
3. 点击 **「立即切换」**；需要多套配置同时在线时，选择 **「并行启动」**。
4. 查看状态与错误信息。停止时使用单个实例操作，或 **「关闭本控制台管理的隧道」**。

Mac 默认在没有代理环境变量时直接联网。有代理需求时，按[进阶设置](#advanced)填写自己的地址。

Overleaf 的项目访问和 Antigravity 的 IDE 会话还需要完成各自的业务配置，见下节。

<a id="components"></a>

## 三个组件，各自负责什么

| 组件 | 用途 | Mac 安装来源 |
| --- | --- | --- |
| [tunnel-client](https://github.com/openai/tunnel-client) | 连接本机 MCP 与 OpenAI 隧道 | 官方 Homebrew：`openai/tools/tunnel-client`，记录实际版本 |
| [Overleaf MCP](https://github.com/yangzichao/mcp-server-overleaf) | 项目读取、Git 同步与 LaTeX 工具 | 固定 `mcp-server-overleaf@0.3.9`，校验 npm integrity |
| [Antigravity MCP fork](https://github.com/zwsxzy/antigravity-mcp-fork) | 将 IDE 的本地 Agent 能力提供为 MCP | 固定 `1.1.0.post1` / 提交 [`02df3ed`](https://github.com/zwsxzy/antigravity-mcp-fork/commit/02df3ed95aae0c5103f5db7b332d0c4e6f1eec50)，校验源码 SHA256 |

### tunnel-client：使用官方 Homebrew 分发

安装器保留 Homebrew 的完整 `libexec` 布局，包括 `tunnel-client`、`cloudflared` 与 manifest；`~/.openai-tunnel/tunnel-client` 指向这套安装中的程序。

这让伴随资源保持正确关联，也避免自行搬动单个二进制导致资源缺失。遵循 [tunnel-client 的 macOS 安装说明](https://github.com/openai/tunnel-client#install-with-homebrew)；本项目不要求关闭 Gatekeeper 或清除下载隔离标记。

配置放在 `~/.config/tunnel-client/`，启动时使用明确的配置文件路径。设置 `XDG_CONFIG_HOME` 后，使用该目录下的 `tunnel-client/`。

### Overleaf：先告诉 MCP 使用哪个项目

运行安装好的配置向导：

```bash
node "$HOME/.overleaf-mcp/runtime/node_modules/mcp-server-overleaf/dist/index.js" setup --clients none
```

`--clients none` 只准备项目配置，不向其他 MCP 客户端写入配置。默认项目清单位于：

```text
~/.config/overleaf-mcp/projects.json
```

如果设置了 `XDG_CONFIG_HOME`，则使用 `$XDG_CONFIG_HOME/overleaf-mcp/projects.json`。

- **Runtime API Key** 用于隧道，填在本控制台的「账号配置」中。
- **Overleaf Git token** 用于项目 Git 访问，按项目向导配置。
- Git 读写 / 同步需要 Git；本地编译还需要 TeX 与 `latexmk`。

可以在服务环境变量中设置 `OVERLEAF_PROJECTS_CONFIG` 指定项目清单、`OVERLEAF_MCP_WORKSPACE_DIR` 指定工作区。前者改变服务读取位置，**不改变 setup 向导的默认写入位置**。

### Antigravity：连接已登录、运行中的 IDE

先安装、登录并打开 **Antigravity IDE**。原生 Agent 工作流依赖 IDE 的本地语言服务器及可用会话；Gemini REST fallback 不提供原生多 Agent 协作。

安装器创建独立 Python venv，引用你指定的 fork。MCP 启动形式如下：

```bash
"$HOME/.antigravity-mcp/venv/bin/python" -X utf8 -u -m antigravity_mcp
```

该进程使用 **stdio** 传输，由 tunnel-client 启动。直接运行后等待标准输入是正常现象，不要把它当作输出版本信息的命令。

默认任务状态目录是：

```text
~/Library/Application Support/antigravity-mcp
```

如需自定义，在 **「MCP 服务 → antigravity-mcp → 环境变量列表」** 中添加 `ANTIGRAVITY_STATE_DIR`，填写完整绝对路径。环境变量字段不会自动展开 `~` 或 `$HOME`。

包内的 `workflow_settings.json` 会在重新安装时保留；新版默认配置放入 `.suggested` 供对照。MCP 安装与握手成功，只代表服务入口可用，原生多 Agent 任务仍需在你自己的 IDE 会话中使用。

<a id="paths"></a>

## 安装路径与数据位置

这里的 `~` 指当前用户目录，通常为 `/Users/你的用户名`。Apple Silicon 与 Intel 使用相同的用户目录布局。

| 内容 | 默认位置 |
| --- | --- |
| 控制台源码 | 解压或克隆后的项目目录 |
| tunnel-client 稳定入口 | `~/.openai-tunnel/tunnel-client` |
| tunnel-client 与伴随资源 | `$(brew --prefix openai/tools/tunnel-client)/libexec/` |
| Overleaf MCP 入口 | `~/.overleaf-mcp/runtime/node_modules/mcp-server-overleaf/dist/index.js` |
| Overleaf 项目清单 | `~/.config/overleaf-mcp/projects.json` |
| Overleaf 默认项目工作区 | `~/.overleaf-mcp/projects/` |
| Antigravity Python | `~/.antigravity-mcp/venv/bin/python` |
| Antigravity MCP 源码包 | `~/.antigravity-mcp/app/antigravity_mcp/` |
| Antigravity 任务状态 | `~/Library/Application Support/antigravity-mcp/` |
| Overleaf 隧道 YAML | `~/.config/tunnel-client/overleaf.yaml` |
| Antigravity 隧道 YAML | `~/.config/tunnel-client/antigravity-local.yaml` |
| 安装状态、缓存与文件备份 | `~/.mcp-tunnel-kit/`，含 `install-state-macos.json` |
| 控制台账号库、密钥与运行状态 | `~/Library/Application Support/McpTunnelAccountManager/` |
| 首次初始化引导码 | 上述控制台目录中的 `bootstrap-code.txt` |

设置了 `XDG_CONFIG_HOME` 时，两种配置目录跟随该变量。控制台数据目录可用 `DATA_DIR` 改写。用户数据目录使用 POSIX 私有权限，账号凭据使用 AES-256-GCM 加密；请连同密钥一起备份数据目录。

<a id="custom-mcp"></a>

## 在控制台添加自己的 MCP

打开 **「MCP 服务」**，点击 **「添加 MCP 服务」**。

| 字段 | Mac 上怎样填写 |
| --- | --- |
| 服务名称 / 标签 | 便于自己识别的名称 |
| 服务类型 | 本地程序选 stdio；远程服务按实际协议选择 HTTP/SSE |
| 可执行文件 | 程序的完整路径，例如终端 `command -v node` 返回的路径 |
| Arguments | 每个启动参数单独一项，不把整条命令塞进程序路径 |
| cwd | 可选，填写工作目录的绝对路径 |
| HTTP URL / Headers | 仅按远程服务的实际要求填写 |
| 环境变量列表 | 该 MCP 需要的变量；路径使用绝对路径 |

例如，本地 Node MCP 的终端命令是 `node /Users/me/my-mcp/server.mjs --stdio`，可执行文件填写 Node 的实际路径，参数分别为 `/Users/me/my-mcp/server.mjs` 与 `--stdio`。

路径和参数中的空格、单引号会按 Mac 命令格式处理。上游 tunnel-client 当前会丢弃空字符串参数，本分支会明确拒绝此类参数；需要表达空值时，请按 MCP 支持的方式使用 `--name=` 等形式。

已有配置也可从 **「发现本机配置」** 预览并导入。`CONTROL_PLANE_*` 和 `TUNNEL_CLIENT_*` 是保留前缀，隧道凭据应在「账号配置」中填写。

<a id="advanced"></a>

## 进阶设置

<details>
<summary><strong>单独安装、只检查、重新安装</strong></summary>

在项目目录的终端执行：

```bash
# 单独安装组件
/bin/bash scripts/install-tunnel-client-macos.sh
/bin/bash scripts/install-overleaf-macos.sh
/bin/bash scripts/install-antigravity-macos.sh

# 只检查：不下载、不安装、不写入配置或安装状态
/bin/bash scripts/install-components-macos.sh --verify-only

# 明确要求重新安装组件发行文件
/bin/bash scripts/install-components-macos.sh --force
```

安装器会保留已有用户文件与业务配置；不会删除整个组件目录。若现有 YAML 的命令已失效，按提示备份并合并 `.suggested` 中的命令部分，保留自己的凭据后再检查。

`--home-dir` 可指定组件用户根目录；这时默认配置放到该目录的 `.config/tunnel-client/`，不继承外部的 `XDG_CONFIG_HOME`。`--config-dir` 可进一步指定完整的 tunnel-client 配置目录。这两个选项适合隔离验证；日常使用自定义位置时，也需要同步控制台服务配置，不能只移动程序。

安装器没有自动卸载功能。删除目录前请备份控制台数据、YAML、项目和任务记录。

</details>

<details>
<summary><strong>端口、代理与环境变量</strong></summary>

```bash
# 换一个本地控制台端口
PORT=17643 npm start

# 使用自己的 HTTP 代理；端口以自己的代理软件为准
HTTPS_PROXY=http://127.0.0.1:7897 npm start

# 使用指定的数据目录
DATA_DIR="$HOME/Library/Application Support/McpTunnelManager-Test" npm start
```

| 变量 | 行为 |
| --- | --- |
| `PORT` | 控制台端口，默认 `17642` |
| `HOST` | 只接受 `127.0.0.1` |
| `DATA_DIR` | 控制台数据目录 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | 按此顺序选择隧道代理；Mac 全部未设置时直接联网 |
| `XDG_CONFIG_HOME` | tunnel-client 与 Overleaf 的配置根目录 |
| `OVERLEAF_PROJECTS_CONFIG` | Overleaf 项目清单 |
| `OVERLEAF_MCP_WORKSPACE_DIR` | Overleaf 项目工作区 |
| `ANTIGRAVITY_STATE_DIR` | Antigravity 任务状态目录 |

Finder 启动的进程不一定继承终端中临时 `export` 的变量。有自定义代理或数据目录时，从设置好变量的终端执行 `npm start`。服务本身的变量请保存在网页的「环境变量列表」中。

</details>

<a id="faq"></a>

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| 双击没有启动 / 权限不足 | 在项目目录用 `/bin/bash Start-Console.command`；检查 Node 版本与终端报错 |
| 找不到 brew / Node / Python | 完成基础环境安装；按 Homebrew 提示配置 PATH 后重开终端 |
| macOS 阻止某个下载的二进制 | 按官方 Homebrew 安装方式重装 tunnel-client；不要关闭系统安全机制 |
| 安装到一半失败 | 修复报错后重跑；校验通过的已安装组件会复用 |
| 服务提示命令路径失效 | 查看 YAML 与 `.suggested`，确认程序真实路径，保留凭据后合并 |
| 控制台端口被占用 | 使用 `PORT=17643 npm start`，或正常关闭已确认的旧控制台 |
| 隧道连接失败 | 核对 Tunnel ID、Runtime API Key、网络与代理；并行实例使用不同 Tunnel ID |
| Mac 休眠后状态需要刷新 | 等待重新探测；身份或退出未确认时不会盲目终止进程 |
| MCP 已装好，但 Antigravity 任务失败 | 确认 IDE 已登录、运行且会话可用；查看 IDE 与 MCP 的业务错误 |
| 忘记管理员密码 | 先备份整个数据目录；删除数据重新初始化会清空原账号库 |
| 换电脑怎样迁移 | 备份数据与业务配置，在新电脑重新安装组件并核对路径；同时在线的电脑用不同 Tunnel ID |

Mac 的「关闭本控制台管理的隧道」会逐个核验托管实例。外部启动的进程或无法确认身份的残留，会保留并提示，避免按程序名、端口或旧 PID 批量终止进程。

<a id="validation"></a>

## 验证记录

本分支提供 [macOS CI](https://github.com/zwsxzy/mcp-tunnel-account-manager/actions/workflows/mac.yml?query=branch%3Amac)，分别在 **macOS 15 / Apple Silicon** 与 **macOS 15 / Intel** 上运行：

- 完整默认 unit 测试，使用原有的文件超时与断言约束。
- 原生进程生命周期、身份核验、停止范围与辅助进程资源测试。
- 组件隔离安装、只读检查，以及 Overleaf / Antigravity 的 MCP stdio 握手。

Windows 专用的 7 项 PowerShell / Win32 测试在 Mac 上标明平台不适用，并由独立 Windows CI 作业运行。Mac 的进程行为由新增的 POSIX 测试实际验证。

**请以对应提交的 Actions 结果和[移植验证说明](docs/MACOS-VALIDATION.md)为准。** 安装、单元测试与 MCP 握手不代表你的真实 OpenAI 隧道、Overleaf 项目或 Antigravity IDE 任务已通过；这些需要自己的账号与运行中的 IDE。

本地复现完整 unit：

```bash
mkdir -p "$PWD/artifacts/mac-port-20261113/unit/tmp"
TEST_ARTIFACT_ROOT="$PWD/artifacts/mac-port-20261113/unit" \
TMPDIR="$PWD/artifacts/mac-port-20261113/unit/tmp" \
TEMP="$PWD/artifacts/mac-port-20261113/unit/tmp" \
TMP="$PWD/artifacts/mac-port-20261113/unit/tmp" \
node scripts/run-tests.mjs --unit \
  --report "$PWD/artifacts/mac-port-20261113/unit/report.json"
```

测试产物与用户运行状态均不提交到 Git。

## 参与项目

欢迎提交可复现的 Issue 或改进建议。报告问题时请附上：Mac 芯片类型、macOS 版本、Node 版本、出问题的步骤和脱敏错误信息。请勿附带 API Key、bootstrap code 或真实账号库。

如果项目对你有帮助，**给一个 ⭐ Star** 是最直接的支持。也欢迎把使用经验分享给需要管理多个 MCP 的朋友。

感谢 [OpenAI tunnel-client](https://github.com/openai/tunnel-client)、[Overleaf MCP](https://github.com/yangzichao/mcp-server-overleaf) 与 [Antigravity MCP fork](https://github.com/zwsxzy/antigravity-mcp-fork) 的上游项目。
