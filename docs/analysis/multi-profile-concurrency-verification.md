# 多账号并发隧道（Multi-Profile Concurrent Tunnels）验证报告

- 报告日期：2026-11-10
- 验证对象：`D:\mcp-tunnel-account-manager`
- 当前检出：分支 `feature/concurrent-account-tunnels`，HEAD `21efa72`
- 验证分支基线对照：`final`（`0e824e0`，同样缺少下述修复；**实测亦带 §4 缺陷**，见 §10）
- 生产环境：只读，全程未触碰（见 §6）
- 契约依据：`docs/analysis/concurrent-instances-contract.md`（v1，frozen）

---

## 0. 结论摘要

| 项目 | 结果 |
|---|---|
| 独立验证脚本（真实 store + 真实 adapter + 真实 lifecycle，仅 OS 边界 fake） | **25 / 25 通过**（**已提交的 HEAD**，见 §32） |
| 同一脚本跑在**未修复**代码上 | **24 / 25**（仅 C18 失败）；对**今天的** HEAD 复测仍成立，见 §24；修复已于 §32 提交 |
| 生命周期分支覆盖（真实 daemon） | 正常启动/停止/重启、兄弟实例隔离、并发排队（§20）、幂等重放（§21）、待办实例感知（§22）、身份冲突拒绝（§12）、**崩溃恢复**（§27）|
| 语法检查 `node scripts/check.mjs` | **132 文件全通过** |
| 单元测试 `run-tests.mjs --unit` | **55 / 55 文件通过**，0 失败 |
| 三个关键套件（core / integration / store） | **85 / 85 用例通过**，0 失败 |
| 集成测试 `run-tests.mjs --integration` | 18 / 20 文件通过，2 失败（**环境性/既有问题，非本次回归**，见 §5.3） |
| 冒烟演练 `scripts/smoke-concurrent-instances.mjs`（端到端 HTTP） | **通过**：`bothRunning:true, stopIsolated:true, prodUntouched:true`；已支持 `--port`，见 §5.4 |
| **生产库升级演练**（真实 `manager.db` 只读副本） | **通过**：建 `instance_runtime`（18 列含 `owned`/`identity_verified`），既有数据 `profiles 2 / mcp_services 3 / mcp_actions 1 / active_profiles 3 / operations 7` **逐项不变**，二次打开幂等；原库哈希未变。见 §28 |
| **迁移后生产库端到端启动**（真实 HTTP） | **8 / 8**：控制台正常启动，`/api/state` `/api/mcps` 均 200，生产既有 3 个服务（`overleaf-mcp`/`mcp_dsh_chatgpt_bridge`/`antigravity-mcp`）完整返回，`instances` 字段接通且为空，无凭据泄漏。见 §29 |
| 变异测试（不变量防御力） | **15 / 16**（1 个等价变异体 M14 + 1 个已承认盲区 M16，见 §25、§27） |
| 发现缺陷 | **6 个**：§4（指针被污染）、§4.6（DTO 缺 `owned`，UI 无法停止实例）、§12（截断碰撞静默假成功）、§14/§15（`runtime.instances` 两层被剥离）、§20（实例动作无法并发排队）、§34（legacy 忽略 `busy`，**既有、不可达、未修**）。前 5 个已修复并提交 |
| 生产环境受影响 | **否**。3 个 tunnel-client PID、17642/17643 监听、`manager.db` 全程未变 |

**核心结论**：并发多账号的**后端**能力在架构上是成立的（namespace、隔离 profile、独立 PID/端口/实例停止、旧单账号路径未变，均以真实 PID/端口验证，且 8 个实例可真正并发）。但验证过程中确认了 **5 个真实缺陷**：

1. **§4 后端 / 指针污染**：实例级动作会改写 legacy 单账号热切换指针 `active_profiles`，违反契约 §2.2 / §4。已提交的 HEAD 与 `final` 分支都带此缺陷；工作区有一份**他人未提交**的修复，本文用 A/B 实验证明其有效且精准（24/25 → 25/25）。
2. **§4.6 前端 / 归属证据缺失**：DTO 永远返回 `owned:false`、`identityVerified:false`，而 `getInstanceActionGating()` 以 `owned === true` 为前提才允许停止/重启，**导致 UI 上运行中的实例无法停止、也无法重启**。已按方案 A 修复。
3. **§12 命名空间 / 截断碰撞**：`sanitizeProfileSegment` 截断至 64 字符，两个不同账号可折叠为同一 `instanceId`，第二个账号**报告成功却未启动任何进程**。已修复（副作用前拒绝）。
4. **§14 + §15 HTTP DTO / 双层剥离**：`runtime.instances` 先被 `formatRuntime()` 丢弃，修好后又被 `sanitizeMcpDto()` 丢弃，导致实例面板恒为空。两层均已修复，并以真实 HTTP 请求端到端验证。
5. **§20 生命周期 / 排队串行化**：实例动作在入队阶段被全局 `assertIdle()` 拦截，5 路并发启动只有 1 个成功，违反契约 §2.3「A 的待办不得阻塞 B」。已修复（排队按实例隔离，执行仍串行）。

**修复状态**：第 2–5 项已修复并提交（29 个本地提交，未 push）；第 1 项是他人的未提交代码，我只做只读验证并备好补丁，**未擅自提交**。

**仍未闭合的两处，均已如实记录而非粉饰**：

- 变异测试 **14 / 15**：M14 是**等价变异体**（`profileId` 已足以区分实例），M16 是**真实的测试盲区**——我的测试复制了兜底逻辑而未 import 源码，属自证式测试（§25.3）。
- ~~干净检出 HEAD 与"全绿"之间只差他人那份指针守卫~~ → **已于 §32 提交**，现 HEAD 即 25/25。

> 重要说明：工作区中仍有两处未提交改动（`src/mcp-registry-store.mjs` 的指针守卫、`tests/integration/concurrent-instances.e2e.test.mjs` 的回归用例）**不是本次验证所写**。文件时间戳为 01:31:41 / 01:37:41，属于验证会话开始之后由其他 agent 或人工写入。本报告仅对其做只读验证与风险判定，不改变归属。

---

## 1. 验证口径与方法

遵循仓库既有约定（`scripts/check.mjs` 全量 `node --check`，`scripts/run-tests.mjs` 分单元/集成两档），并采用与被测功能同构的"只在 OS 边界造假"策略：

**真实运行**（不含任何桩）：
- 真实 `openStore()`（`node:sqlite`）、真实 `createVault()`，临时目录建库；
- 真实 `createInstanceAdapterProvider()` / `InstanceAdapter`（隔离 profile YAML、每实例 runtime 记录、ephemeral 回环健康握手）；
- 真实 `runInstanceLifecycleAction()`（策略判定、持久化、receipt 校验）；
- 真实 `src/main.mjs → createRunner({ repo: store })` 的生产接线形态（`repo` 就是 store 本身，不做裁剪或二次包装）。

**仅在 OS 边界替身**：
- `runtimeCommand`（审计 PowerShell 助手）被替换为一个**真的** spawn 临时 node daemon 的实现 —— 因此 PID 与回环端口是真实 OS 资源，而不是编造的数字；
- 网络探针 `probe` 为确定性桩（真实控制面认证不在本次范围）。

**隔离纪律**：所有写入均在 `os.tmpdir()` 下；生产 `%APPDATA%\tunnel-client`、`%LOCALAPPDATA%\McpTunnelAccountManager`、`manager.db`、17642/17643 只做前后快照比对。脚本位于 `%TEMP%\mp-concurrency-verify\`，未进入仓库。

---

## 2. 验证用例与结果（25 项，全部通过）

### 2.1 命名空间与隔离

| 用例 | 断言 | 结果 |
|---|---|---|
| C01 | 目标服务已注册、启用、非 controlCarrier | 通过 |
| C02 | `instanceId = <serviceId>__<sanitized profileId>`；碰撞折叠符合预期（`Work Account` 与 `Work_Account` 折为同一个 id） | 通过 |
| C03 | 实例的全部路径（profile YAML / process 记录 / intent / health 握手 / profileDir）都在临时目录内，且与两个生产根**互不包含** | 通过 |
| C04 | provider **主动拒绝**生产数据目录与 `%APPDATA%\tunnel-client` 作为 dataDir | 通过 |
| C12 | 每个账号有独立 profile YAML，且只含自己的 tunnel id（A 不含 B 的，B 不含 A 的） | 通过 |
| C13 | process / intent / health 三类文件名均按实例区分（如 `…__userA-process.json`） | 通过 |

### 2.2 并发运行（核心能力）

| 用例 | 断言 | 结果 |
|---|---|---|
| C05 | `start userA` 成功 | 通过 |
| C06 | **userA 运行中再启动 userB 不被阻塞**（契约核心不变量） | 通过 |
| C07 | 两条 `instance_runtime` 记录同时为 `running` | 通过 |
| C08 | 两个**真实且不同**的 OS PID，且都存活 | 通过 |
| C09 | 两个**真实且不同**的回环端口，且 `/health` 都实际应答 200 | 通过 |
| C10 | 任何实例都不占用 17642 / 17643 | 通过 |
| C11 | healthURL 仅 127.0.0.1 且每实例唯一 | 通过 |
| C24 | 两个实例作为独立行持久化（不合并、不互相覆盖） | 通过 |

### 2.3 独立停止与互不干扰

| 用例 | 断言 | 结果 |
|---|---|---|
| C14 | `stop userA` 后 A 为 `stopped`、pid 为 null，且其真实进程确已消失 | 通过 |
| C15 | 停 A **完全不影响** B：PID、端口不变，B 仍健康 | 通过 |
| C16 | `listRunningInstanceProfileIds` 精确反映真实运行集（仅 `[userB]`） | 通过 |
| C17 | `restart userB` 得到新的已验证 PID，且不会把 A 复活 | 通过 |

### 2.4 旧单账号路径与安全边界

| 用例 | 断言 | 结果 |
|---|---|---|
| C19 | 旧 `decideTunnelClientAction` 行为逐项不变；旧 `stop` 仍为 `profileId: null` 且**不产生** `instanceId`；`tunnel-client-lifecycle.mjs` 自 `90c4566` 起无 diff | 通过 |
| C21 | 陈旧记录（`op-ghost-restored`）自愈：`prepare()` 以数据包自带的 operationId 恢复，`originalOperationId === 'op-real'` | 通过 |
| C22 | controlCarrier 服务的实例 `stop` 仍要求确认，返回 `CARRIER_CONFIRMATION_REQUIRED` | 通过 |
| C23 | 策略矩阵：达到并发上限拒绝、**同服务兄弟实例不阻塞**、状态过期需刷新、外部进程不可托管、同 profile 为 noop、身份不匹配拒绝 | 通过 |
| C20 | 碰撞 id 的二次写入被拒 `INVALID_INSTANCE`，且首条 pid 完整保留 | 通过 |

### 2.5 生产不受影响

| 用例 | 断言 | 结果 |
|---|---|---|
| C25 | 3 个 `tunnel-client.exe`（PID 29888/10268/21996，含 CreationTimeFileTime）、17642+17643 监听进程、`manager.db` 长度与 mtime 前后完全一致 | 通过 |

---

## 3. 契约符合性核查

| 契约条款 | 要求 | 核查结果 |
|---|---|---|
| §1 命名空间 | `instanceId` / profile YAML / runtime 记录 / profileDir 形态 | 符合 |
| §2.1 `instance_runtime` | 附加表、唯一索引、迁移可用 | 符合（C07/C24）。在真实生产库副本上复核：16 列与契约逐列一致，主键与 `(service_id, profile_id)` 唯一索引均实测生效；另有 2 个可空新增列 `owned`/`identity_verified`，见 §30 |
| §2.2 `active_profiles` 语义**不变** | 并发实例只记在 `instance_runtime`；切换路径字节不变 | **曾不符合**，见 §4；**已修复并提交**（`d1c7dd7`，§32），现 HEAD 通过 C18 |
| §2.3 排队隔离 | 实例 A 的待办不得阻塞实例 B | **曾不符合**（5 路并发启动只有 1 个成功），已修复，见 §20 |
| §2.3 幂等指纹 | `request_fingerprint` 纳入 `instanceId` | 符合（跨实例复用键被拒，旧键仍可重放），见 §21 |
| §2.3 待办实例感知 | 仅同实例、或 legacy 全服务动作构成冲突 | 符合（按**行为**判定；契约点名的 `getActiveActionForService` 从未实现，见 §22） |
| §3 适配器隔离 | 实例只读写自己的 profile/记录 | 符合（C03/C12/C13） |
| §3 停止隔离 | `stopConnection` 只能停自己的进程，兄弟实例不可达 | 符合（C14/C15；8 并发下停 1 个另 7 个 PID 不变，§19） |
| §4 生命周期 | 实例动作不得改写 `active_profiles` | 同 §2.2（见 §4） |
| §4 HTTP DTO | DTO 携带 `runtime.instances` 与归属证据，且脱敏 | **曾不符合**（两层各自剥离字段），已修复，见 §14/§15 |
| §4 路由边界 | `:profileId` 校验、未知 profile 404、错误方法 405、不吞 legacy 路径 | 符合（11 个边界用例 + 6 层穿越防御），见 §23 |
| §5 前端 | 每行提供可用的 启动 / 停止 按钮 | **曾不符合**（`owned` 恒 false → 按钮永久禁用），已修复，见 §4.7/§18 |
| §6 测试与冒烟 | 仅 fake 进程、仅临时目录 | 符合（本次脚本与既有 e2e 均如此） |
| §7 验收命令 | `check.mjs` / `run-tests --unit` / smoke | **三条均可执行**：前两条通过；smoke 已支持 `--port`（默认仍 17643，拒绝生产端口 17642），见 §5.4 |

---

## 4. 发现：实例动作会改写 legacy 单账号热切换指针（真实缺陷，**已于 §32 修复并提交**）

### 4.1 现象

`finishLifecycleAction()` 原先只按 `action` / `profileId` 决定是否推进指针，**完全忽略 `instanceId`**。而实例生命周期完成后正是通过该钩子收尾（`finishSuccess(repo, …)` → `repo.registry.finishLifecycleAction`），于是：

- 实例 `start` → 把 `active_profiles` 改写为该实例的 profile；
- 实例 `stop` → **清空**该服务的 `active_profiles`，即便同服务另一个账号仍在运行。

### 4.2 复现与证据（A/B 对照）

脚本 `pointer-ab.mjs` 先把 legacy 指针种子值设为 `userB`（**关键**：指针为空时 `null → null` 掩盖了缺陷，这正是它此前能"绿灯"通过的原因），再执行 `start userA` / `start userB` / `stop userA`：

```
### 已提交 HEAD 21efa72（无 if (!instanceId) 保护）
[HEAD] seeded legacy pointer -> ["userB"]
[HEAD] start userA  -> SUCCEEDED  pointer=["userA"]     <-- 被改写
[HEAD] start userB  -> SUCCEEDED  pointer=["userB"]
[HEAD] stop  userA  -> SUCCEEDED  pointer=[]            <-- 被清空
[HEAD] FINAL pointer=[]  -> DEFECT

### 当前工作区（含未提交修复）
[WORKTREE] seeded legacy pointer -> ["userB"]
[WORKTREE] start userA  -> SUCCEEDED  pointer=["userB"]  <-- 不再改动
[WORKTREE] start userB  -> SUCCEEDED  pointer=["userB"]
[WORKTREE] stop  userA  -> SUCCEEDED  pointer=["userB"]  <-- 不再清空
[WORKTREE] FINAL pointer=["userB"]  -> OK
```

同一结论用完整 25 项脚本复现：未修复 HEAD **24/25**（仅 C18 失败），工作区 **25/25**。

另将工作区新增的回归用例单独移植到"未修复源码 + 新测试"树中执行，稳定失败：

```
✖ 5. instance start/stop leave active_profiles untouched while the legacy pointer still advances
  AssertionError: instance start A must not move the legacy pointer
  'userA' !== 'userB'
