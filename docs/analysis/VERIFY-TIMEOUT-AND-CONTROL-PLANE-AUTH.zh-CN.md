# 多服务原子切换时 Overleaf MCP 验证失败与控制平面认证判定审计报告

## 摘要

在对 `mcp-tunnel-account-manager` 进行多服务并发原子切换审计时，发现 Overleaf MCP 在切换时高频触发 `[VERIFY_FAILED / CONTROL_PLANE_NOT_AUTHENTICATED]` 并引发全局回滚。经系统性追踪，根因由四重叠加问题导致：
1. **证据门禁暂态误判**：`evaluateTunnelEvidence` 将 tunnel-client 刚启动、首次向控制面发起长轮询时的暂态（`status === 'unknown'`、`state === 'polling'`、`consecutive_failures === 0`）一概断定为 `CONTROL_PLANE_NOT_AUTHENTICATED`；
2. **显式端口下无轮询重试**：`verifyDesired` 中的 `canPollEphemeral` 在配置了显式 `healthURL` 时为 `false`，导致 `maxAttempts = 1`，进程启动后毫无缓冲即刻判定失败；
3. **轮询总预算严重不足**：动态端口模式下固定 120 次 × 150ms = 18s 的超时窗口，在多服务并发启动和经由网络代理连接 OpenAI 时极易越界；
4. **硬编码代理端口**：`DEFAULT_PROXY` 硬编码为 `7897`，忽略宿主 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，在非 7897 端口环境下导致网络握手必然延迟甚至超时。

---

## 1. 深度排查与代码级证据分析

### 1.1 `tunnel-health-evidence.mjs` 中 `evaluateTunnelEvidence` 的判定缺陷

源码文件：`src/adapters/tunnel-health-evidence.mjs` 第 84-93 行：

```javascript
const component = health.components?.['control-plane'];
const details = component?.details;
if (component?.status !== 'ok' || component.limited === true ||
    !['idle', 'polling', 'backpressured'].includes(component.state) ||
    details?.consecutive_failures !== 0 ||
    (details.http_status !== undefined && details.http_status !== 0) ||
    (component.reason_code !== undefined && component.reason_code !== '') ||
    (details.failure_category !== undefined && details.failure_category !== '')) {
  fail('CONTROL_PLANE_NOT_AUTHENTICATED');
}
```

#### 真实生命周期时序复盘
`tunnel-client 0.0.19` 启动时，其内部组件 `control-plane` 会经历以下阶段：
1. **启动中（Starting / Initializing）**：本地 HTTP 健康监听端口就绪，发起后台控制平面长轮询连接。此时 `component.status` 初始为 `"unknown"`，`component.state` 为 `"polling"`。
2. **尚未产生任何失败**：`details.consecutive_failures === 0`，`details.http_status === 0`（或未定义），`details.failure_category === ""`，`component.reason_code === ""`。
3. **首次响应返回**：只有当首个 HTTP 长轮询请求成功返回（通常需 5~15 秒），`component.status` 才更新为 `"ok"`，且记录 `last_success` 时间戳。

#### 问题分析
在阶段 1~2 时，没有任何凭证失效、密钥错误或网络拒绝的客观事实。然而，门禁函数无条件要求 `component?.status === 'ok'`，一旦为 `"unknown"` 即执行 `fail('CONTROL_PLANE_NOT_AUTHENTICATED')`。
这导致调用方无法区分“**正在进行首次握手与长轮询尚未返回（POLLING / INITIALIZING）**”与“**网络/凭据确实认证失败（401/403/consecutive_failures > 0）**”。

---

### 1.2 `adapters/index.mjs` 中 `verifyDesired` 的轮询缺陷

源码文件：`src/adapters/index.mjs` 第 1563-1615 行：

```javascript
const explicitHealthURL = this.healthURL || snapshot?.healthURL || null;
const canPollEphemeral = !explicitHealthURL && Boolean(this.probe?.isDefault) && typeof this.processController?.runtimeCommand !== 'function';
const maxAttempts = canPollEphemeral ? 120 : 1;
```

