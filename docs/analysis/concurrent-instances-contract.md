# Concurrent Multi-Profile Tunnel Instances — Interface Contract (v1)

Status: **frozen**. All workstreams code against this. Changes require Lead sign-off.

Branch: `feature/concurrent-account-tunnels` (from `final`)
Repo: `D:\mcp-tunnel-account-manager` (only)

---

## 0. Production safety red lines (non-negotiable, apply to every workstream)

1. NEVER kill/stop by process name (`taskkill /IM`, `Stop-Process -Name`, `pkill`). Only stops allowed:
   `process-control.ps1 -Action Stop -ProcessId <pid> -ExpectedExecutablePath <exe> -ExpectedCreationTimeFileTime <ft>`.
2. NEVER read/write `%APPDATA%\tunnel-client\*.yaml` (production profiles).
3. NEVER use `%LOCALAPPDATA%\McpTunnelAccountManager` (production data dir / `manager.db` / `master.key`).
   Dev/test/smoke use `%LOCALAPPDATA%\McpTunnelAccountManager-dev` or a temp dir.
4. NEVER bind port `17642`. NO fixed dev port is reserved: any port that is currently free may be
   used, and it must be passed explicitly with `--port <n>` (see §7). `17643` is NOT safe by default —
   on a machine with a second console deployed it is already occupied, which is exactly how the
   original acceptance command failed.
5. NEVER touch `D:\mcp`.
6. Tests/demo use FAKE tunnel processes only (`tests/fixtures/fake-tunnel-health.mjs`), never the real
   `tunnel-client.exe`, and never scan for pre-existing `tunnel-client.exe`.

---

## 1. Namespace (implemented — `src/core/concurrent-instances.mjs`)

```
instanceId      = `${serviceId}__${sanitizeProfileSegment(profileId)}`
profileYaml     = `${instanceProfileStem(serviceId)}_profile_${segment}.yaml`   e.g. antigravity_profile_userA.yaml
runtimeRecord   = `<dataDir>/runtime/${instanceId}-process.json`
runtimeIntent   = `<dataDir>/runtime/${instanceId}-intent.json`
profileDir      = `<dataDir>/instances/profiles`   (isolated; never %APPDATA%\tunnel-client)
```

Exports (already on disk, do not re-implement):
`INSTANCE_SEPARATOR`, `MAX_INSTANCES_PER_SERVICE`, `INSTANCE_FAILURE_CODES`, `InstanceFault`,
`sanitizeProfileSegment`, `buildInstanceId`, `parseInstanceId`, `isValidInstanceId`,
`assertInstanceTarget`, `instanceProfileStem`, `profileYamlFileName`, `instanceRecordFileName`,
`instanceProfileDir`, `decideInstanceAction`, `publicInstanceDTO`.

### Lifecycle policy (pure) — `decideInstanceAction(action, ctx)`

`action ∈ {start, stop, restart}`. `ctx` = server-verified facts only:

```js
{
  serviceId, profileId,
  snapshot: { state, owned, identityVerified, pid, startedAt, executablePath,
              absenceVerified, externalProcessPresent, observedAt },
  serviceEnabled, controlCarrier, carrierConfirmationVerified,
  eligibleProfileIds: string[], binaryAvailable,
  pendingOperationId,             // SAME instance only
  siblingRunningProfileIds: string[],  // INFORMATIONAL ONLY — never blocks
  nowMs
}
```

Returns `{decision:'reject',code}` | `{decision:'busy',code,operationId,instanceId}` |
`{decision:'noop',code,pid?,instanceId}` | `{decision:'enqueue',action,serviceId,profileId,instanceId,expectedIdentity,siblingProfileIds}`.

**Invariant:** a running sibling profile NEVER causes reject/noop for a different profile.

---

## 2. Store layer (owner: `store-model`)

### 2.1 New table `instance_runtime` (additive, in `src/store.mjs`)

```sql
CREATE TABLE IF NOT EXISTS instance_runtime (
  instance_id      TEXT PRIMARY KEY,
  service_id       TEXT NOT NULL,
  profile_id       TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'stopped',
  pid              INTEGER,
  started_at       TEXT,
  executable_path  TEXT,
  health_url       TEXT,
  local_port       INTEGER,
  profile_yaml_path TEXT,
  operation_id     TEXT,
  reason_code      TEXT,
  last_exit_code   INTEGER,
  observed_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_instance_runtime_service_profile ON instance_runtime(service_id, profile_id);
```

