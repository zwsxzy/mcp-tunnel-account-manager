# MCP 隧道账号控制台 v1.2.0-preview.5

面向 Windows 10/11 x64 的公开预览版，部署构建标识为 `20261109-rc22-r1`。本版本在 RC21 基础上合并了 `feature/concurrent-account-tunnels` 分支的**并发账号隧道**能力，并修复了三个已确认的用户可见缺陷。应用元数据仍为 `1.0.0`；构建标识与 GitHub tag 相互独立。

## 新增：并发账号隧道

- 引入实例级运行时记录与生命周期：`src/core/concurrent-instances.mjs`、`src/core/instance-lifecycle.mjs`、`src/adapters/instance-adapter.mjs`、`src/http/instance-routes.mjs`。
- 在保留原有 `active_profiles` 单活跃指针语义的前提下，支持同一服务并行运行多个账号隧道；实例作用域对既有消费方是**增量**的（旧的整服务动作 `instanceId` 为 `null`，行为不变）。
- 幂等指纹在未指定实例时保持逐字节一致，历史幂等键可继续重放。

## 修复

### 1. HTTP 隧道在回滚恢复后再也无法启动

回滚由 `restoreIfOwned()` 完成，它把进程记录写成 `operationId = "<原opId>-restored"`，但 `packetPath` 仍指向**原始 operation 封装的加密包**。随后 `prepare()` 用这个带后缀的 id 作为传输上下文去解封，而 operationId 已经绑定在 AES-GCM 的 AAD 中，校验必然失败，于是每次启动/重启都以 `INVALID_HTTP_STATE` 被拒绝并记录为 `REJECTED`。

修复：以包内自带的 `operationId` 为准（它才是该信封的权威上下文），推导包路径时剔除 `-restored` 后缀，并把解析结果回写到 `originalOperationId` 供回滚复用。

### 2. 任何 MCP 服务都无法从控制台移除

`remove()` 读取 `rt?.state`，但运行态 DTO 实际字段是 `runtimeState` / `tunnelClient.state`（只有 `formatRuntime()` 才派生 `state`）。于是运行态恒为 `'unknown'`，`removalDecision()` 对所有服务都返回 `RUNTIME_STATE_UNKNOWN`，移除功能整体不可用。

修复：按 `tunnelClient.state` → `state` → `runtimeState` 顺序解析，与服务卡片和前端 `canDeleteMcp()` 同源；服务真实运行时仍返回 `MCP_RUNNING` 保护，未知状态仍拒绝。

### 3. 拒绝原因在界面上不可见

前端只读 `op.failureCode`，而 MCP 生命周期动作的错误码字段是 `errorCode`，导致所有失败都显示成光秃秃的 `[REJECTED] 操作被拒绝: REJECTED`，掩盖了真实原因。

修复：按 `errorCode` → `error_code` → `failureCode` → `error` 回退显示。

## 发行元数据

- 构建标识更新为 `20261109-rc22-r1`（模板变量同步注入）。
- 按合并后的源码重新计算 `source-core-hashes.json`（39 个核心文件，RC19/RC20/RC21 基线不再适用）。
- `source-provenance.json` 记录新增特性与合并来源。

## 测试

- 全量单元测试 45/45 文件通过；`scripts/check.mjs` 对 122 个文件完成语法校验。
- 新增回归测试并**验证其在无修复时确实失败**：
  - `prepare survives a -restored process-record tag by reusing the packet own operationId`；
  - 移除运行态解析的三条用例（`runtimeState` 回退、`tunnelClient` 优先、运行中仍拒绝）。
- 已知问题：`Third MCP E2E` 需要真实 control-plane 验证，在本地环境失败；该问题在本次改动之前即存在（`HEAD` 上同样失败），与本次变更无关。

## 下载

- **[完整部署包（推荐，约 65.8 MB）](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.5/MCP-Windows-Deployment-Kit-20261109-rc22-r1.zip)**：控制台、Node、tunnel-client、cloudflared、Overleaf MCP 及 npm 生产依赖、Antigravity MCP。
- [控制台 Windows x64 便携包（约 34.4 MB）](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.5/MCP-Tunnel-Console-Windows-x64-20261109-rc22-r1.zip)：仅控制台与 Node。
- [源码与打包工具（约 0.4 MB）](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.5/MCP-Tunnel-Console-Source-20261109-rc22-r1.zip)：不含 Node 或服务依赖。
- [SHA256 校验清单](https://github.com/zwsxzy/mcp-tunnel-account-manager/releases/download/v1.2.0-preview.5/SHA256SUMS.txt)

## 部署与隐私

- 建议解压到 **C:\MCP 或 D:\MCP 等短、可写目录**，不要在 ZIP 内直接启动。
- 首次先校验包，再运行根目录 `Start-Console.cmd`；管理界面只绑定 `127.0.0.1`，默认端口 17642。
- 初始化码、管理密码、数据库与密钥均在目标电脑本地生成；发行文件不携带作者账号、真实 API Key、数据库、Cookie 或 IDE 登录目录。
- 端口冲突时拒绝启动，不按端口批量杀进程；停止时核对程序路径、命令行与创建时间。