#### 缺陷 A：显式 Health URL 导致单次尝试（maxAttempts = 1）
如果适配器注入了静态端口（如 `overleafHealthURL`），`canPollEphemeral` 为 `false`，`maxAttempts` 被直接置为 `1`。
新子进程刚刚由 `launch` 启动，在 0 毫秒后被同步调用 `verifyDesired`，此时健康端口即便勉强响应，其控制面状态也必定是 `status: 'unknown'`。在 `maxAttempts = 1` 下，代码完全没有任何重试循环，直接将首次探针结果抛为 `SwitchFault('VERIFY_FAILED')`。

#### 缺陷 B：轮询总时间上限过窄（18 秒）
即便在 `canPollEphemeral = true` 的场景下：
- `120 次 × 150ms = 18,000ms = 18 秒`。
- 在实际国内网络环境下，通过代理访问 `api.openai.com` 建立长轮询长连接：
  - 子进程创建及本地初始化：1~2 秒
  - 代理 CONNECT 与 TLS 握手：2~4 秒
  - 控制平面注册与首个长轮询往返：8~12 秒
  - 单服务冷启动耗时通常在 11~18 秒之间浮动。
- 当发生多服务并发切换时（`switch-core.mjs` 使用 `Promise.all(Array.from({ length: 3 }, verifyNext))` 同时启动 3 个 tunnel-client）：
  - 3 个进程并发竞争本地代理网络连接、DNS 与系统资源；
  - 耗时通常拉长至 20~30 秒。
  - Overleaf MCP 极易在第 18 秒时刚处于首次长轮询的最后收尾阶段，轮询上限耗尽，最后一次错误 `CONTROL_PLANE_NOT_AUTHENTICATED` 触发，导致整体回滚。

---

### 1.3 代理适配机制审计

源码文件：`src/adapters/index.mjs` 第 31 行与第 1081 行：

```javascript
export const DEFAULT_PROXY = 'http://127.0.0.1:7897';
```
以及：
```javascript
serviceMcpEnv: {
  ...customEnv,
  HTTP_PROXY: DEFAULT_PROXY,
  HTTPS_PROXY: DEFAULT_PROXY,
  ALL_PROXY: DEFAULT_PROXY
}
```

#### 问题分析
代码中无条件使用硬编码的 `7897` 端口，完全未感知系统环境中的 `process.env.HTTPS_PROXY`、`HTTP_PROXY` 或 `ALL_PROXY`。
若用户的 Clash、v2ray 或内网代理运行在 `7890`、`10808` 或 `10809`，子进程将尝试连接不存在的 `7897`，造成 TCP 连接挂起或 Connection Refused，长轮询始终无法连通，加剧了超时误判。

---

## 2. 既有回归测试（Regression Tests）断言分析

对 `tests` 目录下所有涉及 `CONTROL_PLANE_NOT_AUTHENTICATED` 的 21 处测试用例进行了全面核查：
1. **`tests/tunnel-health-evidence.adversarial.test.mjs`**：
   - 包含对 `consecutive_failures > 0`、`http_status` 为 401/403/500/502、`failure_category` 非空、`reason_code` 非空、`limited === true`、`state` 为 backoff/failed/disconnected 等对抗场景的严格断言。
   - 要求当确实存在认证或网络失败证据时，必须断言 `CONTROL_PLANE_NOT_AUTHENTICATED`。
2. **`tests/integration/default-adapter.e2e.test.mjs`**：
   - 模拟真实 401 密钥错误（`apiKey: 'wrong-key-401'`），此时 `http_status === 401` 且 `consecutive_failures >= 1`，必须断言 `CONTROL_PLANE_NOT_AUTHENTICATED`。