Existing `mcp_actions` gains additive column `instance_id TEXT` (+ index `(service_id, instance_id)`).
Migration must be `try { db.exec('ALTER TABLE ...') } catch {}` style, exactly like existing migrations,
so already-existing DBs upgrade in place.

### 2.2 `active_profiles` semantics — UNCHANGED

`active_profiles` remains the *single-active hot-switch* pointer (PK `service_id`).
Concurrent instances are tracked in `instance_runtime` only. This keeps
`commitSuccess` and the whole switching path byte-identical.

### 2.3 Registry lifecycle actions become instance-scoped

`createLifecycleAction({action, serviceId, profileId, instanceId?, expectedRevision, idempotencyKey, carrierToken, sessionBinding})`

- When `instanceId` is absent → **legacy behaviour, exactly as today** (`stop` keeps `profileId: null`).
- When `instanceId` present → must equal `buildInstanceId(serviceId, profileId)`; otherwise `INVALID_INSTANCE`.
- `stop` with `instanceId` keeps `profileId` (needed to target the right instance). Legacy `stop`
  without `instanceId` still resolves to `profileId: null` and stops the service's single instance.
- `request_fingerprint` must incorporate `instanceId` so idempotency keys cannot collide across instances.
- A pending action for instance A must NOT block instance B:
  `getActiveActionForService(serviceId, excludeActionId)` gains instance awareness — return a
  conflicting action only when it targets the SAME instance (or when it is a legacy
  whole-service action with no `instance_id`, which still conflicts with everything for that service).

New store methods (additive):
```
listInstanceRuntimes(serviceId)            // -> [{instanceId, serviceId, profileId, state, pid, startedAt, healthURL, localPort, maskedTunnelId, profileLabel, observedAt, reasonCode}]
getInstanceRuntime(instanceId)             // -> record | null
upsertInstanceRuntime(instanceId, patch)   // -> record
clearInstanceRuntime(instanceId)
listRunningInstanceProfileIds(serviceId)   // -> string[]
```
`maskedTunnelId` uses `maskTunnelId()` from `src/store.mjs`. Never return raw tunnel ids.

### 2.4 `getServiceRuntime(serviceId)` — must stay back-compatible

Returns the same shape as today, plus an optional additive `instances: [...]` array built from
`listInstanceRuntimes`. When there are no instance rows → `instances: []`. Existing callers ignore it.

### 2.5 Recovery gate is instance-scoped

The recovery gate refuses new work while some earlier work needs a human. It MUST be per-instance,
otherwise the first failing account paralyses every healthy sibling and the feature is pointless.

Rules:
- An action that ends `NEEDS_ATTENTION` and carries `instance_id` opens a gate scoped to
  **that instance only** (table `recovery_gates`, `scope = instanceId`).
- An action/operation with `instance_id IS NULL` (legacy whole-service work) opens the **global**
  gate (`metadata.recovery_gated`), which blocks every instance — a legacy action touches all accounts.
- `assertIdle()` consults the gate **for the caller's own scope**: a global gate blocks everyone;
  an instance gate blocks only that instance; a legacy whole-service caller is blocked by any gate.
- Acknowledging an instance action clears only its own gate.
- `getRecoveryState()` keeps returning `{gated:false}` byte-identically when nothing is gated, and
  adds an additive `instances: [{instanceId, reason}]` array when instance gates exist.

This was NOT the behaviour before: the gate was one global flag checked before any instance
filtering, so `NEEDS_ATTENTION` on account A refused `start` on account B with `RECOVERY_GATED`.

---

## 3. Adapter layer (owner: `adapter-instances`)

New file `src/adapters/instance-adapter.mjs`:

```js
export function createInstanceAdapter({
  serviceId, profileId, definition, dataDir, paths, probe, vault, processController, healthURL
}) -> InstanceAdapter
```

`InstanceAdapter` must expose the SAME method surface the lifecycle code already calls on
`ServiceAdapter` — `prepare`, `applyIfUnchanged`, `verifyDesired`, `stopConnection`, `inspect`,
plus `processController`, `processPath`, `paths`, `probe`, `service`, `instanceId`, `profileId` —
so `src/core/mcp-lifecycle.mjs` can drive it unchanged in shape.

Key differences from `ServiceAdapter`:

| Concern | Legacy `ServiceAdapter` | `InstanceAdapter` |
|---|---|---|
| configPath | `%APPDATA%\tunnel-client\<svc>.yaml` | `<dataDir>/instances/profiles/<stem>_profile_<seg>.yaml` |
| tunnel-client profile | `--profile overleaf` | `--profile-dir <dataDir>/instances/profiles --profile <stem>_profile_<seg>` |
| runtime record | `runtime/<svc>-process.json` | `runtime/<svc>__<seg>-process.json` |
| intent | `runtime/<svc>-intent.json` | `runtime/<svc>__<seg>-intent.json` |
| health port | shared/`0` | `--health.listen-addr 127.0.0.1:0` + `--health.url-file <runtime>/<instanceId>-health.url` |
| stop of siblings | n/a | **must never stop a sibling** — `stopConnection` may only stop `this.instanceId`'s verified process |

`prepare()` snapshot shape must remain compatible with `switch-core.mjs` assertions:
`{operationId, service, desiredKind, originalFingerprint, desiredFingerprint, originalConfig,
  desiredConfig:{yaml,env}, originalProcessIdentity, launchTemplate, credential, profileId, healthURL}`.

`stopConnection({operationId, serviceId, instanceId, originalRuntime})` returns
`{stopped:true, operationId, service, profileId, instanceId, proof:{kind:'verified-owned-process-exit'|'verified-already-stopped', identity?}}`.
`assertStoppedConnectionReceipt` in `mcp-registry-policy.mjs` must keep accepting the legacy shape —
add `instanceId` as an OPTIONAL extra field; do not tighten existing validation.

`inspect()` must read only this instance's runtime record, and must never fall back to
`FindOwned`-by-tag scanning of other profiles' processes for instance-scoped calls.

Registration: `src/adapters/index.mjs` gains
`createInstanceAdapterProvider({dataDir, vault, definitions?, processController?, probe?, paths?})`
returning `async (op, serviceId, profileId) => InstanceAdapter` with a cache keyed `instanceId`,
plus `.release(instanceId)` / `.clear()`.

**Production guard (`assertIsolatedInstanceDataDir`) must compare REAL paths.** A lexical
`path.resolve()` comparison is bypassable three ways on Windows — an 8.3 short name
(`MCPTUN~1`), a directory junction, and (historically) any subdirectory of the production data
dir, because that branch lacked the descendant test its sibling branch had. The guard resolves
candidate and root through `realResolve()` and requires `equal || descendant` for BOTH roots.
`tests/instance-guard-isolation.test.mjs` pins all three classes plus the no-over-blocking control.

**Backward compatibility:** `createAdapters()` / `createRegisteredAdapterProvider()` /
`ServiceAdapter` must behave EXACTLY as today (all 44 unit test files depend on them).

---

## 4. Lifecycle + HTTP (owner: `http-lifecycle`)

New file `src/core/instance-lifecycle.mjs`:

```js
export async function runInstanceLifecycleAction({repo, adapterProvider, actionId, vault})
```

Mirrors `runMcpLifecycleAction` but:
- loads the action's `instanceId` (required — else `INVALID_INSTANCE`);
- builds `ctx` for `decideInstanceAction`, including
  `siblingRunningProfileIds: await repo.listRunningInstanceProfileIds(serviceId)` (minus self);
- `pendingOperationId` only from actions targeting the SAME instance;
- after start/stop success, calls `repo.upsertInstanceRuntime(...)` / `repo.clearInstanceRuntime?`
  (stop → `state:'stopped'`, `pid:null`), and `observer.setTunnelClient(instanceId, ...)`
  alongside the legacy `setTunnelClient(serviceId, ...)` for the active-profile instance only;