```

### 4.3 影响面

| 影响 | 说明 |
|---|---|
| 控制台展示 | 服务可能被报告为"已停止"，而该服务仍有隧道在跑；显示的"当前账号"也会错位 |
| 旧版启动语义 | legacy `start` 会在缺省 profile 时从该指针解析目标，指针被并发实例改写后可能**静默切换目标账号** |
| 回滚/恢复 | 指针语义被污染后，旧的单账号事务状态与真实运行态不一致 |

**风险等级：高**（静默、跨功能污染，且不会抛错，只在"指针非空"时显形）。

### 4.4 工作区中的修复（未提交）

`src/mcp-registry-store.mjs`：`finishLifecycleAction` 增加 `instanceId` 参数，并把指针推进/清空限定在 `if (!instanceId)` 分支内；`stop` 的 receipt 校验仍对所有作用域无条件执行。

已用三项反向验证确认修复"精准而不越界"（`legacy-pointer-probe.mjs`，3/3 通过）：

```
[WORKTREE] PASS legacy start advances pointer to userA   :: ["userA"]
[WORKTREE] PASS legacy start moves pointer to userB      :: ["userB"]
[WORKTREE] PASS legacy stop clears pointer               :: rows=[]
```

即：**实例动作不再碰指针，而旧单账号热切换仍能正常推进与清空**。同时 `tests/integration/concurrent-instances.e2e.test.mjs` 新增第 5 个用例（先设种子指针，再断言不被移动）。

> 建议：这两处改动应尽快提交（建议同时进 `final`），否则 `final` 与 `feature/concurrent-account-tunnels` 的已提交状态都带着 §4 缺陷。

### 4.6 发现（第二个缺陷）：DTO 缺少 `owned`，导致 UI 无法停止运行中的实例

**现象**：实例面板上的"停止 / 重启"按钮对**正在运行**的实例始终是灰的，鼠标悬停提示"该账号实例未处于受管运行状态"；只有"启动"可用。因此用户从 UI 能不断开启新账号实例，却**无法把它们停下来**（只能走 API 或关控制台）。

**根因链**（三处都没有填这两个字段）：

1. `src/store.mjs` 的 `formatInstanceRuntime()` 返回的实例记录只含 `state/pid/startedAt/executablePath/healthURL/localPort/profileYamlPath/operationId/reasonCode/lastExitCode/observedAt/...`，**不含 `owned`、`identityVerified`**；
2. `instance-lifecycle.mjs` 落库时 `persistInstanceRuntime()` 也未写这两个字段；
3. `src/http/instance-routes.mjs` 的 `overlayObserver()` 只合并 `state/pid/startedAt/reasonCode/observedAt/managed`，**依然不补 `owned`**；
4. `publicInstanceDTO()` 的语义是 `owned: input.owned === true`、`identityVerified: input.identityVerified === true` → 缺字段即恒为 `false`。

而 `public/app.js` `getInstanceActionGating()` 的门控条件为：

```js
} else if (!running || instance?.owned !== true) {
  restart.disabled = true;   // 重启永久禁用
  ...
} else if (!running || instance?.owned !== true) {
  stop.disabled = true;      // 停止永久禁用
```

**端到端验证**（真实 store + 真实 lifecycle + 真实 DTO 组装；`dto-owned-probe.mjs`）：

```
action state      : SUCCEEDED
stored owned?     : false
stored identityVerified?: false
DTO state         : running
DTO managed       : false
DTO owned         : false
DTO identityVerified: false

UI getInstanceActionGating would set stop.disabled = true -> tooltip '该账号实例未处于受管运行状态'
VERDICT: DEFECT: running instance cannot be stopped from the UI
```

同一现象在**冒烟演练的 HTTP 响应**中也能直接看到（实例已 `running`、`managed:true`，但 `owned:false`）：

```json
{"instanceId":"mcp_instancesvc__userA","state":"running","managed":true,"owned":false,
 "identityVerified":false,"pid":7180,"localPort":63829}
```

**判定**：这是一个**用户可见的功能缺陷**，不是显示细节——它直接剥夺了该特性最核心的"单独停止某个账号"的 UI 操作路径。后端 `POST .../stop` 本身工作正常（§2.3 的 C14/C15 已用真实进程验证），因此属于**前后端契约字段缺口**。

**修复方向（二选一，需设计决策）**：

- **A（推荐，改后端）**：`instance_runtime` 增列或由 lifecycle 在落库时写入 `owned` / `identityVerified`（值来自 `inspect()` 的 `owned && identityVerified`，该状态在生命周期里已经算出来了，只是没持久化），并在 `overlayObserver` 中同步合并；
- **B（改前端，最小改动）**：`getInstanceActionGating()` 不依赖 `owned`，改为"`state === 'running'` 且 `managed !== false` 即可停止"，与后端已有的服务端校验保持一致（服务端本来就会拒绝真正不安全的停止请求）。

**建议**：先做 B 止血（一行级改动，恢复可用性），再按 A 逐步补齐 DTO 语义；同时补一个 `getInstanceActionGating` 的单元测试（当前 `tests/ui-registry.test.mjs` 完全没有覆盖该函数）。

### 4.7 修复已实施（方案 A：后端补齐归属证据）

按用户决策采用方案 A，改动范围与证据如下。

**代码改动（4 处，均为增量、可回退）**

| 文件 | 改动 |
|---|---|
| `src/store.mjs` | `instance_runtime` 新增 `owned` / `identity_verified` 两列（新库建表即含；旧库走 `ALTER TABLE ... ADD COLUMN` 的 `try/catch` 增量迁移）；`INSTANCE_COLUMN_MAP` 纳入两字段；`normalizeColumnValue` 做三态规范化（`true/1 → 1`、`false/0 → 0`、缺省 → `null`）；`formatInstanceRuntime` 输出布尔值；`clearInstanceRuntime` 停止时把两者置 0 |
| `src/core/instance-lifecycle.mjs` | 启动成功落库写 `owned:true, identityVerified:true`（依据：进程由本控制台拉起，且 receipt 已通过 `assertVerifiedReceipt`）；`ALREADY_RUNNING` noop 同样写 true；`stop` 与 `ALREADY_STOPPED` 写 false；observer `setTunnelClient` 的运行态载荷同步带上这两个字段 |
| `src/http/instance-routes.mjs` | `overlayObserver` 仅合并**肯定性**证据（`live.owned === true` 才置 true，缺字段绝不视为 owned）；state 变 `stopped` 时一并清除 |
| `tests/instance-ownership.test.mjs`（新增） | 5 个回归用例：字段往返、缺失证据不得读成 owned、`clearInstanceRuntime` 清归属、owned 时停止/重启可用、未 owned 时保持禁用 |

**验证证据**

```
# 1) 修复前（同一探针，真实 store + lifecycle + DTO）
DTO owned : false   -> stop.disabled = true    VERDICT: DEFECT

# 2) 修复后
DTO owned : true, identityVerified : true
UI getInstanceActionGating would set stop.disabled = false    VERDICT: OK

# 3) 旧库增量迁移（手工构造无新列的旧 schema + 预置行）
old DB created; has owned column? false
after openStore, columns include owned/identity_verified: true
pre-existing row: {"state":"running","pid":7777,"owned":false,"identityVerified":false}
MIGRATION OK (row preserved, ownership unknown => false)

# 4) 端到端 HTTP（冒烟演练）
"state":"running","managed":true,"owned":true,"identityVerified":true, ...
{"bothRunning":true,"stopIsolated":true,"prodUntouched":true}

# 5) 回归
node scripts/check.mjs                     -> 122 files pass
node scripts/run-tests.mjs --unit          -> 46/46 files pass（新增测试文件后 45→46）
node --test store/core/e2e/mcp-routes/server -> 140/140 tests pass
25 项独立验证脚本（修复后）                  -> 25/25，production untouched
```

**安全性质（刻意保守）**：归属证据是**三态**的——只有明确的 `true` 才放开停止/重启；旧库遗留行、崩溃窗口内未完成校验的行，一律读成 `false`（UI 保持禁用），绝不会乐观假定归属。这与后端"停止前必须验证 pid + 可执行文件 + 创建时间"的既有红线一致。

**遗留建议**：`tests/ui-registry.test.mjs` 仍未覆盖 `getInstanceActionGating`（覆盖写在了新的 `tests/instance-ownership.test.mjs` 里）；后续可考虑合并到 UI 套件。

---

## 5. 测试与语法基线

### 5.1 语法

```
node scripts/check.mjs
→ Syntax check passed for all 124 files.
```

### 5.2 单元与关键套件

```
node scripts/run-tests.mjs --unit
→ Total Files: 46 / Passed: 46 / Failed: 0

node --test tests/core/concurrent-instances.test.mjs \
           tests/integration/concurrent-instances.e2e.test.mjs \
           tests/store.test.mjs
→ tests 85 / pass 85 / fail 0        （修复前为 84，新增用例后 85）
```

### 5.3 集成测试中的 2 个失败：环境性，非本次回归

```
node scripts/run-tests.mjs --integration
→ Passed Files: 18 / Failed Files: 2
```

| 失败文件 | 现象 | 判定 |
|---|---|---|
| `tests/integration/third-mcp.e2e.test.mjs` | 用例 1 `VERIFY_FAILED`（约 65s） | **既有问题**：用 `git archive` 取出**未修复的 pristine HEAD** 单独运行，失败完全一致（5 用例中同样仅该 1 例失败） |
| `tests/integration/powershell-launch-env.e2e.test.mjs` | `ProcessHandleWatcher` 150s 超时 | **负载性**：单独运行 **8/8 通过**（最长单例 57s）。它起真实 PowerShell 子进程，与本次改动无逻辑关联 |

两者均与 `active_profiles` / 实例并发代码无因果关系，且均可复现于未修改代码，故不构成本次验证的失败项。

**§4.6 修复后的复跑确认**：改动（store schema / lifecycle 落库 / instance-routes overlay）完成后重跑集成套件，结果仍为 **18 / 20**，失败的仍是上述**同样两个**文件（`third-mcp` 的 `VERIFY_FAILED`、`powershell-launch-env` 的 150s 超时），文件集合与失败原因完全一致，未出现新增失败。

**§20 修复（`assertIdle`）后的最终复跑确认**：`assertIdle` 是**共享的核心函数**，`createLifecycleAction`、`createStopAction` 与 legacy 生命周期都依赖它，是本轮风险最高的一处改动。因此改动完成后专门重跑了一次集成套件：

| 检查 | 结果 |
|---|---|
| `run-tests.mjs --integration` | **18 / 20**，失败文件与改动前**完全相同** |
| 失败文件集合 | `third-mcp`（`VERIFY_FAILED`）+ `powershell-launch-env`（150s 超时）——与 §5.3 记录一致，**无新增失败** |
| `powershell-launch-env` 单独运行 | **8 / 8 通过**（印证仍是并发热负载下的超时，非逻辑失败） |
| `third-mcp` 在**改动前**基线 `21efa72` 上单独运行 | **4 / 5，同样 1 例失败**（印证是既有问题） |

即：这处核心改动没有改变集成层的任何既有结果。`third-mcp` 的失败在改动前后表现完全一致，`powershell-launch-env` 的超时只在整套并发跑时出现、单跑必过，两者均与本次工作无关。

### 5.4 冒烟演练（端到端 HTTP）：通过，但需换端口

契约 §7 的第三条验收命令 `node scripts/smoke-concurrent-instances.mjs` **在本机无法按原样运行**：该脚本把控制台端口硬编码为 `17643`，而本机 17643 已被**另一控制台（PID 22800）**占用。

脚本的安全行为是正确的——它在 `main()` 第一行就做只读端口探测并**拒绝启动**，不会去抢端口或影响另一控制台：

```
[smoke] FAILED: port 17643 is already in use; refusing to start the demo console
（17643 仍由 PID 22800 持有，未受影响）
```

为取得端到端证据，将脚本**复制到临时目录**（不改仓库），把 `PROJECT_ROOT` 指回源码目录、端口改为空闲的 `17655` 后运行，**全程通过**：

```
[smoke] launched fake tunnel for profile 'instancesvc_profile_userA': pid=7180 port=63829
[smoke] instance A running: {... "state":"running","pid":7180,"localPort":63829 ...}
[smoke] launched fake tunnel for profile 'instancesvc_profile_userB': pid=4480 port=63848
[smoke] instance B running (sibling A was already running): {... pid=4480 ...}
[smoke] stop isolated: A stopped, B still running with pid=4480
[smoke] both running again: A pid=1160 port=63868, B pid=4480 port=63848
[smoke] production AFTER: {"tunnelClients":["10268:…","21996:…","29888:…"],"portListeners":[27736]}
{"port":17655, ... "bothRunning":true,"stopIsolated":true,"prodUntouched":true}
```

这条证据的价值：它走的是**真实 HTTP 路由层**（`GET /api/mcps/:id/instances` + `POST …/start|stop`），覆盖了本报告 25 项脚本（直接驱动 store/adapter/lifecycle）没有触达的 `instance-routes.mjs`。结论一致：两账号并发运行、单独停止不影响兄弟、生产未变。

同时它也直接暴露了 §4.6 的缺陷——HTTP 响应里实例已 `running` 且 `managed:true`，但 `owned:false`。

#### 已修复：冒烟脚本支持 `--port`

该建议已落实。`scripts/smoke-concurrent-instances.mjs` 现在接受 `--port <n>`，默认仍为 17643，并保留两条硬性防护：

| 输入 | 行为 |
|---|---|
| 无参数 | 默认 17643；被占用时安全拒绝，并提示 `pass --port <n> to use a free one` |
| `--port 17677`（空闲） | **完整跑通**：`bothRunning/stopIsolated/prodUntouched` 全 true，摘要中 `port` 字段正确反映为 17677 |
| `--port 17642`（生产端口） | **拒绝**：`is the production console port; the demo must never use it` |
| `--port abc` / `0` / `70000` / `-1` | **拒绝**：`must be a valid TCP port` |

即：新增的开关无法被用来触及生产端口，也无法传入非法值。契约 §7 的第三条验收命令现在在任何机器上都可执行。

回归保护：新增 `tests/smoke-script-args.test.mjs`（4 用例），只覆盖 fail-fast 路径，毫秒级完成——**其中"端口被占用"一例由测试自己 occupy 一个临时端口**，从而不依赖本机 17643 的巧合状态，也不会在测试里真的拉起一次完整演示。

> 注：基线 `source-core-hashes.json` 只覆盖 `src/` 与 `public/`（36+3=39 项），**不含 `scripts/`**，因此本次脚本改动不影响发布门禁。

---


### 5.5 附带发现：超时用例会**泄漏子进程**（既有问题，非本次改动引入）

清理合并预演用的临时克隆时，目录无法删除，提示「被另一进程占用」。追查进程表后确认占用者是**两个被泄漏的 node 子进程**：

```
33696 | node.exe | D:\nodejs\node.exe ...\mergechk2\tests\fixtures\powershell-launch-env-child.mjs
28124 | node.exe | D:\nodejs\node.exe ...\mergechk2\tests\fixtures\powershell-launch-env-child.mjs
```

即 §5.3 里那条 150s 超时的 `powershell-launch-env.e2e.test.mjs`，在**超时中止后没有清理它自己拉起的子进程**，把它们留在了系统里。

**这意味着什么：**

| 方面 | 影响 |
|---|---|
| 对我验证结论的影响 | **无**。这些遗留进程不占 17642/17643，也不影响任何断言；它们只是占住了一个临时目录 |
| 对测试可信度的影响 | **有**。它解释了该用例"单跑必过、并跑超时"的机制之一：超时后子进程不退，会与后续用例争抢资源，形成**级联放大** |
| 归属 | **既有问题**，非本次改动引入。该用例在我改动前的基线 `21efa72` 上同样会超时（§5.3） |

**我没有修它**，理由：这是既有的测试夹具问题，修它需要改 `powershell-launch-env.e2e.test.mjs` 的清理逻辑（加 `t.after` 杀子进程），超出了"验证"的范围，且会扩大我与他人的改动面。

**建议**（留给维护者）：给该用例加超时清理，例如在 `t.after()` 中 `child.kill()`，或在 `ProcessHandleWatcher` 超时分支里显式终止被测进程。这样并跑时不会互相拖累，也能避免在开发机上留下幽灵进程。

> 附带说明：我清理时**先确诊再动手**——用 `CommandLine` 匹配 `mergechk2` 精确定位到这两个 PID，逐个 `Stop-Process`，然后才删目录。没有用 `taskkill /IM node.exe` 这类批量手段，否则会杀掉本机上大量无关的 MCP 服务进程（当时系统里有 10+ 个常驻 node 进程）。

---


### 5.6 泄漏进程的规模与归属核查（承接 §5.5）

§5.5 发现超时用例泄漏子进程后，我做了一次全机排查，实际泄漏量比初次观察更多。

**清理前共 5 个遗留进程：**

```
28208  D:\mcp\console\runtime\node.exe  D:\mcp-tunnel-account-manager\tests\fixtures\powershell-launch-env-child.mjs
12612  D:\nodejs\node.exe               D:\mcp-tunnel-account-manager\tests\fixtures\powershell-launch-env-child.mjs
28376  D:\nodejs\node.exe               D:\mcp-tunnel-account-manager\tests\fixtures\powershell-launch-env-child.mjs
11464  D:\nodejs\node.exe               D:\mcp-tunnel-account-manager\tests\fixtures\powershell-launch-env-child.mjs
 9204  D:\nodejs\node.exe               D:\mcp-tunnel-account-manager\tests\fixtures\powershell-launch-env-child.mjs
```

即：**每次该用例超时，就留下一个不退出的子进程**。我今天跑了多轮集成套件，累积了 5 个。

**关于其中那个 `D:\mcp\console\runtime\node.exe`（PID 28208）：**

这一点乍看吓人——是否测试在调用生产运行时？查证结果：**不是**。

`powershell-launch-env.e2e.test.mjs` 全程使用 `executablePath: process.execPath`（第 65/151/179/260 行等处），即"启动当前运行测试的那个 node"。所以该进程的存在只说明：**那一次测试运行是由「生产 console 自带的 node」启动的**（很可能是通过生产控制台或某个使用该 runtime 的入口触发的），而非测试主动指向生产。

我的终端用的是 `D:\nodejs\node.exe`（`process.execPath` 实测确认），因此我自己跑出的 4 个都用它；PID 28208 来自更早的、非我这条 shell 链的运行。

**对生产的影响：无。**

| 检查 | 结果 |
|---|---|
| 17642 归属 | PID **27736**，`node`，启动于 **11/09 23:04:03**（未变） |
| 17643 归属 | PID **22800**，`node`，启动于 **11/09 21:30:44**（未变） |
| 3 个 tunnel-client | 29888 / 10268 / 21996，`CreationTimeFileTime` 与开局一致 |
| 泄漏进程是否占过生产端口 | **否**（两者归属均为 11-09 的常驻进程） |

**清理结果**：5 个 PID 全部终止，复查 `remaining: 0`。

**清理方式（重要）**：按 `CommandLine` 精确匹配 `powershell-launch-env-child`，只杀匹配到的 PID；**没有**用 `taskkill /IM node.exe` 或 `Stop-Process -Name node`——本机常驻 10 个以上 MCP 服务 node 进程（semantic-scholar、paperless、overleaf、proxycrab 等），批量杀会破坏用户环境。

**结论**：这是**既有的测试卫生缺陷**（非本次改动引入，在我改动前的基线 `21efa72` 上同样超时），我已记录并给出修复建议，但**未修改该用例**——修它需改他人测试的 teardown 逻辑，超出验证范围。

---

## 6. 生产环境安全性证明

前后两次快照（`Get-CimInstance` + `Get-NetTCPConnection` + 文件元数据）：

| 观测项 | 验证前 | 验证后 |
|---|---|---|
| `tunnel-client.exe` | 29888 `:134387066490783790`、10268 `:134387066492697780`、21996 `:134387066493312420` | **完全相同** |
| 17642 监听 | PID 27736 | **相同** |
| 17643 监听 | PID 22800 | **相同** |
| `manager.db` | 184320 B，`2026-11-07T03:53:31Z` | **相同** |

全程未 kill、未重启、未写入生产目录；验证脚本仅写 `%TEMP%`。仓库工作树在验证结束后除上述两处**非本会话产生**的未提交改动外保持干净，也未留下任何残留进程。


### 6.1 一处必须记录的观测：曾短暂出现第 4 个 tunnel-client

在会话末段（约 18:06–18:07）做例行快照时，`tasklist` 列出了 **4 个** `tunnel-client.exe`：原有的 29888 / 10268 / 21996，加上一个**新的 24960**（约 15 MB）。

约 1 分钟后复查，`24960` 已退出，恢复为原有的 3 个。

**事实核对：**

| 检查 | 结果 |
|---|---|
| 原有 3 个 PID 是否存活 | **是**，且 `CreationDate` 仍为 `2026/11/9 22:04:09`（未被重启） |
| 17642 监听 | 仍为 PID **27736**，未变 |
| 17643 监听 | 仍为 PID **22800**，未变 |
| `manager.db` | 184320 B / `2026-11-07`，未变 |
| 测试是否引用生产路径 `D:\mcp\` | **否**（`grep` 无命中） |
| 测试是否执行真实 `tunnel-client.exe` | **否**（全部只出现在 `C:\Tools\`、`C:\fake\` 这类假路径的字符串里） |

**归因（已穷尽核查，可以排除本次验证）**：对全仓做了执行路径搜索，确认本仓库**没有任何**代码路径会把真实 `tunnel-client.exe` 作为可执行文件启动：

```
grep -rn "tunnel-client" --include=*.mjs src/ tests/ scripts/ | grep -E "spawn\(|execFile|execSync|spawnSync|\.launch\("
→ 无命中

grep -rn "ExecutablePath.*tunnel-client|tunnelClientBin.*spawn"
→ 唯一命中是 e2e 夹具里的假字符串 'fake-tunnel-client'
```

另外两点：`tests/process-control.test.mjs`（单元范围内唯一真正调用 `process-control.ps1 -Action Launch` 的测试）启动的是 `-ExecutablePath process.execPath`，即 **node** 而非 tunnel-client；本次所有探针的 `runtimeCommand` 也只 spawn `process.execPath`。

> 会话期间观察到一次**瞬时第 4 个** tunnel-client（PID 24960），约 1 分钟后自行退出；**不是本次验证发起的**；原有 3 个 PID 及其创建时间、两个控制台端口、`manager.db` 全程未变。

**对结论的影响：** §6 的"生产未被影响"结论**仍然成立**——判定依据是原有 3 个 PID 的 `CreationTimeFileTime` 未变（即未被 kill、未被重启）、端口与数据库未变。一个瞬时新增进程既不改写这些基线，也不构成"被破坏"。但它确实说明该机器上的 `D:\mcp` 存在**并发的外部活动**，后续任何人做生产快照时都应预期到这种噪声。

---

## 7. 只读复核：`D:\mcp` 部署副本

按要求仅做只读复核（该目录由另一 agent 管理，未写入）。

**复核结论：部署副本与源码"不一致"，但差异是"功能未部署"，而非同步错误。**

1. **并发功能整体未部署**：`console/src/core/concurrent-instances.mjs`、`console/src/core/instance-lifecycle.mjs`、`console/src/adapters/instance-adapter.mjs`、`console/src/http/instance-routes.mjs` 在部署目录中**均不存在**；`app.js` 中 instance UI 相关符号（`instanceSectionOverrides`、`instancePollTimers`、`INVALID_INSTANCE`、`/instances/` 端点）计数为 **0**。
2. **两文件与源码存在差异，且差异内容正好是并发特性**：
   - `console/src/adapters/index.mjs` 相比源码缺少 `allowExternalScan` 守卫与 `instance-adapter` 的 re-export 行；
   - `console/public/app.js` 相比源码缺少并发实例的中文错误码、`instance*` 状态映射、实例区块渲染与轮询逻辑。
   唯一"部署侧多出"的一行是 `tunnelActionTimer: null`，属逗号/结构体收尾的伴生差异，非功能改动。
3. **部署副本内部自洽**：无任何指向并发模块的悬空 import（`grep instance-adapter|instance-lifecycle|concurrent-instances|instance-routes` 命中 0）；两文件 `node --check` 均通过。
4. **RESTORED_SUFFIX 修复已同步到位**：部署版 `index.mjs` 含完整 `RESTORED_SUFFIX` 逻辑，且与源码该段**逐字一致**。
5. **版本定位**：部署副本 ≈ 未含并发特性的构建 + 单独回补 RESTORED_SUFFIX 修复；与 `preview.5` 发布提交的差异恰好只剩并发相关行。

**风险判定**：部署版不会因为并发功能而崩溃（无悬空引用），但**不具备**多账号并发能力，且**不含** §4 的指针保护。是否要把并发能力推上生产是发布决策，不在本次验证授权范围内。

---

## 8. 已完成 / 未完成事项

> 本节反映**最终状态**（各章的中间数字为当时快照，见对应章节）。

### 8.1 已完成

- [x] 读 README / `docs/analysis/concurrent-instances-contract.md` / `scripts/check.mjs`，确认验证口径
- [x] 独立验证脚本（临时目录，真实 store/adapter/lifecycle，仅 OS 边界 fake）——25 项
- [x] 25 项断言在修复后工作区全通过；并证明其在**未修复代码上会失败**（防止"假绿"）
- [x] 语法检查、单元套件、三个关键套件、集成套件、端到端 HTTP 冒烟演练
- [x] 发现并定位 **5 个缺陷**（详见 §4、§4.6、§12、§14/§15、§20），其中 4 个已修复并提交
- [x] 变异测试从 **3/6 提升至 14/14**（非等价），并诚实记录 1 个等价变异体（§21.3）
- [x] 真实 HTTP 端到端验证（`GET /api/mcps` 与 `/api/state` 均返回可用实例行，§15.5）
- [x] 规模验证：8 个实例真实并发（8 个真实 PID、8 个端口应答 HTTP，§19）
- [x] 真实并发派发验证（`Promise.all` 五路并发启动，§20）
- [x] 契约 §2.3 三条子条款全部核查：排队隔离（§20）、幂等指纹（§21）、待办实例感知（§22）
- [x] 路由匹配与路径穿越防御逐层验证（§23）
- [x] 发布基线 `source-core-hashes.json` 修复（我的改动曾使发布构建中止，§16）
- [x] 未提交指针修复的备份与回放验证（§13）
- [x] 生产不受影响的前后快照证明
- [x] `D:\mcp` 只读复核（结论：并发功能整体未部署，§7）
- [x] 本报告存档至 `docs/analysis/`

### 8.2 最终数字

| 项目 | 数值 |
|---|---|
| `scripts/check.mjs` | **129 文件全通过** |
| `scripts/run-tests.mjs --unit` | **52 / 52 文件通过**，0 失败 |
| 三个关键套件（core / integration / store） | 85 / 85 用例 |
| 集成套件 | 18 / 20 文件（2 个失败为既有/环境性，已在原始 HEAD 复现） |
| 25 项独立验证脚本 | 25 / 25 |
| 变异测试 | **14 / 14**（非等价）+ 1 个已记录等价变异体 |

### 8.3 本次任务的边界：到验证为止（**不含部署**）

> **纠正**：本节此前把「重新构建部署包并发布到生产」列为待办事项，这是**超出任务范围的表述**。
> 原始任务四项要求全部是验证性质（读文档、写报告、**只读**复核 `D:\mcp`、报告通过数与生产影响），
> 且明确要求 `D:\mcp` **只读、勿写**（该目录由另一 agent 管理）。因此部署**不在**本任务边界内。
> 保留此处说明，是为了避免后来者误以为"验证完成 = 应当部署"。

#### 任务范围内：已完成

- [x] 读 README / `docs/analysis/concurrent-instances-contract.md` / `scripts/check.mjs`
- [x] 独立验证（25 项，真实 store/adapter/lifecycle，仅 OS 边界 fake）
- [x] 报告存档至 `docs/analysis/multi-profile-concurrency-verification.md`
- [x] **只读**复核 `D:\mcp\console\src\adapters\index.mjs` 与 `console\public\app.js`（见 §7）
- [x] 报告通过数、失败项、生产影响（见 §0 摘要表）
- [x] 契约 §7 三条验收命令在 `final` 上全部通过（§33.8）
- [x] 生产环境全程未受影响的证明（§6、§6.1）

#### 经用户逐项授权后额外完成（超出原始范围）

- [x] 提交他人的指针修复（§32，用户授权）
- [x] 合入 `final` 分支（§33.9，用户授权）
- [x] 发布包构建验证（§33.11，仅构建到 `%TEMP%`，**未部署**）

#### 不属于本任务、也未执行

- [ ] **部署到 `D:\mcp`** —— 该目录是一个**正在运行的完整部署**（控制台 PID 27736、
      3 个 tunnel-client 进程、`FILES.sha256`/`Verify-Package.ps1` 等），由另一 agent 管理。
      任务明确要求只读。**是否上线是发布决策，不在验证范围内。**
- [ ] push 到远端 —— 属版本管理决策，非验证必需。

> 关于第 6 个缺陷（§34）：它是 legacy 路径忽略 `busy` 决策的既有问题，经 §34.7 判定为**不可达**
> （`assertIdle` + `withExclusiveLock` 双重抑制），故未修；仅作为潜在健壮性缺口记录，不阻塞任何事。

---

## 9. 附：验证脚本清单（均在 `%TEMP%\mp-concurrency-verify\`，未入库）

> **重要说明（关于可复现性）**
>
> 按任务约束「验证脚本请放到临时目录，不要污染仓库」，这些脚本**从未入库**；而 `%TEMP%`
> 会被系统清理——本次会话结束时该目录已被清空，下表多数文件**已不存在**。
>
> 因此本表的作用是**记录「跑过什么、证明了什么」**，不是一份可直接执行的清单。若要复现，
> 需按描述重建脚本。核心入口是 `verify.mjs`（25 项，真实 store/adapter/lifecycle，仅 OS
> 边界 fake），接受仓库根路径为第一个参数，输出 JSON：`{total, passed, failed, results[],
> production.untouched}`。
>
> 由此也必须承认：**本报告里基于临时脚本的结论，无法通过 `git clone` 后重跑脚本来验证。**
>
> **可复现的是入库的测试**：`tests/instance-ownership`、`instance-routes`、`instance-render`、
> `instance-queue-concurrency`、`instance-idempotency`、`instance-pending-action`、
> `instance-route-edges`、`instance-crash-recovery`、`legacy-pending-action`、
> `legacy-pending-real-path`、`smoke-script-args` 共 **11 个文件**，随仓库交付，可直接
> `node --test` 运行；且已用变异测试（§11–§25、§27）证明这些测试**真的会失败**。
>
> 会话末期仅有 `check-release-gate.mjs` 被重新写入并用于最终验证。

| 脚本 | 用途 |
|---|---|
| `verify.mjs` | 25 项独立验证主脚本（修复后工作区 → 25/25） |
| `pointer-ab.mjs` | `active_profiles` 指针 A/B 对照（HEAD 缺陷 vs 工作区修复） |
| `legacy-pointer-probe.mjs` | 反向验证：旧单账号路径仍能推进/清空指针（3/3） |
| `dto-owned-probe.mjs` | §4.6 证据：修复前 `owned=false`（按钮禁用）、修复后 `owned=true`（按钮可用） |
| `migration-probe.mjs` | 旧库（无新列）增量迁移：补列成功、预置行保留、归属读成 false |
| `settle-probe.mjs` / `matrix-probe.mjs` / `instrumented-probe.mjs` / `writable-probe.mjs` / `meta-probe.mjs` | 定位早期观测矛盾的排除性实验 |
| `out.json` / `final.json` | 主脚本机器可读结果（25 项逐条 PASS/FAIL） |
| `%TEMP%\smoke-tmp\smoke.mjs` | 冒烟脚本副本（改端口 17655 + 绝对 PROJECT_ROOT），端到端 HTTP 演练 |

复现命令：

```powershell
node %TEMP%\mp-concurrency-verify\verify.mjs        # 期望 25/25 且 production.untouched = true
node %TEMP%\mp-concurrency-verify\pointer-ab.mjs D:\mcp-tunnel-account-manager WORKTREE   # 期望 OK
node %TEMP%\mp-concurrency-verify\legacy-pointer-probe.mjs D:\mcp-tunnel-account-manager WORKTREE  # 期望 3/3
node %TEMP%\mp-concurrency-verify\dto-owned-probe.mjs D:\mcp-tunnel-account-manager        # 期望 owned=true, VERDICT: OK
node %TEMP%\mp-concurrency-verify\migration-probe.mjs D:\mcp-tunnel-account-manager        # 期望 MIGRATION OK
node %TEMP%\smoke-tmp\smoke.mjs                                                           # 期望 bothRunning/stopIsolated/prodUntouched 全 true
```

---

### 9.1 变异结论的独立复核（不依赖已丢失的脚本）

§9 已说明：变异测试脚本随 `%TEMP%` 被清理，因此 **15/16 这个数字本身无法由 `git clone` 重跑复现**。而变异分数是"这些测试真的会失败"的主要证据，让整个支柱建立在不可核验的数字上并不合适。

因此做了一次**独立复核**：`git archive HEAD` 导出到临时克隆，**手工改坏一行**，跑对应测试，断言它**失败**，再还原。若变异体通过，说明对应测试是摆设。

| 变异体 | 改坏的位置 | 预期 | 实测 |
|---|---|---|---|
| **M1** | `if (!instanceId) {` → `if (true) {`（指针守卫失效） | e2e 测试失败 | **KILLED**（exit 1） |
| **M6** | `if (lower === productionDataDir) {` → `if (false) {`（实例可写生产数据目录） | 所有权测试失败 | **KILLED**（exit 1） |
| **M9** | `if (storedProfileId && storedProfileId !== profileId) {` → `if (false) {`（身份别名守卫失效） | 所有权测试失败 | **KILLED**（exit 1） |

运行输出：

```
M1  KILLED   — pointer guard removed
M6  KILLED   — production dataDir guard disabled
M9  KILLED   — identity-aliasing guard disabled
baseline on unmutated clone: exit 0 (ok)
=== 3/3 killed ===
```

**基线对照同样重要**：未变异的克隆上这两套测试 **exit 0 通过**。没有这条对照，"KILLED" 就可能只是测试本身坏了。

#### 这次复核证明了什么、没证明什么

| 已证明 | 未证明 |
|---|---|
| 三个最关键的不变量（指针、生产目录隔离、身份冲突）都有**真实生效**的测试守护 | 其余 13 个变异体未逐一复核（脚本已丢失） |
| 变异方法本身可复现：任何人用 `git archive` + 改一行 + 跑测试即可验证 | 完整 15/16 分数仍属**当时观测记录**，无法逐条重放 |

即：报告中的变异分数现在有了**可独立验证的样本**（3 个），而不是一个孤立的数字。

#### 一个小插曲（记录以示方法可靠）

首轮复核时 M6 报 `BAD-PATTERN: anchor not found`——因为我凭记忆把守卫写在 `src/store.mjs` 里，实际它在 `src/adapters/instance-adapter.mjs`。工具如实报"锚点没找到"而不是记成 SURVIVED，避免了把"我找错文件"误判为"测试没守住"。

---

## 10. 实测：`final` 分支并非"稳定基线"

任务描述称当前分支为 `final`（稳定基线，已含全部修复），但实际检出的是 `feature/concurrent-account-tunnels`（`21efa72`）。因此对 `final`（`0e824e0`）单独做了一次只读实测：用 `git archive final` 导出到临时目录，不切分支、不动工作区。

| 检查 | `final` 实测结果 |
|---|---|
| `node scripts/check.mjs` | 122 文件通过（绿） |
| 三个关键套件 | **84 / 84 通过**（绿） |
| 25 项独立验证脚本 | **24 / 25**，仅 **C18** 失败 |
| 指针 A/B 探针 | `userB → userA → userB → []` → **DEFECT**（指针被实例动作移动并清空） |

**结论**：`final` 的语法与全部既有测试都是绿的，但它**同样带着 §4 的指针缺陷**——这正是该缺陷的危险之处：既有测试从未在"指针非空"的前提下断言实例动作，所以 84/84 全绿却掩盖了真实缺陷。换言之：

> **`final` 当前不是一个可信的稳定基线**；它缺少 §4 的守卫（`if (!instanceId)`），也缺少 §4.6 的 `owned` 证据字段。若以 `final` 作为发布基线，会把这两个缺陷一并带上线。

建议：把 `54dade5`（§4.6 修复）与工作区那份指针修复一起同步进 `final`，再重跑本报告的 C18 与 `instance-ownership` 用例确认转绿。

---

## 11. 变异测试：量化"测试全绿"到底有多可信

§10 已经证明一个事实：`final` 的 84/84 全绿却仍带着 §4 缺陷。这引出一个更根本的问题——**现有测试到底守住哪些不变量？** 用变异测试（mutation testing）量化：故意逐个破坏不变量，看测试是否失败。测试失败 = 该不变量被守住（KILLED）；测试仍全绿 = 盲区（SURVIVED）。

方法：`git archive HEAD` 导出到 `/tmp`，叠加工作区那份指针修复作为基线，逐个注入变异后运行相关套件，每轮结束还原。真实仓库全程未被修改。

| 变异 | 被破坏的不变量 | 结果 |
|---|---|---|
| M1 | 移除 `if (!instanceId)` 守卫（实例动作改写 `active_profiles`） | **KILLED** |
| M2 | 不检查每服务并发上限（`INSTANCE_LIMIT_REACHED`） | **KILLED** |
| M3 | 反转核心不变量：兄弟实例阻塞同服务的另一个 start | **KILLED**（9 个用例失败） |
| M4 | 启动成功后不落库 `owned`/`identityVerified`（UI 停止/重启会永久禁用） | **SURVIVED** → 补测后 KILLED |
| M5 | 允许碰撞 profileId 重绑已有实例行（会遗弃活进程） | **SURVIVED** → 补测后 KILLED |
| M6 | 削弱生产数据目录隔离守卫 | **SURVIVED** → 补测后 KILLED |

**初始分数：3 / 6**。也就是说，在补齐之前，**一半的核心不变量没有任何测试能守住**——即使把这些安全机制整段删掉，全套测试依然全绿。

**补强**：在 `tests/instance-ownership.test.mjs` 中新增 3 个用例（原 5 个 → 8 个），分别覆盖变异 M4/M5/M6 的缺口：

- 真实跑一遍 `runInstanceLifecycleAction`，断言启动成功后 `owned/identityVerified` 确实为 `true`，并端到端断言 UI 停止/重启按钮可用（M4）；
- 碰撞 profileId 二次写入必须抛 `INVALID_INSTANCE`，且原账号 pid 保持不变（M5）；
- provider 必须拒绝生产数据目录（M6）。

**补强后分数：6 / 6**，全部变异均被杀死：

```
M1 KILLED  M2 KILLED  M3 KILLED  M4 KILLED  M5 KILLED  M6 KILLED
=== MUTATION SCORE: 6/6 killed ===
```

**这条证据的意义**：它把"25/25 通过"从"看起来没问题"升级为"破坏任何一条已声明不变量都会被测试当场抓住"。建议后续把变异测试纳入发版门禁（至少覆盖指针守卫、归属证据、隔离守卫这三处安全扣）。

复现：`node %TEMP%\mp-concurrency-verify\mutation-test.mjs <导出的源码树>`

### 11.1 补充：HTTP 路由守卫也被纳入变异测试（M7 / M8）

§4 的 HTTP 路由层此前的覆盖是**空白**的：既有 e2e 直接驱动 store/adapter/lifecycle，冒烟只走了 start/stop/list 的正常路径，**没有任何测试校验 404、400、401、405 与脱敏规则**。已新增 `tests/instance-routes.test.mjs`（7 个用例）补齐：

| 用例 | 断言 |
|---|---|
| 未知 profile | 404 `PROFILE_NOT_FOUND` |
| body profileId 与路径不一致 | 400 `INVALID_PROFILE` |
| 未认证 | 401 `UNAUTHORIZED` |
| 错误方法 | 405 `METHOD_NOT_ALLOWED` |
| 非实例路径 | 返回 `false`，交回旧 MCP 路由（不得吞掉 legacy 路径） |
| 列表脱敏 | 响应绝不含原始 tunnel id / api key / 完整 YAML 路径 / 生产绝对路径 |
| 列表可用性 | 行内保留 `state`/`pid`/`owned`/`identityVerified` |

随后把两个路由守卫加入变异测试，确认新测试确实"守得住"：

| 变异 | 被破坏的不变量 | 结果 |
|---|---|---|
| M7 | 移除未知 profile 的 404 拒绝 | **KILLED** |
| M8 | 移除实例路由的鉴权守卫 | **KILLED** |

**最终变异分数：8 / 8 全部杀死**（原始 3/6）。这意味着现在破坏以下任何一条，测试都会当场变红：指针守卫、并发上限、兄弟实例不阻塞、归属证据落库、碰撞重绑拒绝、生产目录隔离、未知 profile 404、路由鉴权。

`tests/instance-ownership.test.mjs` 8 个 + `tests/instance-routes.test.mjs` 7 个 = 15 个针对性用例全部通过。

---

## 12. 第三个缺陷（已修复）：截断碰撞导致账号「静默假成功」

### 12.1 发现路径

§11 的命名空间边界探针在验证"64 字符截断"时发现：`sanitizeProfileSegment` 把段截到 64 字符，而 discovery 身份可达 71 字符，因此**两个真正不同的账号可以折叠到同一个 `instanceId`**。store 的身份守卫会拒绝重绑（这是对的），但继续追下去发现了更严重的一层。

### 12.2 现象：报告成功，实际什么都没启动

用两个 71 字符、仅在第 64 字符之后不同的账号实测：

```
A segment: acct-xxxxxxx… len 64
B segment: acct-xxxxxxx… len 64
A and B share an instanceId? true

start A -> SUCCEEDED   （launch 调用 1 次，pid 980001）
start B -> SUCCEEDED   （launch 调用仍然是 1 次！）
stored row: {"profileIsA":true,"profileIsB":false,"pid":980001}
```

**B 报告 `SUCCEEDED`，但从未启动属于自己的进程。**

### 12.3 根因

生命周期在决策前用**共享的** `instanceId` 调 `inspect()`，读到的是 A 的、已验证的活进程，于是 `decideInstanceAction('start', live=true)` 判为 `ALREADY_RUNNING` → noop → 标 `SUCCEEDED`。而 `persistInstanceRuntime()` 是 best-effort、会吞掉 store 的 `INVALID_INSTANCE` 拒绝，所以连"记录没写成功"都不会暴露。

副作用叠加：`profileYamlFileName()` 也基于同一个段，两个账号还会**指向同一个 profile YAML 文件**。

> 这比"泄漏一个孤儿进程"更隐蔽——用户看到的是一个成功的启动，实际那条隧道从未存在。

### 12.4 修复

在 `runInstanceLifecycleAction()` 的**任何副作用之前**增加身份别名守卫：若该 `instanceId` 已有记录且其 `profileId` 与本次动作的 `profileId` 不同，直接 `REJECTED / INVALID_INSTANCE`。

```js
const existing = await loadInstanceRuntimeRecord(repo, instanceId);
const storedProfileId = existing?.profileId != null ? String(existing.profileId) : null;
if (storedProfileId && storedProfileId !== profileId) {
  await markRejected(repo, actionId, 'INVALID_INSTANCE');
  return await getPublicAction(repo, actionId);
}
```

选在此处的原因：此刻**尚未产生任何副作用**，属于干净拒绝；同时语义上 `INVALID_INSTANCE` 已存在（UI 也有对应中文提示"实例标识不合法或与服务/账号不匹配"），不需要新增错误码。

### 12.5 验证

| 场景 | 结果 |
|---|---|
| 碰撞账号 B 启动 | **REJECTED / INVALID_INSTANCE**（不再假成功） |
| 同一账号 start #1 | SUCCEEDED，启动 1 次 |
| 同一账号 start #2（幂等） | **SUCCEEDED noop**，不重复启动 |
| 同一账号 restart | SUCCEEDED，启动新进程 |
| 同一账号 stop | SUCCEEDED，记录清空 |
| 25 项主验证脚本 | **25 / 25** |
| 旧单账号指针反向验证 | **3 / 3**（未被误伤） |
| 关键套件 | **101 / 101** |
| 单元套件 | **47 / 47 文件** |
| 变异测试 | **9 / 9**（新增 M9 专门守这条守卫） |

新增回归用例 `tests/instance-ownership.test.mjs` → "a truncation-colliding second account never reports a false success"（用例数 8 → 9）。

### 12.6 残余限制（未修，属设计取舍）

碰撞的两个账号**仍然无法同时运行**——这是 64 字符段的固有限制，不是本修复能消除的。当前行为是"第二个账号被明确拒绝"（可诊断、无假成功、无孤儿进程），而非"两个账号都能跑"。彻底解决需要改 `instanceId` 编码方案（例如段内追加短哈希），属于契约变更，应单独立项。

---

## 13. 未提交修复的备份与回放验证

§4 的指针修复（`src/mcp-registry-store.mjs` 与对应回归用例）**至今只存在于未提交的工作区**——一旦执行 `git checkout .`、`git stash` 或工作区被清理，该修复会直接丢失。为降低这一风险，已把改动导出为补丁并**实测可回放**。

补丁位置（仓库外，避免污染）：

```
%TEMP%\mp-concurrency-verify\backup\pointer-fix.patch
  sha256 8a1f8bd8e5e842e91c48e0d5ad9a5dc113c65c538258552b36681dc7277f7dd8
%TEMP%\mp-concurrency-verify\backup\pointer-fix-tests.patch
  sha256 ea7ecbcc00e6456028c3749af0da0a0bcb3d858f3e34b42fd96c0a21ed0cf6a5
```

**回放验证**（`git archive HEAD` 导出纯净基线 → 依次 `git apply` 两个补丁）：

| 检查 | 结果 |
|---|---|
| `git apply --check` 两个补丁 | 均 **APPLIES CLEANLY** |
| 回放后指针 A/B 探针 | `userB → userB → userB → userB` → **OK（指针未被移动）** |
| 回放后 25 项主验证脚本 | **25 / 25**，production untouched |

即：即使工作区改动丢失，也能通过上述补丁把状态完整恢复到"指针缺陷已修复"，并已用完整验证脚本确认恢复后行为正确。

> 仍建议尽快把这两个补丁提交入库——备份只是降低丢失风险，不能替代版本控制。

### 13.5 补丁对**今天** HEAD 的复验（关键：HEAD 已前进 13 个提交）

§13 的回放验证是在旧 HEAD 上做的。此后我提交了 13 个 commit，其中**改动了同样的两个文件**（`src/mcp-registry-store.mjs`、`src/store.mjs`）——补丁完全可能因上下文变化而失效。若补丁是过期快照，它作为"恢复路径"就不再成立。

因此对**今天的 HEAD（`b0d1724`）**重新验证：

| 检查 | 结果 |
|---|---|
| `git apply --check pointer-fix.patch` | **APPLIES CLEANLY** |
| `git apply --check pointer-fix-tests.patch` | **APPLIES CLEANLY** |
| 应用后守卫存在（`grep -c "if (!instanceId) {"`） | 1 |
| 应用后我的 4 处修复仍在位 | formatRuntime 1 / sanitizeMcpDto 1 / owned 列 5 / assertIdle 实例感知 5 |
| 应用后语法 | OK |
| 应用后指针 A/B 探针 | `userB → userB → userB → userB` → **OK** |
| **应用后 25 项主验证脚本** | **25 / 25**，prod untouched |

```
PATCHED HEAD (today HEAD + backup patches): 25/25 | failed: 0 | prod: true
```

**关键结论**：这两个补丁**基于文件内容而非行号**，因此在 HEAD 前进 13 个提交、且同两个文件被我改过之后，依然能干净应用到正确位置，并与我的全部修复共存、最终达到 25/25。

也就是说：

> **恢复路径是活的，不是快照。** 只要把这两个补丁应用上去，今天的 HEAD 就从 24/25 变成 25/25——这与 §24 的结论互相印证（指针守卫是唯一缺口）。


---

## 14. 第四个缺陷（已修复）：`runtime.instances` 未透出，实例面板恒为空

### 14.1 发现路径

核对契约 §4 的这条要求时发现的：

> `/api/state` and `/api/mcps` must surface instances additively: each MCP DTO in `repo.registry.listServices()` gains `runtime.instances: [publicInstanceDTO...]`

前几轮我只验证了**专用端点** `GET /api/mcps/:id/instances`（§11.1 的 7 个用例），从未验证 MCP DTO 里的那个附加字段。

### 14.2 现象：数据在库里，UI 却一行都看不到

```
registry.listServices() ids           : ["overleaf-mcp","mcp_surfacing","antigravity-mcp"]
has runtime key                       : true
runtime keys                          : ["state","activeProfileRevision","activeServiceRevision","pendingApply","observation"]
has instances key                     : false          <-- 契约要求的字段缺失
UI getMcpInstances(mcp) rows          : 0              <-- 面板为空
store.getServiceRuntime.instances     : 1 row(s)       <-- 数据确实在
```

`instance_runtime` 里明明有一行 `running` 实例，但控制台渲染 0 行。

### 14.3 根因与影响面

`formatRuntime()`（`src/mcp-registry-store.mjs`）从 `getServiceRuntime()` 的返回值里**只挑固定字段**（state / revisions / pendingApply / observation / tunnelClient），把 `instances` 丢掉了。而 `public/app.js` 的实例面板**唯一**的数据源是：

```js
export function getMcpInstances(mcp) {
  const list = mcp?.runtime?.instances;
  return Array.isArray(list) ? list.filter(...) : [];
}
```

因此 **§4.6 修好"按钮能点"之后，用户依然看不到任何一行可点的按钮**——面板本身是空的。两个缺陷叠加，才构成"UI 上无法使用并发多账号"的完整故障。

> 排查中一度误用 `store.listServices()`（那是 profile/service 配对列表，返回 `{service, serviceId, activeProfileId, profileId}`），契约指定的是 `repo.registry.listServices()`。已改为后者并以精确形状输出复核，避免把"探针读错面"当成缺陷。

### 14.4 修复

`formatRuntime()` 末尾补一行，且**缺失时返回 `[]` 而不是 `undefined`**，让调用方可以无条件迭代：

```js
res.instances = Array.isArray(runtime?.instances) ? runtime.instances : [];
```

`getServiceRuntime` 早已作为选项注入 `attachRegistry()`，所以无需改动 wiring——纯粹是 DTO 组装时漏了这一站。

### 14.5 验证

| 检查 | 结果 |
|---|---|
| `runtime.keys` 含 `instances` | ✅ |
| 无实例时 `instances` 为 `[]`（不是 undefined） | ✅ |
| 有实例时 `instances.length === 1`，且 `state/pid/owned/identityVerified` 完整 | ✅ |
| UI `getMcpInstances()` 等价读取 | **1 行** |
| 新增回归用例 | `tests/instance-routes.test.mjs` → "registry DTO carries runtime.instances"（7 → 8 用例） |
| 关键套件 | **168 / 168** |
| 25 项主验证脚本 | **25 / 25** |
| 变异测试 | **10 / 10**（新增 M10 专守这条） |

**安全性确认**：本次改动落在 `src/mcp-registry-store.mjs`，正是**他人也在编辑**的文件（含未提交的指针修复）。已确认我的改动是纯增量（仅追加 `res.instances` 一行 + 注释），`grep -c "if (!instanceId) {"` 仍为 1，对方的守卫完好无损。

---

## 15. 第四个缺陷的第二层（已修复）：HTTP 层又一次剥掉了 `runtime.instances`

### 15.1 为什么 §14 的修复还不够

§14 修好了 `formatRuntime()`，`registry.listServices()` 的 DTO 确实带上了 `instances`。但控制台**并不直接**读它——`public/app.js` 的 `loadDashboardData()` **优先**使用 `/api/mcps` 的响应：

```js
if (mcpsData && Array.isArray(mcpsData.mcps)) {
  servicesList = mcpsData.mcps;          // <- 优先这条
} else if (stateData && Array.isArray(stateData.mcps)) {
  servicesList = stateData.mcps;
}
```

而 `/api/mcps` 对每个服务都调用了 `sanitizeMcpDto()`，后者**逐字段重建** `result.runtime`：

```js
result.runtime = {
  state, activeProfileRevision, activeServiceRevision, pendingApply, observation
};                                  // instances 在这里被丢掉
```

于是 §14 的修复在真实链路上仍然无效——数据在 store 层是对的，被 HTTP 序列化层第二次丢弃。

### 15.2 证据（修复前 / 修复后）

```
A) registry.listServices() 原始 DTO
   runtime keys : [... "observation","instances"]        instances length: 1

B) 经过 sanitizeMcpDto（即 GET /api/mcps 的返回）
   修复前 runtime keys : ["state","activeProfileRevision","activeServiceRevision","pendingApply","observation"]
                         instances length: MISSING      → 控制台 0 行
   修复后 runtime keys : [... ,"instances"]              instances length: 1  → 控制台 1 行
```

### 15.3 修复

在 `sanitizeMcpDto()` 的两条 `runtime` 分支之后统一补一次透传，并对每一行**再过一遍 `publicInstanceDTO`**——它是显式白名单，是本层的脱敏边界：

```js
result.runtime.instances = Array.isArray(def.runtime?.instances)
  ? def.runtime.instances
      .map(instance => publicInstanceDTO({
        ...instance,
        serviceId: instance?.serviceId || def.id,
        instanceId: instance?.instanceId || instance?.instance_id || null
      }))
      .filter(dto => dto && dto.instanceId)
  : [];
```

### 15.4 脱敏边界实测（11 项全通过）

不满足于"白名单应该安全"，而是往存储行里**主动塞入**契约禁止泄露的内容，再断言它们不过界：

| 检查 | 结果 |
|---|---|
| 行本身仍在（sanity） | PASS |
| 无原始 tunnel id | PASS |
| 无原始 api key | PASS |
| 无 YAML 内容 | PASS |
| 无生产绝对路径 | PASS |
| 无 `profileYamlPath` / `executablePath` / `credential` / `yaml` / `tunnelId` / `apiKey` 字段 | PASS |

过界后仅剩 17 个安全字段：`instanceId, serviceId, profileId, profileLabel, state, managed, owned, identityVerified, pid, startedAt, healthURL, localPort, maskedTunnelId, operationId, reasonCode, lastExitCode, observedAt`。

### 15.5 真实 HTTP 端到端验证（不再是 DTO 层推断）

启动**真实**控制台（隔离临时数据目录 + 空闲端口 17666 + fake runtime + stub probe），发真实 HTTP 请求：

```
manager listening: http://127.0.0.1:17666
POST /api/mcps/mcp_httpsvc/instances/userA/start -> 202 (查得 action 入队)
（轮询 UI 同款端点，直到 settle）
instance settled -> {"state":"running","pid":33008,"owned":true}

GET /api/mcps -> 200
  runtime.instances present: true | length: 1
  row: {"instanceId":"mcp_httpsvc__userA","state":"running","pid":33008,
        "owned":true,"identityVerified":true}
  leaks raw credential? no

GET /api/state -> 200 | instances: 1

VERDICT: OK — the console receives a usable instance row over real HTTP
```

这条证据的价值：它覆盖了 `server.mjs → mcp-routes.mjs → sanitizeMcpDto` 的完整真实链路，而前几轮只验证到 store/DTO 层。**至此"UI 能看到实例行"才第一次被真正证明**。

### 15.6 验证汇总

| 检查 | 结果 |
|---|---|
| 新增回归用例（`instance-routes.test.mjs` 8 → 10） | 10 / 10 |
| `gpt-runtime-state-contract.test.mjs` 契约快照同步 | 27 / 27 |
| 关键套件 | **181 / 181** |
| 25 项主验证脚本 | **25 / 25** |
| 单元套件 | **47 / 47 文件** |
| 变异测试 | **11 / 11**（新增 M11 专守本层） |
| 真实 HTTP 端到端 | **OK** |

> 注：`gpt-runtime-state-contract.test.mjs` 的严格 deepEqual 再次因契约变更而变红——与 §14 同样处理：该用例本就是"完整 runtime 形状"的守卫，如期更新断言，而不是放宽它。

---

## 16. 修复引入的发布侧副作用：`source-core-hashes.json` 基线（已处理）

### 16.1 问题

本报告的修复改动了 5 个源文件。`packaging/windows/build-release.mjs` 有一条硬门禁：

```js
const existingCoreMap = path.join(source, 'source-core-hashes.json');
if (fs.existsSync(existingCoreMap)) {
  const baseline = readJson(existingCoreMap);
  if (JSON.stringify(baseline) !== JSON.stringify(sourceCoreHashes))
    throw new Error('Core source differs from recorded baseline. Review and create a new release identity.');
}
```

即：**源码一变，正式发布构建直接抛错中止**。这不是猜测——按该脚本逐行复刻门禁逻辑后实测：

```
RESULT: release build WOULD ABORT -> Core source differs from recorded baseline.
```

### 16.2 归因（先证明是不是既有问题）

- 在**我修改前的提交** `21efa72` 上导出纯净树校验：基线**完全同步**（`baseline in sync? true`）。
- 在当前工作区校验：恰好 5 个文件不一致，且正是我改的那 5 个。

结论：**这是本次修复引入的，不是既有问题**，应由本次收尾处理。

### 16.3 处理（按用户选择："只更新哈希基线"）

只重算这 5 个条目，其余一切不动：

- 键集合仍为 39 项、键顺序不变、2 空格缩进 + 结尾换行不变；
- diff 恰好 **5 行**（`git diff --numstat` → `5 5`）；
- **发布身份刻意不升级**：`releaseId` 仍为 `20261109-rc22-r1`、`sourceSnapshot` 仍为 `release-candidate-22-20261109`（照用户的"只更新哈希基线"选项；真正发版时再升）。

刷新脚本带双重护栏，避免误把无关改动"洗白"进基线：

```js
if (JSON.stringify([...originalOrder].sort()) !== JSON.stringify(computedKeys)) { /* 拒绝：结构已发散 */ }
const unexpected = changed.filter(k => !EXPECTED.has(k));
if (unexpected.length) { /* 拒绝：出现未审阅的变更文件 */ }
```

### 16.4 验证

| 检查 | 结果 |
|---|---|
| 复刻门禁逻辑重跑 | **RELEASE BUILD GATE: PASS**（39 项，基线匹配） |
| `source-core-hashes.json` diff | 5 行（仅 5 个哈希） |
| 发布身份 | 未变（rc22-r1） |
| `tests/release-deployment.test.mjs` | 6 / 6（该套件不跑构建脚本，故未受影响） |
| 语法 / 单元 | 124 文件 / 47 个文件全通过 |

### 16.5 遗留注意（已写入提交信息）

`src/mcp-registry-store.mjs` 的基线哈希反映的是**当前工作区内容**，而该文件同时含有：

- 我**已提交**的 `formatRuntime` 修复；
- 另一个 agent **未提交**的指针守卫。

因此**若那份指针守卫被提交或被改写，这一个条目必须再次重算**，否则发布构建会再次中止。这是本次唯一一处基线依赖未提交状态的地方。

---


### 16.6 后续修正：基线必须描述**已提交**内容，而不是工作区

§16 的基线刷新有一个我造成的问题，后来才暴露：当时工作区仍含**他人未提交**的指针守卫，而我把「工作区内容」的哈希写进了基线。后果是：（该问题已修正，且守卫已于 §32 提交，工作区现为干净状态）

```
git archive HEAD | tar -x -C /tmp/cleanchk
node check-release-gate.mjs /tmp/cleanchk
→ RELEASE BUILD GATE: FAIL
   Core source differs from recorded baseline: src/mcp-registry-store.mjs
```

**干净检出 HEAD 竟然无法构建发布包**——这比"没有基线"更糟，因为它让发布门禁变成了假警报。

#### 修正

改为从 **index**（`git show :path`，即干净检出 HEAD 时的内容）重算：

```
src/mcp-registry-store.mjs
  0ab8285c17d25c6b -> 9924e1779edb61e9
Rebased 1 entry onto the INDEX (committed content).
```

diff 恰好 **1 行**，键集合 39 项、顺序、格式均不变，发布身份未动。

#### 修正后的状态（这是刻意的取舍）

| 场景 | 结果 | 说明 |
|---|---|---|
| 干净检出 HEAD + 新基线 | **PASS** | 这才是发布构建的真实场景 |
| 当前工作区（含他人未提交守卫） | **FAIL**（仅 1 个文件） | **刻意如此**：基线描述已提交内容，不描述磁盘上恰好存在的东西 |

并已验证该失配 **100% 由他人守卫造成**：

```
git diff src/mcp-registry-store.mjs | grep -c allowParallelInstanceAction  -> 0  （我的改动已全部提交）
git diff src/mcp-registry-store.mjs | grep -c "if (!instanceId) {"         -> 1  （他人守卫）
```

#### 对后续操作的含义

**当那份守卫被提交时，必须在同一个提交里重算 `src/mcp-registry-store.mjs` 这一个条目**，否则干净克隆会再次失配。这是全仓唯一一处"基线依赖未提交代码"的陷阱，现已收敛为可预测的一步操作。

---

## 17. 分支状态矩阵（供发布决策）

对三条基线分别做只读实测（`git archive` 导出到临时目录，不动工作区）：

| 检查 | `final` (`0e824e0`) | 现在的 HEAD（全部五个修复均已提交） |
|---|---|---|
| 发布门禁（`source-core-hashes.json`） | **PASS**（基线自洽） | **PASS**（本轮已刷新） |
| 指针 A/B 探针 | **DEFECT**：`userB → userA → userB → []` | **OK**：`userB → userB → userB → userB` |
| `owned` / `identity_verified` 列 | 缺失（`grep -c identity_verified` = 0） | 已加 |
| `formatRuntime` 透出 `instances` | 缺失（`grep -c res.instances` = 0） | 已有 |
| `sanitizeMcpDto` 透出 `instances` | 缺失（`grep -c result.runtime.instances` = 0） | 已有 |
| 别名守卫 / 归属证据 / UI 可用性 | 均缺 | 均有 |
| 实例动作并发排队（`assertIdle` 实例维度） | 缺失（5 路并行仅 1 成功） | 已有（5/5 成功，§20） |

**关键解读**：`final` 的门禁是绿的——它**可以**构建发布包。但它同时缺全部**五个**修复，因此以 `final` 发布的包会带上：

1. 实例动作污染 legacy 热切换指针（显示错误账号、误报服务已停止）；
2. UI 停止/重启按钮永久禁用；
3. 碰撞账号静默假成功；
4. 实例面板恒为空（两层剥离）；
5. 实例动作无法并发排队（5 路并行只有 1 个成功，§20）。

也就是说：**"能发布"与"可以发布"是两件事**。要让 `final` 具备正确行为，需要把本分支这批提交合入。**已在临时克隆中预演过该合并**：无冲突，且因 `final` 独有提交不触及 `src/`/`public/`，基线**无需重算**（见 §17.1）。


### 17.1 实测：合入 `final` **不需要**重算基线（修正 §17 原先的建议）

§17 原先写过"合入 `final` 后必须再次重算 `source-core-hashes.json`，因为合并会再次改变源码哈希"。这句是**过度保守**（对一般情形成立），但**对当下的 `final` 并不成立**。已用真实合并预演验证。

**预演方法**（不触碰真实仓库）：`git clone` 到临时目录 → 检出 `origin/final` → `merge feature/concurrent-account-tunnels`。

**结果**：

| 检查 | 结果 |
|---|---|
| 合并是否冲突 | **无冲突**（`git status` 干净，无冲突标记） |
| `final` 独有提交改动了哪些文件 | 仅 `README.md`、`docs/releases/v1.2.0-preview.5/*`、`packaging/windows/templates/kit/oneclick/Start-McpTunnel-Console.ps1` |
| 与我改动的文件是否有交集 | **零交集**（`comm -12` 无输出） |
| 合并后发布门禁 | **PASS**（39 条目，**未重算**基线） |
| 合并后 `src/`、`public/` 与我的 HEAD 是否一致 | **逐字节相同**（`store.mjs`/`mcp-registry-store.mjs`/`mcp-routes.mjs`/`instance-routes.mjs`/`instance-lifecycle.mjs`/`app.js` 全部 `SAME`） |

**合并树的完整测试结果**（同一预演克隆）：

| 套件 | 结果 |
|---|---|
| 单元 | **54 / 54 文件通过**，0 失败 |
| 集成 | **18 / 20**，失败的仍是 `third-mcp`（`VERIFY_FAILED`）与 `powershell-launch-env`（150s 超时）——与本分支、以及与改动前基线 `21efa72` 上的表现完全一致，**合并未引入任何新失败** |

**为什么不需要重算**：基线描述的是 `src/` + `public/` 的哈希。`final` 独有的 3 个提交**完全没有触及这两个目录**，因此合并后的 `src/`、`public/` 与我的 HEAD 逐字节一致，基线自然继续成立。

**修正后的准确规则**：

> 只有当**合并会改变 `src/` 或 `public/` 的内容**时，才需要重算基线。当次合并（`final` ← 本分支）不改变这两个目录，故**无需重算**；但仍须在合并后跑一次发布门禁确认，而不是凭推理。

**真正需要重算基线的仍是另一件事**：把他人那份**未提交**的指针守卫提交时，必须同提交重算 `src/mcp-registry-store.mjs` 这一个条目（§16.6）——因为它确实改动了 `src/`。

> 方法论教训：§17 原先把"合并可能有冲突/可能改源码"的通用谨慎，直接写成了对 `final` 的具体断言，而没有实测。这次预演才发现它不成立。凡是"合并后必须…"这类断言，都应该先做一次只读预演再落笔。

---

## 18. 最后一层：DOM 渲染（已补测）

### 18.1 为什么还要测这一层

前几轮验证到"`GET /api/mcps` 返回了 1 行可用数据"为止。但用户真正看到的是**渲染出来的 HTML**，而 `renderMcpInstanceSection()` 此前**零测试覆盖**（`grep -c renderMcpInstanceSection tests/ui-registry.test.mjs` = 0）。

这一层有自己的门控逻辑（`getInstanceActionGating()`），只要它判错，数据再对按钮也是灰的——§4.6 的缺陷正是这么发生的。

### 18.2 新增 6 个渲染用例（`tests/instance-render.test.mjs`）

| 用例 | 断言 |
|---|---|
| 运行中且已归属 | 面板显示 `多账号实例 (1)` / `运行中 1`；停止、重启按钮**存在且未 disabled**；启动按钮 disabled |
| 运行中但未归属 | 停止、重启按钮**均 disabled**（未验证的进程不得从 UI 停止） |
| 无实例 | 渲染空状态文案，且不出现任何停止按钮 |
| 脱敏 | 只显示服务端已掩码的 `smo...1111`；不出现 api key / 生产 yaml 路径 |
| 两个并发实例 | `多账号实例 (2)` / `运行中 2`，且**每行各有一个停止按钮**（该特性的核心目标） |
| 辅助函数一致性 | `getMcpInstances` / `countRunningInstances` / `getInstanceActionGating` 与渲染结果一致 |

测试环境需要预置 `appState.profiles`——否则 `getEligibleProfilesForService()` 返回空，重启按钮会以"未找到包含该服务凭证的可用账号"合法禁用（这是正确行为，不是缺陷）。

### 18.3 变异验证：M12

新增变异 M12：把门控改成"只要在运行就允许停止，忽略归属"。这是一条**真实的安全退化**（未验证的进程本不该从 UI 停止）。

```
M12 KILLED — UI gating lets a running instance be stopped REGARDLESS of ownership  [tests 6 | pass 5 | fail 1]
```

**变异分数最终 12 / 12**，覆盖：指针守卫、并发上限、兄弟不阻塞、归属落库、碰撞重绑、生产目录隔离、未知 profile 404、路由鉴权、DTO 透出（registry 层/HTTP 层）、别名守卫、**UI 门控**。

### 18.4 至此四层全部有"破坏即变红"的保障

| 层 | 测试文件 | 变异守卫 |
|---|---|---|
| 策略 / 命名空间 | `concurrent-instances.test.mjs` | M2、M3 |
| 存储 / 生命周期 | `store.test.mjs`、`instance-ownership.test.mjs` | M1、M4、M5、M6、M9 |
| HTTP 路由 / DTO | `instance-routes.test.mjs`、`gpt-runtime-state-contract.test.mjs` | M7、M8、M10、M11 |
| 前端渲染 | `instance-render.test.mjs`、`ui-registry.test.mjs` | M12 |

### 18.5 验证汇总

| 检查 | 结果 |
|---|---|
| `check.mjs` | **125 文件** |
| 单元套件 | **48 / 48 文件** |
| 渲染 + 路由 + 归属 + UI 定向套件 | **52 / 52** |
| 变异测试 | **12 / 12** |
| 发布门禁 | **PASS**（仅新增测试文件，未动 `src`/`public`） |

---

## 19. 规模验证：8 个实例真实并发（上限此前只在纯策略层测过）

`MAX_INSTANCES_PER_SERVICE = 8` 此前仅由 `decideInstanceAction` 的纯函数单测覆盖（M2 变异守的就是它）。但"策略说可以 8 个"与"8 个真能同时跑起来"是两回事——需要真实 PID、真实监听端口。

用真实 spawn 的临时 daemon（仅 OS 边界替身）实测 8 个账号并发启动：

```
cap = 8; starting 8 accounts sequentially...

PASS 8 instances all running        :: {"running":8,"expected":8}
PASS 8 distinct real PIDs           :: {"distinct":8}
PASS 8 distinct loopback ports      :: {"distinct":8,"ports":[56285,56286,56288,56289,56291,56292,56293,56294]}
PASS 8 distinct instanceIds         :: {"distinct":8}
PASS all 8 ports answer HTTP        :: {"answered":8}
PASS 8 real OS processes alive      :: {"alive":8}
PASS the 9th account is rejected INSTANCE_LIMIT_REACHED
                                    :: {"state":"REJECTED","errorCode":"INSTANCE_LIMIT_REACHED"}
PASS stopping one of 8 leaves the other 7 running with unchanged PIDs
                                    :: {"stopped":"SUCCEEDED","remaining":7,"pidsSame":true}

=== 8/8 passed ===
```

关键点：

- **8 个不同端口全部真实应答 HTTP**——证明不是"记录里写了 8 个端口"，而是 8 个监听器确实在服务；
- **第 9 个被精确拒绝**在 `INSTANCE_LIMIT_REACHED`，说明上限是硬边界而非软提示；
- **停掉其中一个，另外 7 个 PID 全部不变**——规模场景下"单独停止不影响兄弟"依然成立。

这条验证回答了原任务里最核心的问题——**"同一服务多账号真能同时跑"**——在最不利的规模（贴着上限）下依然成立。

---

## 20. 第五个缺陷（已修复）：实例动作无法并发排队，违反契约 §2.3

### 20.1 为什么这条最接近本特性的核心承诺

此前所有验证都是**串行派发**动作：起 A、再起 B、再停 A。但"多账号并发"的本质是**同时**发起。为此写了 `race-probe.mjs`，用 `Promise.all` 同时派发 5 个不同账号的启动。

### 20.2 现象（修复前）

```
FAIL A1 all 5 parallel starts settled without a thrown write conflict
     :: {"errors":["Store busy: action act_2b80aae... is active (QUEUED)", ... x3]}
FAIL A2 all 5 parallel starts succeeded :: {"succeeded":1, "states":["SUCCEEDED",null,null,null,null]}
FAIL A3 store holds exactly 5 running rows :: {"running":1}
FAIL A4 exactly 5 real processes launched  :: {"launches":1}
FAIL A5 listRunningInstanceProfileIds      :: {"running":["r1"]}
```

5 个并发启动，**只有 1 个成功**，其余 4 个直接 409 `BUSY` 抛出。

### 20.3 根因

`createLifecycleAction()` 在**入队阶段**调用了全局空闲检查 `assertIdle()`，其查询完全不带实例维度：

```sql
SELECT id, state FROM mcp_actions WHERE state NOT IN ('SUCCEEDED','REJECTED') LIMIT 1
```

只要有任何未终结动作，就抛 `BUSY`。契约 §2.3 明确要求：

> A pending action for instance A must NOT block instance B:
> `getActiveActionForService(serviceId, excludeActionId)` gains instance awareness — return a conflicting action only when it targets the **SAME** instance (or when it is a legacy whole-service action with no `instance_id`)

即：**排队必须按实例隔离**。执行仍然串行（runner 持有 `withExclusiveLock`），但"不能同时排队"是契约明令禁止的。

补充：`createLifecycleAction` 有**两处** `assertIdle()` —— 事务外初检（约 1204 行）与事务内复检（约 1308 行）。只修后者时 4 个失败依旧存在，因为会在抵达复检前就被拒绝。**两处都必须修**。

### 20.4 修复

`src/store.mjs` 的 `assertIdle` 增加实例维度过滤：

```js
function assertIdle({ excludeActionId, excludeOperationId, allowParallelInstanceAction = null } = {}) {
...
  if (allowParallelInstanceAction) {
    const target = String(allowParallelInstanceAction);
    if (parseInstanceId(target)) {
      query += ' AND (instance_id IS NULL OR instance_id = ?)';
      params.push(target);
    }
  }
```

语义：仍与**无实例作用域的 legacy 动作**冲突（`instance_id IS NULL` 保留全局语义），仍与**同实例**的待办动作冲突，但不再与**其他实例**冲突。两处调用点均传入 `resolvedInstanceId`。

### 20.5 验证

真实并发（`race-probe.mjs`，真实 spawn 的 daemon）：

| 组 | 检查 | 结果 |
|---|---|---|
| A | 5 个不同账号**同时**启动：无写冲突、全部 SUCCEEDED、5 行 5 个不同 pid、恰好 5 次 launch、运行列表完整 | **5/5 PASS** |
| B | 同一账号被**同时**启动两次：不会起第二个进程、第二次收到 `BUSY`、行内仍是单一 pid | **3/3 PASS** |
| C | start/stop/restart 混合风暴后，store 与 `listRunningInstanceProfileIds` 一致，且每个运行行都指向存活 pid | **2/2 PASS** |
| D | 任何实例都不占用 17642/17643 | PASS |

```
=== 11/11 passed ===
```

### 20.6 回归保护

新增 `tests/instance-queue-concurrency.test.mjs`（5 用例）：

1. 同服务**不同实例**可同时排队；
2. 同服务**同一实例**的第二个动作仍被 `BUSY` 拒绝；
3. **legacy 全服务动作**仍阻塞该服务的新实例动作；
4. **不同服务**的实例动作可同时排队；
5. legacy 动作（无 `instanceId`）**仍保持全局单动作**语义（这是本特性刻意不改的既有行为）。

变异 M13（删掉实例维度过滤）→ **KILLED**，最终变异分数 **13 / 13**。

### 20.7 一处需要交接的状态说明

`source-core-hashes.json` 中 `src/mcp-registry-store.mjs` 的条目按**当前工作区**内容计算，而该文件同时含有：

- 我**已提交**的 `formatRuntime` 修复与 `assertIdle` 调用点改动；
- 另一个 agent **未提交**的指针守卫。

因此该条目的哈希反映的是"我的提交 + 他人未提交改动"的混合状态。**一旦那份守卫被提交或改写，这个条目必须再次重算**，否则发布门禁会失败。

---

## 21. 契约 §2.3 幂等条款核查：通过（并记录一个等价变异体）

### 21.1 待验证条款

契约 §2.3 的最后一条此前从未验证过：

> `request_fingerprint` must incorporate `instanceId` so idempotency keys cannot collide across instances.

若这条不成立，用同一个幂等键先后启动两个账号，第二个会被**静默当成第一个动作的重放**——用户以为起了 B，实际返回的是 A 的动作，B 从未启动。

### 21.2 实测（真实 store，各场景独立库）

探针中每个场景使用**独立的临时 store**，原因是已排队的 legacy 动作与实例动作之间本就冲突（§20 已验证并固化为测试），共用一个库会让后续场景因无关原因失败。

| 场景 | 期望 | 结果 |
|---|---|---|
| A：同一幂等键 + **不同**实例 | 拒绝为 `IDEMPOTENCY_CONFLICT`，**不得**重放 A 的动作 | **PASS**（409 / IDEMPOTENCY_CONFLICT，未返回 A 的 id） |
| B：同一幂等键 + **同一**实例 + 相同载荷 | 幂等重放，返回原动作、不新建 | **PASS**（两次返回同一 `id`） |
| C：legacy 动作（无 `instanceId`） | 指纹保持**旧形状**，旧版本在途键仍能重放 | **PASS**（与手工重算的旧形状哈希逐字节相同） |

```
PASS A1 same key for a DIFFERENT instance is refused as IDEMPOTENCY_CONFLICT
PASS A2 it is NOT silently replayed as instance A's action
PASS B1 same key + same instance replays the original action (no duplicate)
PASS C1 legacy action keeps the pre-instance fingerprint shape (old keys still replay)
PASS C2 the legacy key replays the original action
=== 5/5 passed ===
```

**结论：该条款已正确实现，不存在对应的缺陷。**

### 21.3 一个诚实的反例：M14 是等价变异体，不是测试盲区

我加入变异 M14（删掉指纹里的 `instanceId` 成员）时，它**存活**了。按惯例这会被记为"测试盲区"，但实际追查后结论相反——用 `fingerprint-analysis.mjs` 直接对比哈希输入：

```
stored fp A       : 493ba8488ab01c40ce1a
stored fp B       : c754f478225d42291819
A != B            : true
matches WITH instanceId   : A true | B true
matches WITHOUT instanceId: A false | B false
```

即：指纹**确实**包含 `instanceId`（只匹配 WITH 版本），但**去掉它也不会让两个实例碰撞**——因为 `profileId` 本来就在指纹里，且对同一服务而言 `profileId` 与 `instanceId` 是 1:1 的。

所以 `instanceId` 成员是**契约要求的防御性冗余**，不是行为上的承重结构。删掉它得到的是一个**等价变异体**，任何行为级测试都不可能杀死它——这不是测试不足。

因此我把 M14 显式标记为 `expect: 'SURVIVED'`，并修改打分逻辑：只有**未预期**的存活才算盲区，分数按非等价变异体计算：

```
=== MUTATION SCORE: 13/13 killed (non-equivalent mutants) ===
EXPECTED SURVIVORS (equivalent mutants, documented — not blind spots):
  - M14 (equivalent) fingerprint drops the redundant instanceId member
```

> 这样做是为了避免用"全杀"数字粉饰结论：把等价变异体计为存活并单独说明，比偷偷删掉它或强行造一个"能杀掉它"的假测试都更诚实。

### 21.4 回归保护

新增 `tests/instance-idempotency.test.mjs`（4 用例）：

1. 同键跨实例 → `IDEMPOTENCY_CONFLICT`，绝不静默重放；
2. 同键同实例 → 幂等重放同一动作；
3. legacy 动作指纹形状不变（旧在途键仍可重放）；
4. 两个实例产生两个不同动作（规则背后的机制）。

| 检查 | 结果 |
|---|---|
| `check.mjs` | **127 文件** |
| 幂等 + 排队定向套件 | **9 / 9** |
| 变异测试 | **13 / 13**（非等价）+ 1 个已记录等价变异体 |
---

## 22. 契约 §2.3 待办动作实例感知核查：通过（附一处文档性偏差）

### 22.1 待验证条款

契约 §2.3 点名了一个函数：

> A pending action for instance A must NOT block instance B:
> `getActiveActionForService(serviceId, excludeActionId)` gains instance awareness …

### 22.2 一个必须先说清的偏差

**这个函数在代码库里从未定义。** 全仓 grep 只有调用位点（`src/core/mcp-lifecycle.mjs:238-241` 的 `typeof ... === 'function'` 探测），没有任何实现；实例路径改由 `src/core/instance-lifecycle.mjs` 的 `findPendingOperationId()` 承担同一职责：

```js
const isSameTarget = (candidate) => {
  if (!candidate) return false;
  const candidateInstance = candidate.instanceId || candidate.instance_id || null;
  if (!candidateInstance) return true;   // legacy whole-service action still conflicts
  return candidateInstance === instanceId;
};
```

因此该条款**只能按行为判定，不能按符号名判定**。这是契约文档与实现之间的一处命名偏差（非功能缺陷），已在此记录，供后续维护者不再按名字去找那个不存在的函数。

### 22.3 行为实测（真实 daemon）

| 场景 | 期望 | 结果 |
|---|---|---|
| A：acctA 留有 **QUEUED** 未执行的动作时，执行 acctB 的启动 | acctB 应正常推进到 `SUCCEEDED`，不被他人待办卡住 | **PASS**（acctB `SUCCEEDED`，acctA 仍 `QUEUED` 未被触碰） |
| B：同一实例的第二个动作 | 入队即 `409 BUSY`（正确拒绝） | **PASS** |
| C：legacy 全服务动作待办时 | 仍阻塞该服务的实例动作 | **PASS** |
| D：三个不同实例同时持有待办动作 | 三个独立动作并存 | **PASS** |

```
=== 4/4 passed ===
```

关键一条是 A：这正是"实例 A 的待办不得阻塞实例 B"的直接验证——如果待办查找是服务级的，acctB 会停在 `QUEUED` 而不是走到 `SUCCEEDED`。

### 22.4 回归保护

新增 `tests/instance-pending-action.test.mjs`（4 用例，真实 daemon），并把 **M13** 的守护测试集扩展为同时覆盖它——现在删掉实例维度过滤会同时打红 4 个用例（`tests 9 | fail 4`），守护强度高于只覆盖排队测试时。

### 22.5 一处探针失误（记录以示诚实）

该探针首跑崩溃在 `Store busy ... (QUEUED)`：B 段在 acctA 仍有 QUEUED 动作时再次入队 acctA，这**本就是期望的 409**，但探针没接住异常，导致整轮中止。

这是我第三次犯同类错误（前两次在排队探针与幂等探针）。修法是统一的：把"合法拒绝"当作**返回值**而不是意外：

```js
const queueTolerant = async (action, p) => {
  try { return { ok: true, action: await queue(action, p) }; }
  catch (err) { return { ok: false, code: err?.code, status: err?.statusCode }; }
};
```

### 22.6 汇总

| 检查 | 结果 |
|---|---|
| `check.mjs` | **128 文件** |
| 待办/幂等/排队定向套件 | **13 / 13** |
| 变异测试 | **13 / 13**（非等价）+ 1 个已记录等价变异体 |---

## 23. 路由匹配与路径穿越边界核查：通过

### 23.1 动机

`/api/mcps/:id/instances/...` 的正则用了 `[^/]+` 且严格锚定，**看起来**是对的。但"看起来对"不是证据——`instance-routes.mjs` 里的 `strayMatch` 分支还有一条刻意的设计决策，一旦被后人"优化掉"，就可能让畸形路径漏进 legacy MCP 处理器。

### 23.2 实测（8 项）

| # | 场景 | 结果 |
|---|---|---|
| 1 | 编码后的 `../../etc` 作为 profileId 传入 | 作为**单个不透明字符串**透传，不被拆成路径段（`profileId: "../../etc"`） |
| 2 | 畸形百分号编码 `%E0%A4%A` | 返回 `invalidTarget`，**不抛异常** |
| 3 | service id 含斜杠 `/api/mcps/a/b/instances` | 不匹配（`null`） |
| 4 | legacy 路径（`/api/mcps/:id/start`、`/api/mcps`、`/api/state`） | **全部不被**实例路由捕获 |
| 5 | 结尾斜杠 `/instances/` | 归一化为同一 `listInstances` 路由 |
| 6 | 未知子动作 `/instances/userA/delete` | 返回 `methodNotAllowed`（**刻意设计**，不是我的预期错） |
| 7 | 错误方法 `DELETE` / `PUT` | 映射 `methodNotAllowed`（405），而非静默 fallthrough |
| 8 | 空串 / `/` / `null` | 全部忽略 |

```
=== 8/8 passed ===
```

**第 6 项曾判我自己的预期为错**：我最初断言"未知子动作不应匹配"，实际代码返回 `methodNotAllowed`。读源码后确认这是**刻意设计**：

```js
// Any other /api/mcps/.../instances/... shape is a client error, not a fallthrough.
const strayMatch = normPath.match(/^\/api\/mcps\/[^/]+\/instances(?:\/|$)/);
if (strayMatch) return { route: 'methodNotAllowed', params: {} };
```

理由成立：畸形实例路径必须以客户端错误收场，**绝不能**漏进 legacy 处理器。于是按代码的**真实契约**改写断言，而不是把它记成缺陷。

### 23.3 路径穿越防御（6 层，逐层验证）

第 1 项引出更值得追问的问题：`"../../etc"` 被当作 profileId 一路带下去，到文件系统层还安全吗？

| 层 | 检查 | 结果 |
|---|---|---|
| L1 | `sanitizeProfileSegment` 剥离所有路径分隔符 | PASS（`../../etc → etc`、`a/../../b → a_.._.._b`） |
| L2 | 派生 profile YAML 文件名不含分隔符 | PASS |
| L3 | 真实 handler 对穿越 profileId 返回 404 `PROFILE_NOT_FOUND` | PASS（3/3 均 4xx，无一 2xx） |
| L4 | 未在 dataDir 之外创建任何文件 | PASS（`outside: []`） |
| L5 | 派生的 instanceId 不含分隔符 | PASS |
| L6 | `path.resolve` 后仍落在 profile 目录内 | PASS |

```
=== 6/6 passed ===
```

**一个精确的细节**：`a/../../b` 的 segment 是 `a_.._.._b`——里面**残留了 `..` 字符**。这看似危险，实则无害：`..` 只有作为**独立路径段**（两侧有分隔符）才有穿越语义，而分隔符已被全部剥离，它只是文件名里的两个普通点。L6 用 `path.resolve` 实测确认路径仍在 profile 目录内。

> 这处修正同样来自"先证伪自己"：我最初断言"santized 结果不得包含 `..`"，L1/L5 因此失败。追查后发现是**断言过严**（把无害的字面量当成穿越），改成"不得包含分隔符"后才反映真实的安全性质。

### 23.4 回归保护与变异

新增 `tests/instance-route-edges.test.mjs`（**11 用例**），并加变异 **M15**：让 `strayMatch` 分支失效（畸形实例路径回落到 legacy 处理器）。

M15 第一次未被杀死——因为是**我的变异选错了语义**（改 `listMatch[1]` 对测试不可见），而不是测试有漏洞。换成与测试精确对应的语义后 **KILLED**。

**变异分数最终 14 / 14**（非等价），另有 1 个已记录的等价变异体 M14。

### 23.5 汇总

| 检查 | 结果 |
|---|---|
| `check.mjs` | **129 文件** |
| 路由边界定向套件 | **11 / 11** |
| 变异测试 | **14 / 14**（非等价）+ 1 个等价变异体 |

---

## 24. 前提复核：`24/25 → 25/25` 的 A/B 对照至今仍可复现

### 24.1 为什么值得复核

整份报告的方法论建立在一条断言上：**同一套 25 项脚本，在未修复代码上会失败**。若这条不成立，其余所有"通过"就只是"没测到问题"。

但这条断言最初是对着 `21efa72` 做的 A/B，而**今天的 HEAD 已经不同了**（含我提交的 4 个修复）。如果现在 HEAD 也是 25/25，报告里的对照就成了历史陈述，而非可复现事实。

### 24.2 实测（今天的 HEAD = `4d9ce5c`）

先确认 HEAD 的成分：

```
pointer guard (指针守卫)              : 0    <- 缺失（他人未提交）
owned / identity_verified 列          : 5    <- 已有（我提交）
formatRuntime 透出 instances          : 1    <- 已有（我提交）
sanitizeMcpDto 透出 instances         : 1    <- 已有（我提交）
```

随后 `git archive HEAD` 导出纯净树，跑 25 项脚本；再**只**补上他人的指针守卫，重跑：

```
HEAD as committed (no pointer guard) -> {"total":25,"passed":24,"failed":1,"failedIds":["C18"],"prod":true}
HEAD + pointer guard only            -> {"total":25,"passed":25,"failed":0,"failedIds":[],"prod":true}

CONCLUSION: the "no false green" claim is STILL REPRODUCIBLE on today's HEAD.
```

### 24.3 结论

- 在**今天**的 HEAD 上，25 项脚本仍然**恰好**失败 C18 一项，且补上守卫后**恰好**全部转绿；
- 失败集合精确（只有 C18），说明脚本定位的是那一条不变量，而不是碰巧报错；
- 两次运行的 `production.untouched` 均为 `true`。

**并且：今天 HEAD 与"全部通过"之间只差这一处。** `git diff` 显示工作区相对 HEAD 仅有他人那两处改动（守卫 18 行 + e2e 用例 78 行），其余全部已提交。

这意味着当前状态是一份**可用但带一个已知缺陷**的基线：除 §4 的指针污染外，其余 24 项不变量在 HEAD 上已全部成立。

---

## 25. `getActiveActionForService` 命名偏差的后果核查（结论：无功能缺陷，但我的一处测试是自证式的）

### 25.1 问题

契约 §2.3 点名 `getActiveActionForService(serviceId, excludeActionId)`，但该函数**全仓从未定义**（§22 已记录）。legacy 生命周期（`src/core/mcp-lifecycle.mjs:237-263`）走的是多级兜底：

```js
if (typeof repo?.registry?.getActiveActionForService === 'function') { ... }
else if (typeof repo?.getActiveActionForService === 'function') { ... }
else if (typeof repo?.registry?.listPendingActionIds === 'function' && ...) { /* 只认 APPLYING */ }
else if (typeof repo?.listPendingActionIds === 'function' && ...) { ... }
```

关键疑问：兜底是否**等价于**契约意图？若不等价，legacy 路径会漏判真实冲突或误判排队任务。

### 25.2 可达性与行为实测（5/5）

先确认兜底分支在真实 store 上确实可达：

```
repo.registry?                        true
registry.getActiveActionForService?   undefined
registry.listPendingActionIds?        function
registry.loadAction?                  function
=> 兜底分支可达: true
```

再验行为：

| 场景 | 期望 | 结果 |
|---|---|---|
| A：仅 **QUEUED** 的动作 | 不算执行中冲突（排队≠执行） | PASS |
| B：**APPLYING** 的动作 | 必须报冲突 | PASS |
| C：动作自身 | 不得与自己冲突 | PASS |
| D：其他服务的 APPLYING | 与本服务无关 | PASS |
| E：`getActiveActionForService` 两处均不存在 | 确认命名偏差 | PASS |

**结论：兜底语义与契约意图等价，该命名偏差未造成功能缺陷。**

### 25.3 我必须承认的一处失败

为守住这条语义，我加了变异 **M16**（把 `QUEUED` 也算作执行中冲突），结果它**存活**了。

追查原因，问题在我：`tests/legacy-pending-action.test.mjs` 里我把兜底选择逻辑**复制**到了测试文件中（因为该辅助函数未被导出），**没有 import 源码**。所以修改 `mcp-lifecycle.mjs` 当然杀不掉它——测试根本没加载那个文件。

**这是自证式测试（self-referential test）**：它验证的是我自己写的那份副本，不是产品代码。它比没有测试更危险，因为它制造了虚假信心。

### 25.4 处理方式（不粉饰）

1. **保留测试但改写注释**，明确声明其真实作用域：它验证的是 store 原语（`listPendingActionIds`/`loadAction`/`transitionAction`）与规则的**规格说明**，**不能**捕获生命周期自身副本的回归。
2. **不把 M16 硬造成"击杀"**（比如偷偷改测试去 patch 副本），也不删除变异掩盖问题。
3. **在变异报告中显式列出 M16 为存活**，与等价变异体 M14 分开标注——M14 是等价、M16 是**真实盲区**。

### 25.5 残留缺口（需生产代码改动才能闭合）

| 选项 | 代价 |
|---|---|
| 导出该辅助函数，让测试直接调用 | 需改 `mcp-lifecycle.mjs` 的导出面 |
| 用完整 fake adapter 驱动 `runMcpLifecycleAction` 端到端 | 需构造 legacy 适配器夹具，工作量较大 |

两者都超出"验证"范畴，属生产代码改动，**记录为已知缺口**，交由后续决定，而不是在本轮悄悄绕过。

### 25.6 汇总

| 检查 | 结果 |
|---|---|
| `check.mjs` | **130 文件** |
| legacy 待办语义定向套件 | **5 / 5**（作用域见 §25.3） |
| 变异测试 | **14 / 15**（含 1 个等价变异体 + **1 个已承认的盲区 M16**） |

---

## 26. 干净检出验证：已提交状态可独立工作

### 26.1 为什么这条与"本机通过"不同

此前所有"通过"都跑在**我的工作区**里。而当时工作区含有另一个 agent 的**未提交**指针守卫（该守卫已于 §32 提交，现工作区干净），所以"工作区全绿"并不能证明**提交进去的东西**是完整可用的——两者可能互相掩盖。

因此做了一次干净检出验证：`git archive HEAD`（`cf300be`）导出到临时目录（无 `.git`、无工作区残留），在那里直接运行。

### 26.2 结果

| 检查 | 结果 |
|---|---|
| 导出树是否包含我新增的全部 9 个测试文件 | **是**（`instance-ownership`/`routes`/`render`/`queue-concurrency`/`idempotency`/`pending-action`/`route-edges`、`legacy-pending-action`、`smoke-script-args`） |
| 这 9 个文件在干净树中运行 | **58 / 58 通过** |
| 完整单元套件在干净树中运行 | **54 / 54 文件通过**，0 失败 |
| 干净树发布门禁 | **PASS**（39 条目，见 §16.6） |

### 26.3 结论

**提交到仓库的内容是自包含的**：不依赖我工作区里任何未提交的东西，也不依赖临时目录里的探针。任何人 `git clone` 到 `cf300be` 后都能直接复现这些验证结果。

这同时排除了另一种隐忧——我的测试若依赖工作区残留（例如他人的守卫），在别人机器上就会失败；58/58 证明不存在这种依赖。

### 26.4 唯一仍待补齐的部分

干净树与"指针缺陷已修复"之间仍差**他人那份未提交的守卫**（§24：24/25 → 加上守卫 25/25）。补丁已验证可原样应用（§13.5），但提交它属于替他人做主，需授权。

---

## 27. 崩溃恢复路径核查：通过（此前唯一未测的生命周期分支）

### 27.1 为什么这条重要

管理控制台可能在动作执行**中途**崩溃（进程被杀、机器重启、OOM）。重启后该动作停留在非终态、也非 `QUEUED`（例如 `APPLYING`），此时**副作用是否已发生是未知的**。

若此时"续跑"，后果可能是最坏的一类：**同一账号被拉起了第二个隧道**，或**停掉了一个不该停的进程**。因此正确行为只有一个——**停下来交给人工判定**。

这条分支此前只在代码里读到过（`instance-lifecycle.mjs:357-360`），从未实测。

### 27.2 代码逻辑

```js
// 2. Crash recovery: non-QUEUED state means side effects are uncertain.
if (state !== 'QUEUED') {
  await markAttention(repo, actionId, 'INTERRUPTED');
  return await getPublicAction(repo, actionId);
}
```

### 27.3 实测（真实 store + 真实 daemon，8 项）

| 场景 | 期望 | 结果 |
|---|---|---|
| A：动作停在 `APPLYING`（模拟崩溃） | 标记 `NEEDS_ATTENTION` + `INTERRUPTED`，**不续跑** | **PASS** |
| B：恢复过程**不得**启动任何进程 | launch 次数不变（0 → 0） | **PASS** |
| C：已是 `SUCCEEDED` 的终态动作 | 保持不可变，不被改写、不重跑 | **PASS** |
| D：真正 `QUEUED` 的动作 | 仍正常执行（恢复不能**过度触发**） | **PASS**，且恰好启动 1 个进程 |
| E：恢复后门禁 | 该服务后续动作被 `RECOVERY_GATED` 拦住 | **PASS** |

```
=== 8/8 passed ===
```

D 组尤其关键：一个写得过宽的"崩溃恢复"会把所有 `QUEUED` 动作都判为可疑，从而**让正常排队的工作全部瘫痪**。实测确认它只拦截"非 QUEUED"。

### 27.4 一处我自己的探针错误

首次运行时 A2 失败，报告 `reasonCode: null`。追查发现是**我查错了字段**：`markAttention` 把 code 写进 **`errorCode`**（`instance-lifecycle.mjs:112` → `markActionAttention(actionId, code)`），不是 `reasonCode`。

实测确认值确实正确持久化：

```
keys: [ 'errorCode' ]   errorCode: INTERRUPTED   state: NEEDS_ATTENTION
```

修正探针字段后 8/8 通过。**产品行为是对的，是我的断言查错了地方**——这类"看起来是缺陷、其实是测试写错"的情况，必须查到底再下结论。

### 27.5 回归保护与变异

新增 `tests/instance-crash-recovery.test.mjs`（4 用例，真实 daemon）。变异 **M17**（去掉 `state !== 'QUEUED'` 判断，让恢复变成"续跑"）→ **KILLED**（4 例中 2 例变红）。

**变异分数：15 / 16**（非等价）。M14 为已记录等价变异体；M16 仍是已承认的测试盲区（§25.3）。

### 27.6 一个容易误读的日志现象

`run-tests.mjs --unit` 的输出里会出现若干中间摘要，其中有一批显示 `Failed Files: 1`，而最终摘要为 `55 / 55` 全通过。这不是矛盾：

该失败来自测试**故意创建**的临时夹具：

```
C:\Users\zws\AppData\Local\Temp\harness-fail-test-Ia4VKE\failing.test.mjs
✖ deliberate failure   AssertionError: Expected failure   1 !== 2
```

它是 `run-tests.mjs` 的**自测**——验证"测试失败时 runner 是否如实返回失败退出码"。属预期行为，不是本次回归。记录在此，避免后续读者被这行 `fail 1` 误导。

---

## 28. 真实生产库升级路径验证：通过（本会话最贴近上线的一项）

### 28.1 为什么必须用真实生产库测

我在 `src/store.mjs` 给 `instance_runtime` 增加了 `owned` / `identity_verified` 两列，靠 `ALTER TABLE` 做增量迁移。此前的迁移测试都是**我自己造的空库或新库**，而：
- 生产 `manager.db` 是**旧库**，结构未知；
- 若迁移在真实旧库上抛错，**整个控制台起不来**，这是升级失败最严重的形式；
- 若迁移意外清空或改写既有数据，用户会丢失配置与操作历史。

因此直接拿**真实生产库的副本**做只读迁移演练。

### 28.2 安全做法

| 步骤 | 做法 |
|---|---|
| 取数据 | `cp` 生产 `manager.db` 到临时目录，**只读复制** |
| 原库保护 | 复制前后各算一次 sha256，确认原库未被改动 |
| 演练位置 | 临时目录中另建 `data/`，再用新代码打开 |

**原库哈希全程不变**：`17af6fab69586f4b`（复制前 = 复制后）。

### 28.3 关键发现：生产库**根本没有** `instance_runtime` 表

打开副本后先查结构：

```
tables: metadata, profiles, operations, operation_steps, active_profiles,
        mcp_services, mcp_actions
```

**没有 `instance_runtime`。** 这是从**数据层**独立印证了 §7 的结论（`D:\mcp` 部署副本不含任何并发模块）——并发多账号特性从未上过生产，连表都不存在。

### 28.4 升级演练结果：通过

| 检查 | 结果 |
|---|---|
| 新代码打开旧库 | **不崩溃**，`openStore OK` |
| `instance_runtime` 是否创建 | **是** |
| 列是否完整（18 列） | `instance_id, service_id, profile_id, state, pid, started_at, executable_path, health_url, local_port, profile_yaml_path, operation_id, reason_code, last_exit_code, observed_at, **owned**, **identity_verified**, created_at, updated_at` |
| 两个新列是否就位 | `owned: true`、`identity_verified: true` |
| **既有数据是否保留** | **逐项完全一致** |
| 迁移是否幂等（二次打开） | **正常**，`ALTER TABLE` 不抛错 |

**数据保留明细（迁移前 → 迁移后）：**

```
BEFORE: {"profiles":2,"mcp_services":3,"mcp_actions":1,"active_profiles":3,"operations":7}
AFTER : {"profiles":2,"mcp_services":3,"mcp_actions":1,"active_profiles":3,"operations":7}
DATA PRESERVED: true
```

`active_profiles` 的**内容**也逐行保留（3 条，`profile_id` 未变），说明迁移没有触碰热切换指针——与 §4 的设计约束一致。

### 28.5 结论

**从当前生产库升级到含本特性的版本，数据库迁移是安全的**：建表成功、列齐全、既有数据零损失、重复打开无害。

这补上了此前验证中最大的一个缺口——我之前只能证明"在新库上功能正确"，现在能证明"**在真实生产数据上能安全升级**"。

> 仍需注意：这只验证了**数据库迁移**这一环。发布包本身、运行时依赖、以及 `D:\mcp` 的实际替换流程不在本节范围内；且按 §5.6，`D:\mcp` 目前由另一 agent 管理，实际部署需协调。

---

## 29. 迁移后生产库的端到端启动验证：通过（并发现一条部署风险）

### 29.1 为什么 §28 还不够

§28 证明了**库结构**能安全升级。但"迁移成功"不等于"应用能用"——加列之后仍可能因为默认值、null 处理、DTO 重建等运行时问题而挂掉。因此再做一次真正的端到端：用**迁移后的真实生产库副本**启动完整控制台，走真实 HTTP。

### 29.2 一个必须先说清的坑（我第一次就踩了）

首轮运行，`/api/state` 与 `/api/mcps` 全部 **401**，注入最小认证后 `/api/mcps` 变成 **500**：

```
at Object.unseal (file:///D:/mcp-tunnel-account-manager/src/vault.mjs:207:13)
at file:///D:/mcp-tunnel-account-manager/src/mcp-registry-store.mjs:625:25
at Object.listServices (...mcp-registry-store.mjs:624:17)
at Object.handle (.../src/http/mcp-routes.mjs:427:40)
```

**根因**：`master.key` 就放在 **`dataDir` 内**（`src/vault.mjs:51`：`path.join(resolvedDir, 'master.key')`）。我只复制了 `manager.db`，于是控制台在空目录里**新生成了一个密钥**，用它去解生产库里的密封凭据，必然 `integrity check failed or invalid key/AAD`。

**这是探针的缺陷，不是产品的缺陷**——真实升级会保留原 `dataDir`，密钥不变。把 `master.key` 一并复制后重跑，问题消失。代码确认：

```js
const keyPath = path.join(resolvedDir, 'master.key');   // vault.mjs:51
try {
  fs.writeFileSync(keyPath, freshKey, { flag: 'wx', mode: 0o600 });  // 首次创建
} catch (err) {
  if (err.code === 'EEXIST') masterKey = Buffer.from(fs.readFileSync(keyPath)); // 复用
}
```

### 29.3 端到端结果：8 / 8 通过

用迁移后的生产库 + 生产 `master.key` 启动控制台：

| 检查 | 结果 |
|---|---|
| B1 在迁移后的生产库上成功启动 | **PASS**（端口 61156） |
| B2 绝不占用生产控制台端口 | **PASS**（61156 ≠ 17642/17643） |
| B3 `GET /api/state` | **200** |
| B4 `GET /api/mcps` | **200** |
| B5 生产既有的 3 个服务是否完整返回 | **PASS** —— `overleaf-mcp`、`mcp_dsh_chatgpt_bridge`、`antigravity-mcp` |
| B6 每个 DTO 是否都带可用的 `runtime.instances` 数组 | **PASS**（3/3） |
| B7 生产无实例行，数组应为空而非伪造 | **PASS**（`totalInstanceRows: 0`） |
| B8 生产 DTO 是否泄漏凭据 | **PASS**（无 `apiKey` / `seed` / `Bearer`） |

三个既有服务**逐个 ID 与生产一致**，说明迁移没有破坏任何既有数据，且我新增的 `instances` 字段在真实生产库上**正确接入且为空**（不伪造数据）。

### 29.4 由此得到的一条部署风险（重要）

> **升级时必须保留原 `dataDir` 中的 `master.key`。** 若部署脚本把数据目录"清空重建"、或把库拷到新目录却漏了密钥，**所有已密封的凭据将无法解密**，表现为 `/api/mcps` 返回 **500**、控制台看起来"启动成功但什么都读不出来"。

这个失败形态很隐蔽：进程正常监听、日志无异常、只有 DTO 层 500。建议部署脚本在替换前显式校验 `master.key` 存在且为 **32 字节**（生产实测：`32 bytes`，`2026-11-05 20:40`）。

> 顺带记录：生产 `dataDir` 里还有 `manager.db-shm`（32768 B）与 `manager.db-wal`（4078832 B）。WAL 未合并属正常状态，但升级/备份时应连同 WAL 一起处理，否则可能丢掉未落盘的事务。

### 29.5 风险精化：正常升级天然安全，风险只出现在"手工动数据目录"时

§29.4 把这条风险写得过于笼统。查到实际代码后应当说清楚：**正常升级路径根本不会碰到密钥**。

**依据：数据目录与安装目录是分离的**

```js
// src/main.mjs:106
path.join(process.env.LOCALAPPDATA || os.homedir(), 'McpTunnelAccountManager');
// src/runner.mjs:20-21 同源
```

即：

| 用途 | 位置 |
|---|---|
| 应用代码（安装目录） | `D:\mcp` |
| 用户数据（库 + 密钥） | `%LOCALAPPDATA%\McpTunnelAccountManager` |

两者是**不同目录树**。因此：

- **替换 `D:\mcp` 里的程序文件**（正常升级）→ 完全不触碰数据目录 → `master.key` 与 `manager.db` 原样保留 → **无风险**；
- 安装脚本 `install-portable-console.ps1` 实测只备份 `.lnk` 快捷方式（`shortcut-backups`），**不删除数据目录**；
- 发布包 README 也明确"包内不含 master.key，所有初始化数据由目标机新建"——这是针对**全新安装**，与升级无关。

**风险实际出现的场景（手工操作）：**

| 操作 | 后果 |
|---|---|
| 把 `%LOCALAPPDATA%\McpTunnelAccountManager` 整个删掉重装 | 密钥与库一起丢失（用户数据全没） |
| 只从备份恢复 `manager.db`，却没恢复 `master.key` | **能启动、能列服务，但 `/api/mcps` 500**——最隐蔽 |
| 把数据目录拷到别的机器/别的用户下，密钥未随之迁移 | 同上 |
| 备份只拷 `manager.db`，漏掉 `master.key` 与 `-wal` | 备份不可用或丢事务 |

**修正后的建议**：不是"升级时必须保住密钥"（升级本来就保得住），而是——

> 任何**手工的**数据迁移/备份/恢复操作，必须把 `manager.db`、`manager.db-wal`、`master.key` 当作**一个整体**搬运。只搬其中一部分会产生"程序看着正常、数据读不出来"的隐蔽故障。

> 这是对我自己上一节表述的纠正：把"升级风险"改成"手工数据操作风险"，因为前者在代码上是结构性地被避免的。写文档时若只凭直觉描述失败场景而不去看目录解析代码，就会给出过度惊慌的结论。

---

## 30. 迁移后表结构与约束的逐项符合性核查：通过

### 30.1 为什么还要查这一层

§28 证明了"表能建出来、数据不丢"，§29 证明了"应用能跑"。但两者都没回答一个更细的问题：**建出来的表是否与契约定义一致，且约束真的生效**。

尤其是唯一约束——如果只建了列而索引没建成，两个不同账号可能被写入同一行，或同一 `(service, profile)` 出现重复行；这类问题不会立刻报错，只会在后续出现"数据对不上"的诡异现象。

### 30.2 契约 §2.1 的要求

```sql
CREATE TABLE IF NOT EXISTS instance_runtime (
  instance_id      TEXT PRIMARY KEY,
  service_id       TEXT NOT NULL,
  profile_id       TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'stopped',
  pid              INTEGER,
  ...
);
CREATE UNIQUE INDEX idx_instance_runtime_service_profile ON instance_runtime(service_id, profile_id);
```

即两条硬约束：`instance_id` 主键 + `(service_id, profile_id)` 唯一。

### 30.3 实测（在**迁移后的真实生产库副本**上）

**结构比对结果：逐列一致。** 实际迁移出的表含契约的全部 16 列，类型与约束完全相同，另有我按 §4.6 方案 A 新增的 2 列：

```
owned             INTEGER
identity_verified INTEGER
```

两列**均可空、默认 NULL**，插在 `created_at` 之前。因此这是**向后兼容的超集**：契约要求的列一个不少，新增列对旧代码不可见。

**索引实测：**

```
indexes: [
  { name: 'idx_instance_runtime_service_profile', unique: 1, origin: 'c' },
  { name: 'sqlite_autoindex_instance_runtime_1', unique: 1, origin: 'pk' }
]
idx columns: service_id,profile_id
```

**约束实效力测试（真实写入）：**

| 操作 | 结果 |
|---|---|
| 插入 `mcp_t__uA` / `mcp_t` / `uA` | **成功** |
| 再插同一 `instance_id` | **被拒**（`ERR_SQLITE_ERROR`，主键冲突） |
| 插不同 `instance_id` 但相同 `(service_id, profile_id)` | **被拒**（`ERR_SQLITE_ERROR`，唯一索引冲突） |

即两条约束**不只是存在，而是真的在拦截**。

### 30.4 一处需要明确记录的差异

契约 §2.1 给出的是 v1 冻结定义，**不含** `owned` / `identity_verified`。我的实现是**超集**而非逐字复制。

这不算违反契约，理由：
- 契约本身声明新表是"additive"（增量）设计；
- 新增列可空且默认 NULL，旧版本代码/旧数据读写不受影响（已由"第二次打开幂等"验证）；
- 这两列是 §4.6 缺陷修复的必需产物（否则 UI 永远无法停止实例）。

但**应当被告知**：若有工具按契约原文逐字校验 schema，会看到两列差异。建议契约文档在下一版把这两列补进定义，避免后续实现者对不上。

### 30.5 汇总

| 检查 | 结果 |
|---|---|
| 契约 16 列是否齐全、类型/约束一致 | **是** |
| 新增 2 列是否向后兼容（可空、默认 NULL） | **是** |
| `instance_id` 主键是否生效 | **是**（实测拒绝重复） |
| `(service_id, profile_id)` 唯一索引是否生效 | **是**（实测拒绝重复） |
| 与契约原文的差异 | 仅多 2 列（已说明，建议契约下一版补录） |

---

## 31. 契约 §2.4 向后兼容核查：通过（并纠正我自己的一个错误假设）

### 31.1 契约要求

> `getServiceRuntime(serviceId)` — must stay **back-compatible**
> Returns the same shape as today, plus an optional additive `instances: [...]` array built from `listInstanceRuntimes`. When there are no instance rows → `instances: []`. Existing callers ignore it.

这是全仓被调用最多的运行时接口之一（`instance-routes.mjs`、`mcp-routes.mjs` 多处依赖），若形状变了，影响面远超并发特性本身。

### 31.2 我一开始假设错了

我原以为 `instances` 是**我这次加进去的**字段，于是写了断言"唯一的改动就是新增 `instances`"。运行结果：

```
FAIL mcp_p1: the ONLY addition is instances :: {"added":[]}
FAIL old revision had no instances key :: {"oldKeys":["runtimeState","activeProfileId","instances"]}
```

`added: []` 说明新旧两版**键完全相同**——也就是说 **`instances` 在 `21efa72` 就已存在**。

查证确认：`21efa72` 版本的 `getServiceRuntime` 已经是 `return { ...base, instances };`，与当前**逐字节一致**。

> 这与 §14/§15 记录的缺陷并不矛盾：那两个缺陷在**别的函数**上（`mcp-registry-store.mjs` 的 `formatRuntime`、`http/mcp-routes.mjs` 的 `sanitizeMcpDto`），它们各自把 `instances` 剥掉了。store 层的 `getServiceRuntime` 一直是好的。

### 31.3 因此真正的证明反而更强

既然函数没有被改动，向后兼容就不是"我小心保持了"，而是**结构性地成立**。实测：

| 检查 | 结果 |
|---|---|
| S1 `getServiceRuntime` 源码是否逐字节相同 | **是**（896 字符，sha `d443fedd467aaa9d`，新旧一致） |
| 分支一（服务无 active 指针）键集合 | 无增、无删 |
| 分支二（服务有 active 指针，字段更全）键集合 | 无增、无删 |
| 两个分支的所有值 | **逐项相同** |
| 无实例行时 `instances` 是否为 `[]` | **是**（新旧均为数组、长度 0） |

```
=== 10/10 passed ===
```

### 31.4 方法论小结

这次失败是我**第三次**因为"假设某个字段是我加的"而写错断言（前两次见 §27.4 的 `reasonCode`、§23 的 `methodNotAllowed`）。

共同点：**在没读旧版本代码之前，就按当前实现的印象去设定"改动前应该是什么样"**。

可靠做法只有一个：**用 `git show <旧版本>:<文件>` 取旧实现，与当前实现直接对比**，而不是凭记忆或推断。本次正是这样做的——先取 `21efa72` 的函数体做 sha256 比对，才得出"零改动"这个确切结论。

---

## 32. 指针缺陷已提交（经用户授权）：HEAD 现为 25 / 25

### 32.1 背景与授权

§4 记录的指针缺陷，其修复一直以**未提交**状态存在于工作区，作者不是本会话（文件时间戳 01:31 / 01:37，晚于会话开始）。我在第 1–31 节中只对其做**只读验证**，从未擅自提交。

本节依据用户明确授权执行提交。

### 32.2 提交内容

被提交的是他人那份修复，**意图完全保留**，我只额外做了一件必需的事——重算发布基线：

| 改动 | 说明 |
|---|---|
| `finishLifecycleAction` 签名增加 `instanceId` | 使函数能判断动作作用域 |
| 清空/推进指针的分支包进 `if (!instanceId)` | **指针只由 whole-service 动作推进** |
| 配套 e2e 回归用例（78 行） | 作者一并提供 |
| `source-core-hashes.json` 重算 1 条目 | `9924e1779edb…` → `0ab8285c17d2…`（**同一次提交内**，否则干净检出会门禁失败，见 §16.6） |

修复的语义：此前**每一个**动作都会推进 legacy 指针，包括实例级动作。于是启动账号 A 会把旧指针指向 A；停止 A 会在另一个账号的隧道仍在运行时清空指针——导致服务被报成"已停止"、显示错误的活跃账号，并静默改写后续 legacy 启动所解析的账号。

### 32.3 提交前的验证（不动工作区）

用 `git checkout-index -a --prefix=…` 把**索引内容**导出到临时目录验证，避免"改完才发现不行再回滚"：

| 检查 | 结果 |
|---|---|
| 导出树的发布门禁 | **PASS**（39 条目） |
| 导出树的 25 项主验证脚本 | **25 / 25**，production untouched |
| 与 §24 独立 A/B 是否一致 | 一致（HEAD 24/25 → 加守卫 25/25） |

### 32.4 提交后的验证

| 检查 | 结果 |
|---|---|
| 干净 `git archive HEAD` 的发布门禁 | **PASS** |
| 干净克隆的 25 项主验证脚本 | **25 / 25**，production untouched |
| 单元套件 | **55 / 55 文件通过**，0 失败 |
| 工作区状态 | **完全干净**（不再有任何未提交改动） |
| HEAD 是否含守卫 | 是 |

### 32.5 这一步改变了什么

| 项目 | 提交前 | 提交后 |
|---|---|---|
| 25 项主验证脚本 | 24 / 25（仅 C18 失败） | **25 / 25** |
| 工作区 | 含 2 处未提交改动 | **干净** |
| `git clone` 后的行为 | 指针污染缺陷存在 | **缺陷已修复** |
| 5 个缺陷状态 | 4 修复 / 1 未提交 | **5 全部修复并提交** |

至此，§4/§4.6/§12/§14+§15/§20 **五个缺陷全部修复并纳入版本控制**，且每一处都有对应的回归测试与变异守护。

### 32.6 仍未做的（需再次授权）

| 事项 | 状态 |
|---|---|
| 合入 `final` 分支 | 未做。已预演：无冲突、无需重算基线、合并后单元 54/54 + 集成 18/20（§17.1） |
| push 到远端 | 未做 |
| 重建发布包并部署到 `D:\mcp` | 未做。当前 `D:\mcp` 不含任何并发模块（§7），且该目录由另一 agent 管理 |

---

## 33. 合并预演复审（守卫已提交后）：结论更强

### 33.1 为什么要重做

§17.1 的合并预演是在**指针守卫还未提交**时做的。§32 把它提交后，待合并的分支内容变了，旧结论必须重验——否则就是拿过期的演练结果去做发布决策。

### 33.2 方法（仍不触碰真实仓库）

`git clone --no-hardlinks` 到临时目录 → 检出 `origin/final`（`0e824e0`）→ 合并 `feature/concurrent-account-tunnels`。

### 33.3 结果

| 检查 | 结果 |
|---|---|
| 合并是否冲突 | **无冲突**（`git status` 干净） |
| 合并后的发布门禁 | **PASS**（39 条目，**无需重算基线**） |
| 合并后 `src/store.mjs` 与我的 HEAD | **逐字节相同** |
| 合并后 `src/mcp-registry-store.mjs` 与我的 HEAD | **逐字节相同**（`0ab8285c17d2`） |
| 25 项主验证脚本（合并树） | **25 / 25**，production untouched |
| 单元套件（合并树） | **55 / 55 文件通过**，0 失败 |
| 作者那份 e2e 用例（`concurrent-instances.e2e.test.mjs`） | **5 / 5 通过** |
| 集成套件（合并树） | **18 / 20**，失败的仍是 `third-mcp`（VERIFY_FAILED）与 `powershell-launch-env`（150s 超时）——与主干及改动前基线完全一致 |

### 33.4 比 §17.1 强在哪里

§17.1 做预演时守卫尚未提交，合并树里**没有**那个修复，所以当时只能说"合并过程无害"。现在合并树**包含了全部 5 个缺陷的修复**，因此可以直接说：

> **合并后的 `final` 是一个功能完整、25/25 通过、单元全绿的树。**

尤其值得注意的是：作者那份 e2e 用例此前一直是**未提交**状态，从未在完整树上跑过；这次是它第一次在真实合并树中执行，结果 **5/5 通过**——说明该用例与守卫是配套的，且与我的改动不冲突。

### 33.5 仍然没有做的事

预演全程在临时克隆中，**真实仓库的 `final` 分支未被触碰**。要真正合入，需再次授权。

### 33.6 一次附带清理

该轮集成运行中 `powershell-launch-env` 再次超时，又泄漏了 2 个子进程（`14108`、`31660`）——再次印证 §5.5/§5.6 的结论（每次超时都会漏一个）。已按 PID 精确清理，复查 `remaining: 0`，未使用批量 `taskkill`。

### 33.7 独立复核：合并结论不依赖当时那次运行

§33 的结论（无冲突、门禁 PASS、`src` 与 HEAD 一致、56/56）来自会话中的一次预演。与 §9.1 同样的顾虑——**一次观测不等于可复现事实**。因此做了一次完全独立的复核：重新 `git clone`、重新检出 `origin/final`、重新合并。

| 检查 | §33 当时的结论 | 独立复核结果 |
|---|---|---|
| 合并是否冲突 | 无 | **无**（`git status` 干净，`merge exit=0`） |
| 合并后发布门禁 | PASS | **PASS**（39 条目，未重算基线） |
| `src` / `public` 与 HEAD 是否一致 | 逐字节相同 | **6/6 全部 SAME** |
| 单元套件 | 56/56 | **56/56**，0 失败 |

逐字节一致的 6 个文件：

```
src/store.mjs                     SAME
src/mcp-registry-store.mjs        SAME
src/core/instance-lifecycle.mjs   SAME
src/http/instance-routes.mjs      SAME
src/http/mcp-routes.mjs           SAME
public/app.js                     SAME
```

**这条复核的价值**：它把"合并到 `final` 是安全的"从**一次观测**变成**任何人可重现的结论**——对方只需 `git clone` + `git checkout origin/final` + `git merge feature/concurrent-account-tunnels`，就能得到与我相同的结果。

仍需注意：**真实仓库的 `final` 分支始终未被修改**，所有预演都在临时克隆中完成。

### 33.8 契约 §7 的三条验收命令：全部通过（权威验收）

契约 §7 给出了"完成"的**权威定义**，而不是由我主观判断验证是否充分：

```
node scripts/check.mjs
node scripts/run-tests.mjs --unit
node scripts/smoke-concurrent-instances.mjs
```

并附一条硬性前提：

> All must pass with the production console on 17642 and existing tunnel-client processes
> (PIDs recorded at session start) still alive and unchanged.

#### 逐条执行结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `node scripts/check.mjs` | **133 文件全通过**（exit 0） |
| 2 | `node scripts/run-tests.mjs --unit` | **56 / 56 文件通过**，0 失败（exit 0） |
| 3 | `node scripts/smoke-concurrent-instances.mjs` | **通过**（见下） |

命令 3 使用 `--port 17679`，原因：契约成文时 17643 未被占用，而本机 17643 已由另一控制台（PID 22800）持有。这正是 §5.4 修复 `--port` 的用途。脚本输出：

```json
{"port":17679,
 "instances":[{"instanceId":"mcp_instancesvc__userA","pid":44972,"state":"running","localPort":56556},
              {"instanceId":"mcp_instancesvc__userB","pid":41416,"state":"running","localPort":56367}],
 "bothRunning":true,"stopIsolated":true,"prodUntouched":true}
```

三个关键布尔值全为 `true`：两实例同时运行、停止互不影响、生产未被触碰。

#### 硬性前提的核验

冒烟脚本**自身**打印的生产快照（独立于我的人工检查）：

```
production AFTER: {"tunnelClients":["10268:134387066492697780",
                                    "21996:134387066493312420",
                                    "29888:134387066490783790"],
                   "portListeners":[27736]}
```

| 前提 | 结果 |
|---|---|
| 会话开始记录的 3 个 tunnel-client 仍存活 | **是** |
| 其 `CreationTimeFileTime` 是否未变 | **是**（与 §6.1 记录的 `134387066490783790` / `134387066492697780` / `134387066493312420` 完全一致） |
| 生产控制台 17642 是否仍在监听 | **是**（PID 27736） |

#### 一处需要如实记录的观测

验收前快照中出现过**第 4 个** tunnel-client（PID 30312，`CreationTimeFileTime` 与其他三个不同）。约 1 分钟后复查，该进程已自行退出，恢复为原有的 3 个。

这与 §6.1 记录的现象**同类**：`D:\mcp` 存在并发外部活动（另一 agent 或生产控制台自身的临时动作）。判定依据仍是原有 3 个 PID 的创建时间未变——它们**未被 kill、未被重启**，因此"生产未受影响"的结论成立。

#### 结论

**契约 §7 定义的三条验收命令全部通过，且其硬性前提全部满足。** 这是本次验证中最具权威性的一条结论，因为它使用的是契约自己设定的标准，而非我自行拟定的检查项。

### 33.9 已实际合入 `final`（经用户授权）

§33.1–§33.8 全部是**预演**。本节记录**真实合并**及其验证。

#### 合并前后

| 项目 | 值 |
|---|---|
| 合并前 `final` | `0e824e0`（与 `origin/final` 一致，无落后） |
| 源分支 | `feature/concurrent-account-tunnels` @ `e4eb687` |
| 合并方式 | `git merge --no-ff`（保留合并历史） |
| 合并结果 | **`81e7bde`** |
| 冲突 | **无**（`git status` 干净） |

#### 合并后在 `final` 上重跑契约 §7 的三条验收命令

| # | 命令 | 结果 |
|---|---|---|
| 1 | `node scripts/check.mjs` | **133 文件全通过** |
| 2 | `node scripts/run-tests.mjs --unit` | **56 / 56 文件**，0 失败 |
| 3 | `node scripts/smoke-concurrent-instances.mjs --port 17681` | **通过**：`bothRunning / stopIsolated / prodUntouched` 全 true |

冒烟输出：

```json
{"port":17681,
 "instances":[{"instanceId":"mcp_instancesvc__userA","pid":38128,"localPort":63863},
              {"instanceId":"mcp_instancesvc__userB","pid":42488,"localPort":63762}],
 "bothRunning":true,"stopIsolated":true,"prodUntouched":true}
```

#### 发布门禁：**未重算基线即通过**

这一点在预演中已预测（`final` 独有的 3 个提交只触及 `README.md`、`docs/releases/*`、`packaging` 模板，不涉及 `src/`/`public/`），实际合并后得到确认：

```
RELEASE BUILD GATE: PASS — baseline matches the tree, release build would proceed
  entries: 39
```

**这与 §16.6 的规则一致**：只有当合并改变 `src/`/`public/` 时才需重算基线。本次不需要。

#### 生产环境（契约硬性前提）

| 检查 | 结果 |
|---|---|
| 3 个 tunnel-client | 29888 / 10268 / 21996，`CreationTimeFileTime` 与开局**完全一致** |
| 17642 | PID **27736**（未变） |
| 17643 | PID **22800**（未变） |
| `manager.db` | `17af6fab69586f4b`（未变） |

#### 当前分支状态

```
final               81e7bde  （本地，领先 origin/final 55 个提交）
origin/final        0e824e0  （未推送）
feature/...         e4eb687  （未推送）
```

**尚未 push。** `final` 的更新目前只存在于本地仓库；远端 `origin/final` 仍是 `0e824e0`。推送需再次授权。

### 33.10 合并完整性核查：无提交遗漏、无代码丢失

§33.9 记录了合并与验收，但"合并成功"不等于"合并完整"。三件事需要独立确认：**提交是否全部带过来了**、**代码是否逐字节一致**、**文档是否有内容丢失**。

| 检查 | 命令 | 结果 |
|---|---|---|
| 提交是否全部可达 | `git log feature --not final \| wc -l` | **0**（无遗漏） |
| `src/` + `public/` 是否与来源分支一致 | `git diff --stat final feature -- src/ public/` | **空输出 = 完全一致** |
| 报告是否丢失内容 | `git diff feature final -- <报告> \| grep -c '^-'` | **0 行被删** |
| 报告是否有新增 | 同上 `grep -c '^+'` | 44 行（即 §33.9 的记录） |

#### 差异清单恰好是预期的发布侧文件

`final` 与 `feature` 的整体差异只有 8 个文件，全部属于 `final` 独有的发布产物：

```
README.md
docs/analysis/multi-profile-concurrency-verification.md      ← 仅多出 §33.9
docs/releases/v1.2.0-preview.5/README-Release.zh-CN.md
docs/releases/v1.2.0-preview.5/RELEASE_NOTES.zh-CN.md
docs/releases/v1.2.0-preview.5/SHA256SUMS.txt
docs/releases/v1.2.0-preview.5/VALIDATION.zh-CN.md
docs/releases/v1.2.0-preview.5/validation-report.json
packaging/windows/templates/kit/oneclick/Start-McpTunnel-Console.ps1
```

**没有任何 `src/` 或 `public/` 文件出现在差异中**——这正是发布门禁能在不重算基线的情况下通过的原因，也与 §33.1 的预演结论一致。

#### 关于报告那一行差异

报告出现在差异列表里，需要排除"内容丢失"的可能。确认：

- `git diff --name-status` 显示 **`M`（修改）而非 `D`（删除）** —— 文件在 `final` 上存在；
- `final` 上的报告为 **2567 行**；
- 反向 diff 中**被删行数为 0**，新增 44 行。

即 `final` 的报告是 `feature` 报告的**严格超集**，多出的部分正是合并后追加的 §33.9 记录。**没有内容丢失。**

### 33.11 发布包真实构建验证：成功，且包内容与 `final` 一致

§16/§33 只验证了**发布门禁**（哈希基线比对），从未真正跑过构建器。门禁通过 ≠ 包能构建出来——本节补上这一步。

#### 构建命令（输出到仓库之外的临时目录）

```powershell
node packaging\windows\build-release.mjs `
  --source   D:\mcp-tunnel-account-manager `
  --output   %TEMP%\relbuild2-<ts> `
  --runtime  D:\mcp\console\runtime\node.exe `
  --node-license D:\mcp\console\runtime\LICENSE
```

> 首次尝试失败：`Error: Runtime probe failed.` 原因是把 `--runtime` 传成了**目录**
> （`D:\mcp\console\runtime`），而它要求**可执行文件路径**。查 `docs/BUILD-RELEASE.md`
> 确认正确用法后重试成功。`node.exe` 版本 v25.9.0 win32 x64，满足脚本要求的 ≥22.14。

#### 构建结果

| 项目 | 值 |
|---|---|
| 结果 | **成功** |
| 产物 | `MCP-Tunnel-Console`（99 文件，约 **97 MB**）+ `MCP-Tunnel-Console-Source` |
| 安全审计 | **`findingCount: 0`**（无发现） |
| 可执行文件 | `runtime/node.exe` |
| 输入清单状态 | 已记录（stale 检查无告警） |

#### 包内容核验

**8 个关键文件与 `final` 分支逐字节一致：**

```
SAME  src/store.mjs
SAME  src/mcp-registry-store.mjs
SAME  src/core/instance-lifecycle.mjs
SAME  src/core/concurrent-instances.mjs
SAME  src/adapters/instance-adapter.mjs
SAME  src/http/instance-routes.mjs
SAME  src/http/mcp-routes.mjs
SAME  public/app.js
```

**前端确实含实例 UI**（这是 §35 指出的关键点——只换后端用户看不到功能）：

```
getInstanceActionGating     = 2
renderMcpInstanceSection    = 2
identityVerified            = 1
```

**未误带敏感数据**：包内 `manager.db*`、`master.key`、`*.env` 均**不存在**。

#### 这条验证的意义

此前"可以发布"的依据是门禁 PASS；现在多了一层直接证据：**构建器确实能产出完整的发布包，且包内代码与 `final` 一致、含前端、不含账号数据**。

仍未做的：把包**安装/替换到 `D:\mcp`**（那是部署动作，需与 `D:\mcp` 维护者协调，且会改动生产）。

> 构建产物位于 `%TEMP%`，验证后已删除，未污染仓库。

---

## 34. 第六个缺陷（既有，**未修复**）：legacy 生命周期忽略了 `busy` 决策

### 34.1 发现经过

为消除 §25.3 的 M16 盲区（测试复制了兜底逻辑而没跑真实代码），我改用**假 repo 驱动真实的 `runMcpLifecycleAction`**。结果与预期相反：

```
--- sibling APPLYING ---
  prepared : true   finalCode: null
--- sibling QUEUED ---
  prepared : false  finalCode: STATE_REFRESH_REQUIRED
```

即：**另一个动作已在执行（APPLYING）时，新的启动动作照样执行了**；而仅仅排队的动作反而被拒。与 §22 的结论完全相反，因此必须查到底。

### 34.2 根因（代码级确证）

`decideTunnelClientAction` 的判断顺序是正确的：

```js
// src/core/tunnel-client-lifecycle.mjs:12
if (ctx.pendingOperationId) {
  return { decision: 'busy', code: 'OPERATION_IN_PROGRESS', operationId: ctx.pendingOperationId };
}
```

直接单测该函数，传 `pendingOperationId` → 返回 `{"decision":"busy","code":"OPERATION_IN_PROGRESS"}`，**正确**。

问题在调用方。`src/core/mcp-lifecycle.mjs:315` 之后：

```js
const decision = decideTunnelClientAction(actionKind, ctx);

if (decision.decision === 'reject') { ...返回... }
if (decision.decision === 'noop')   { ...返回... }

// decision === 'enqueue' -> execute!
if (typeof repo.transitionAction === 'function') {
  await repo.transitionAction(actionId, { state: 'APPLYING' });   // <-- busy 也走到这里
}
```

**`busy` 分支根本没有被处理**（全文件 `grep busy` 无命中），于是 `busy` 与 `enqueue` 同样落入"开始执行"。

对照实例路径，`src/core/instance-lifecycle.mjs:654` 是**正确处理**的：

```js
if (decision.decision === 'busy') {
  // Leave QUEUED so the runner retries after the conflicting action settles.
  return await getPublicAction(repo, actionId);
}
```

### 34.3 危害（实测）

构造"另一个动作正在 APPLYING 时，来一个 legacy start"，观测是否真的触碰副作用：

```
reached prepare()         : true
reached applyIfUnchanged(): true   <-- 真的改了这个服务
action state             : SUCCEEDED | errorCode: null
threw                    : null
```

即：**在另一个动作已经进入副作用阶段、结果未知的情况下，第二个动作照常执行并报告成功。** 这正是契约 §2.3 的 `OPERATION_IN_PROGRESS` 想要防止的情形——并发写同一服务，可能导致重复启动、凭据被覆盖、或最终状态与任何单个动作的意图都不一致。

### 34.4 归属：既有缺陷，**不是本次改动引入**

```
git show 21efa72:src/core/mcp-lifecycle.mjs | grep -c "decision.decision === 'busy'"
→ 0
```

在我的任何改动之前，该分支就不存在。本次并发特性**没有**引入它；相反，实例路径一开始就写对了。

### 34.5 我**没有**修它，原因

修 `mcp-lifecycle.mjs` 等于改动 legacy 单账号路径的核心执行序——这正是我在本次验证中反复强调"必须保持字节不变"的那条路径（契约 §2.2 / §4）。修它需要：

1. 增补 `busy` 分支（约 3 行）；
2. 决定语义：保持 `QUEUED` 等重试（与实例路径一致），还是返回 `OPERATION_IN_PROGRESS`；
3. 评估对既有 legacy 调用方（`runner.mjs` 的工作队列）的影响；
4. 补回归测试与变异守护。

这属于**修复他人路径的功能缺陷**，超出"验证"授权范围，且不在用户批准的「提交他人的指针修复」之内。因此本报告只做**记录与定位**，交由维护者决定。

> 一个值得注意的点：这不是我的探针失误——我一开始也因为结果与预期相反而怀疑自己。是逐层加日志（`registry.listPendingActionIds` / `registry.loadAction` 确实被调用并返回了 APPLYING）才定位到"决策正确、调用方没处理"。**结论：产品有缺陷，测试是对的。**

### 34.6 相关但**仍成立**的结论

§22 当时得出的"待办动作实例感知正确"结论**依然成立**——那是对**实例路径**（`findPendingOperationId` + `instance-lifecycle.mjs` 正确处理 busy）的验证。本节发现的是**legacy 路径**的独立缺陷，两者不冲突。

而 §22 末尾记录的"探针复制逻辑"这个盲区，正是靠本节这次"驱动真实代码"才暴露出来——**盲区确实存在，而且藏着一个真实缺陷**。这也印证了当时拒绝"假装杀掉 M16"的判断是对的。

### 34.7 严重度修正：该缺陷在实践中**不可达**（我自己上一节夸大了）

§34.3 把危害写成"并发写同一服务"。追查可达性后，这个描述**不准确**，必须修正。

#### 三重抑制机制（逐条实测）

| 机制 | 实测结果 |
|---|---|
| 创建阶段：`assertIdle()` 拒绝与任何非终态动作共存 | legacy APPLYING 时新建 legacy → **`BUSY`** |
| 同上（反向）：instance APPLYING 时新建 legacy | **`BUSY`** |
| 同上（混合）：legacy APPLYING 时新建 instance | **`BUSY`**（legacy 仍是全局作用域） |
| 执行阶段：`withExclusiveLock` 串行 | legacy 与 instance **共用同一把锁**（`runner.mjs:223` 与 `:212`） |

三条合起来推出：

> **一个 legacy 动作被创建时，系统中至多只有它自己这一个非终态动作。** 它开始执行时，其他动作要么已经终结，要么根本不存在。

因此 `pendingOperationId` 在 legacy 路径上**几乎恒为 null**，`decideTunnelClientAction` 的 `busy` 分支在实践中走不到——我实测那个 `APPLYING` 场景之所以能"通过"，是因为它**绕过了 `createLifecycleAction`**（我的探针直接构造了动作状态），生产中拿不到这种状态组合。

#### 剩余的理论路径

只有一种：数据库里存在**崩溃遗留**的 `APPLYING` 动作，同时又有一个 `QUEUED` 的 legacy 动作。但按上面的 R1 结论，这两个状态**不可能在同一次运行中被创建**；而崩溃恢复分支（§27）会把遗留的非 `QUEUED` 动作标为 `NEEDS_ATTENTION/INTERRUPTED`，`QUEUED` 的那个又不会设置 `pendingOperationId`（只认 `APPLYING`）。所以这条路径也基本闭合。

#### 修正后的定性

| 项目 | 原表述（§34.3） | 修正后 |
|---|---|---|
| 可达性 | 隐含"正常运行时会发生" | **不可达**（需绕过 `createLifecycleAction` 或手工构造库状态） |
| 危害 | "并发写同一服务" | **潜在健壮性缺口**：代码与自身决策契约不一致 |
| 严重度 | 偏高 | **低（latent）** |
| 是否该修 | 未明确 | 仍**建议修**——它是死代码分支，日后若放宽 `assertIdle`（例如为并发特性再扩展作用域）就会立即变成真实漏洞 |

#### 保留这个记录的理由

即便不可达，它仍值得记录，原因有三：

1. **同一份代码里两处实现不一致**：实例路径正确处理 `busy`，legacy 路径没有。这种不对称本身就是缺陷。
2. **它是我自己 API 扩展的邻近风险**：§20 我放宽了 `assertIdle` 让实例动作可并发排队。若将来有人把同样的放宽应用到 legacy 作用域，这个 dormant 分支会立刻被激活。
3. **它验证了"复制逻辑的测试"有多危险**：§22 的测试因为复制了选择规则而看不到它；换成驱动真实代码（本节）才发现。虽然最终判定为不可达，但**发现过程本身证明那个盲区是真实存在的**。

#### 方法论教训

我在 §34.3 犯的错与前面几次同类：**看到 `applyIfUnchanged` 被调用就断言"会造成并发危害"，没有先验证这条路径在生产中能否被走到**。

正确的顺序应当是：先确认可达性，再定性危害。这次是靠"探针构造的状态是否合法"这一追问才发现问题——而这一追问之所以发生，是因为我注意到自己的探针**绕过了**正常创建流程。

---

## 35. 部署清单与回归风险核查（只读 `D:\mcp`）

### 35.1 为什么需要这一节

待授权项里有"重建部署包并上线"。做这个决定需要两个具体答案，此前都只有模糊印象：

1. **要部署哪些文件？**（我的修复不能只换后端——若前端仍是旧的，用户看不到功能）
2. **会不会回退别人的工作？**（`D:\mcp` 由另一 agent 管理，若它含我仓库没有的改动，覆盖即造成回退）

### 35.2 前端缺失的实证

`public/app.js`（已部署 138607 B，`2025-11-09 21:50`）与仓库 HEAD 对比关键符号：

| 符号 | 仓库 HEAD | 已部署 |
|---|---|---|
| `getInstanceActionGating` | 2 | **0** |
| `renderMcpInstanceSection` | 2 | **0** |
| `runtime.instances` | 2 | **0** |
| `identityVerified` | 1 | **0** |
| `owned` | 3 | **0** |

即：**已部署的前端完全不认识"并发实例"这个概念**。只部署后端的话，DTO 会多出 `instances` 数组，但页面没有任何代码去渲染它——功能对用户不可见。

### 35.3 部署清单（`src/` + `public/`，共 39 个文件）

| 分类 | 数量 |
|---|---|
| 两边**完全一致** | **24** |
| **需要部署** | **15** |

需要部署的 15 个：

**内容不同（11 个）**

```
src/adapters/index.mjs            src/main.mjs
src/core/mcp-registry-policy.mjs  src/mcp-registry-store.mjs
src/http/mcp-routes.mjs           src/runner.mjs
src/server.mjs                    src/store.mjs
public/app.css  public/app.js     public/index.html
```

**已部署侧完全缺失（4 个）**

```
src/adapters/instance-adapter.mjs
src/core/concurrent-instances.mjs
src/core/instance-lifecycle.mjs
src/http/instance-routes.mjs
```

### 35.4 回归风险：**未发现**

"文件不同"本身有歧义：可能是"已部署是旧的"（前向部署，安全），也可能是"已部署有我们没有的改动"（覆盖即回退）。

用**声明符号的方向性**判定（提取两侧各自声明的函数/导出名，找"仅存在于已部署侧"的项）：

| 检查 | 结果 |
|---|---|
| 含"已部署独有声明"的文件 | **0 / 11** |
| 仓库独有声明示例（`src/store.mjs`） | `positivePidOrNull`、`formatInstanceRuntime`、`listInstanceRuntimes`、`upsertInstanceRuntime` 等 11 个 |
| 仓库独有声明示例（`public/app.js`） | `getMcpInstances`、`buildInstanceRowKey`、`isInstanceInTransition`、`countRunningInstances` 等 21 个 |

**结论：差异是单向的**——仓库是已部署的**严格超集**，已部署侧没有任何我仓库缺失的声明。因此用本仓库构建物替换是**纯前向**操作，不会回退另一 agent 在这些文件中的工作。

> 限定：本检查基于**声明符号**，不是逐字节语义比对。它能排除"整块功能被我们覆盖"这类回退，但不能证明对方没有改过函数**内部实现**。真正部署前仍应先与 `D:\mcp` 的维护者对齐（该目录不由我修改）。

### 35.5 对上线决策的直接含义

| 结论 | 含义 |
|---|---|
| 必须同时部署前端 | 只换后端，用户看不到并发实例功能 |
| 15 个文件需要部署 | 其中 4 个是**新增文件**，不是覆盖 |
| 无回归风险证据 | 仓库为超集，但内部实现差异仍未逐行核对 |
| 数据库迁移已验证 | §28/§29/§30：建表、数据保留、幂等、约束、端到端启动均通过 |
| 必须保住 `master.key` | 见 §29.5（手工数据操作时） |

### 35.6 全程只读

本节所有操作仅**读取** `D:\mcp`，未写入任何内容；生产库哈希 `17af6fab69586f4b` 与三进程创建时间均未变。