3. **`tests/adapters.test.mjs`** 与 **`tests/core/switch-core.test.mjs`**：
   - 验证公开安全诊断白名单（`FAILURE_REASONS`）包含 `CONTROL_PLANE_NOT_AUTHENTICATED` 且安全脱敏。

**安全红线结论**：
任何修复方案**绝不能**直接移除或放宽既有的终态认证失败拦截逻辑。所有真实凭证错误（401/403、`consecutive_failures > 0`、非法状态码、非空 `failure_category` 等）必须 100% 保持抛出 `CONTROL_PLANE_NOT_AUTHENTICATED`，以确保所有 128 项安全门禁测试继续完全通过。

---

## 3. 代码级修复方案规范（供实施参考）

针对上述排查结果，提出以下规范化的三维修复方案：

### 规范 1：状态判定精准分级（区分瞬时轮询中与终态认证拒绝）
- 在 `evaluateTunnelEvidence` 或 `tunnel-probe.mjs` 中建立精确判定分类：
  - **明确认证/凭据失败（Definite Auth Failure）**：
    当满足以下任一条件时，判定为终端认证失败，抛出 `CONTROL_PLANE_NOT_AUTHENTICATED`：
    - `details?.consecutive_failures > 0`
    - `details?.http_status !== 0` 且 `details?.http_status !== undefined`
    - `details?.failure_category` 存在且非空
    - `component?.reason_code` 存在且非空
    - `component?.status` 处于 `'degraded'`, `'error'`, `'unhealthy'` 等非正常状态
    - `component?.state` 处于 `'failed'`, `'stopped'`, `'disconnected'`, `'backoff'`
  - **首次握手长轮询中间态（Transient Handshake In Progress）**：
    当且仅当：
    - `component?.status === 'unknown'`（或非 `'ok'`）
    - `component?.state === 'polling'`（或合法初始状态）
    - `details?.consecutive_failures === 0`
    - `details?.http_status === 0` 或 `undefined`
    - `details?.failure_category === ''` 或 `undefined`
    - `component?.reason_code === ''` 或 `undefined`
    此状态属于可重试的中间等待态。在探针/适配器层将其识别为 `HANDSHAKE_IN_PROGRESS` / `POLLING_IN_PROGRESS`，指示 `verifyDesired` 应当继续轮询等待，而非视为不可逆的凭据错误。

### 规范 2：`verifyDesired` 轮询预算重构与显式端口适配
- **支持显式 Health URL 的轮询**：
  移除 `!explicitHealthURL` 作为 `canPollEphemeral` 的硬前置条件。无论是动态端口还是显式配置的健康端口，在刚启动时均需要等待控制平面握手完成。
- **轮询预算拓宽与渐进退避**：
  - 将最大超时预算从 18 秒扩充至 **45 秒**（例如 `maxAttempts = 150`，轮询间隔支持 200~300ms，或总时限 45,000ms 的 deadline 机制）。
  - 在多服务并发切换（最多 3 个服务同时启动）的场景下，为首轮长轮询预留充裕的 TLS/代理/控制面握手时间窗口。
  - 只有在超时耗尽后仍停留在中间态时，才作为未就绪失败处理；若中途出现 `consecutive_failures > 0` 或 401 等明确错误，则可立即 fast-fail，无需盲目等待。

### 规范 3：宿主代理环境变量动态感知
- 重构代理注入逻辑：
  定义动态代理提取工具函数：
  ```javascript
  export function resolveDefaultProxy(explicitProxy = null) {
    if (explicitProxy && typeof explicitProxy === 'string') return explicitProxy;
    return process.env.HTTPS_PROXY ||
           process.env.HTTP_PROXY ||
           process.env.ALL_PROXY ||
           DEFAULT_PROXY;
  }
  ```
- 在 `_buildLaunchTemplate` 及环境变量组装阶段，优先采用 `resolveDefaultProxy()` 解析出的代理地址，无缝适配用户机器上的 Clash、v2ray 等多样化代理环境。