- never mutates the legacy `active_profiles` pointer (that is switching's job).

New file `src/http/instance-routes.mjs`, wired from `src/server.mjs` (and it is fine to dispatch from
`mcp-routes.mjs` if simpler — pick ONE owner to avoid double-wiring):

```
GET  /api/mcps/:id/instances                     -> { serviceId, instances: [publicInstanceDTO...] }
POST /api/mcps/:id/instances/:profileId/start     -> 202 action DTO (or 200 noop)
POST /api/mcps/:id/instances/:profileId/stop      -> 202 action DTO (or 200 noop)
POST /api/mcps/:id/instances/:profileId/restart   -> 202 action DTO (or 200 noop)
```

Rules:
- `:profileId` is URL-decoded and validated with `sanitizeProfileSegment`; unknown profile → 404 `PROFILE_NOT_FOUND`.
- `POST` requires the same guard: `{write:true}` (CSRF) and `Idempotency-Key` header when the service is
  `controlCarrier` — identical to existing start/restart/stop handlers.
- Body: `{expectedRevision?, profileId? (must equal path), carrierToken?}`.
- Errors use existing `sendError(res, status, CODE)`; codes come from `INSTANCE_FAILURE_CODES`.
- Responses must never include raw tunnel ids, api keys, full YAML, or absolute production paths.

`/api/state` and `/api/mcps` must surface instances additively: each MCP DTO in
`repo.registry.listServices()` gains `runtime.instances: [publicInstanceDTO...]`; when absent → `[]`.
`GET /api/mcps/:id/instances` is the authoritative poll endpoint for the UI.

Legacy routes (`/api/mcps/:id/start|restart|stop`, `/api/switch`) stay byte-compatible.

---

## 5. Frontend (owner: `ui-instances`)

`public/app.js`, `public/index.html`, `public/app.css` only.

- Each MCP card gets a collapsible **多账号实例** section listing `mcp.runtime.instances`:
  per row show `profileLabel (profileId)`, state badge, `PID`, `隧道 ID` (already masked by server),
  `本地端口`/health, `启动时间`, and per-row `启动` / `停止` buttons.
- Row buttons call the §4 endpoints via the existing `apiRequest` helper, then poll
  `GET /api/mcps/:id/instances` (not `/api/operations/:id` exclusively) until the row's state settles.
- Reuse existing CSS classes/badges; add new classes prefixed `instance-` only. No inline `<style>`.
- All user-visible strings in Chinese, consistent with the rest of the console.
- Must keep existing behavior: single-profile hot-switch buttons, carrier confirmation flow,
  privacy/redaction (never render raw tunnel ids beyond what the server already masked).
- `tests/ui-registry.test.mjs` and `scripts/smoke-registry-ui.mjs` must keep passing; additive only.

---

## 6. Tests / smoke (owner: `tests-smoke`)

New tests (fake processes only, temp dirs only):
- `tests/core/concurrent-instances.test.mjs` — pure policy + namespace unit tests:
  `buildInstanceId`/`parseInstanceId`/`sanitizeProfileSegment`/`profileYamlFileName`,
  `decideInstanceAction` matrix incl. **sibling-running-never-blocks** and cap enforcement,
  `publicInstanceDTO` redaction.
- `tests/integration/concurrent-instances.e2e.test.mjs` — temp dataDir, synthetic registry,
  fake tunnel runtime command: start instance A, then start instance B for the SAME service,
  assert BOTH are `running` with distinct PIDs/ports/instances, then stop A only and assert
  B is still `running`; assert no production paths touched.

New script `scripts/smoke-concurrent-instances.mjs`:
- starts the console on the port given by `--port <n>` (defaults to 17643, which is only safe when
  free — see §0.4) with `-DataDirectory`/`--data-dir` = isolated dev dir,
- uses an isolated profile base (`%TEMP%\mcp-dev-profiles`),
- drives two concurrent fake accounts for one service via the HTTP API,
- prints a machine-readable summary `{port, dataDir, instances:[{instanceId,pid,state,localPort}], prodUntouched:true}`,
- on exit stops ONLY its own children via the audited helper, and asserts
  production `17642` + pre-existing `tunnel-client.exe` PIDs are unchanged (compare a
  before/after snapshot of `(pid, CreationTimeFileTime)` taken at start/end).
- refuses `--port 17642` outright, and rejects any non-integer / out-of-range value before it
  touches the filesystem, so a typo cannot half-start the demo.

---

## 7. Acceptance commands (Lead runs these)

```
node scripts/check.mjs
node scripts/run-tests.mjs --unit
node scripts/smoke-concurrent-instances.mjs --port <a free port>
```

`--port` is REQUIRED in practice. Pick any free port and confirm it first:

```
netstat -ano | findstr :<n>      # expect no output
```

Rules:
- `17642` is refused by the script itself (production console).
- **Any** port may already be occupied in this environment — `17643` is held by a second deployed
  console on a machine that has one. Never assume 17643 is free; always probe before starting.
- An occupied port fails fast at the bind probe with a clear error, so it is safe to retry with
  another port; nothing is left half-started.

All must pass with the production console on 17642 and existing tunnel-client processes
(PIDs recorded at session start) still alive and unchanged.
