import { createHash, randomUUID } from 'node:crypto';
import { normalizeObservation } from './adapters/runtime-observer.mjs';
import { isProcessAlive } from './core/process-liveness.mjs';
import {
  isMcpServiceId,
  LEGACY_SERVICES,
  orderRegisteredTargets,
  pinRegistrySnapshot,
  removalDecision,
  assertStoppedConnectionReceipt,
  mergeEnvironmentPatch,
  publicEnvironment,
  discoveryIdentity
} from './core/mcp-registry-policy.mjs';
import {
  publicBinding,
  publicUrl,
  isSensitiveName,
  isReservedServiceEnvName,
  isRecord
} from './adapters/mcp-binding.mjs';
import { buildInstanceId } from './core/concurrent-instances.mjs';

export class RegistryStoreError extends Error {
  constructor(message, status = 400, code = 'REGISTRY_ERROR') {
    super(message);
    this.name = 'RegistryStoreError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

const sensitiveName = (name) => isSensitiveName(name);

export function maskUrl(rawUrl) {
  try {
    return publicUrl(rawUrl);
  } catch {
    return rawUrl;
  }
}

function validateHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new RegistryStoreError('HTTP URL is required', 400, 'INVALID_URL');
  }
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new RegistryStoreError('Invalid HTTP URL format', 400, 'INVALID_URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new RegistryStoreError('URL protocol must be http or https', 400, 'INVALID_URL_PROTOCOL');
  }
  if (u.username || u.password) {
    throw new RegistryStoreError('URL userinfo not allowed, use encrypted headers', 400, 'USERINFO_NOT_ALLOWED');
  }
}

function validateExecutable(exe) {
  if (typeof exe !== 'string' || !exe.trim() || exe.includes('\0')) {
    throw new RegistryStoreError('Executable must be a non-empty string', 400, 'INVALID_EXECUTABLE');
  }
}

function validateAndParseArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return [];
  if (!Array.isArray(rawArgs)) {
    throw new RegistryStoreError('Args must be an array', 400, 'INVALID_ARGS');
  }
  return rawArgs.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.includes('\0')) {
      throw new RegistryStoreError('Arg id must be a non-empty string', 400, 'INVALID_ARG_ID');
    }
    if (typeof item.value !== 'string' || item.value.includes('\0')) {
      throw new RegistryStoreError(`Arg '${item.id}' must have a string value`, 400, 'INVALID_ARG_VALUE');
    }
    const isSecret = sensitiveName(item.id) || item.secret !== false;
    return {
      id: item.id.trim(),
      value: item.value,
      secret: isSecret
    };
  });
}

function validateAndParseHeaders(rawHeaders) {
  if (rawHeaders === undefined || rawHeaders === null) return {};
  if (!isRecord(rawHeaders)) {
    throw new RegistryStoreError('Headers must be a record object', 400, 'INVALID_HTTP_HEADERS');
  }
  const result = {};
  for (const [name, entry] of Object.entries(rawHeaders)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
      throw new RegistryStoreError(`Invalid header name: ${name}`, 400, 'INVALID_HEADER_NAME');
    }
    let value = '';
    let secret = true;
    if (typeof entry === 'object' && entry !== null) {
      if (typeof entry.value !== 'string' || entry.value.includes('\0')) {
        throw new RegistryStoreError(`Header '${name}' must have a string value`, 400, 'INVALID_HEADER_VALUE');
      }
      value = entry.value;
      secret = sensitiveName(name) || entry.secret !== false;
    } else if (typeof entry === 'string') {
      if (entry.includes('\0')) {
        throw new RegistryStoreError(`Header '${name}' contains null byte`, 400, 'INVALID_HEADER_VALUE');
      }
      value = entry;
      secret = sensitiveName(name) || true;
    } else {
      throw new RegistryStoreError(`Header '${name}' has invalid value`, 400, 'INVALID_HEADER_VALUE');
    }
    result[name] = { value, secret };
  }
  return result;
}

function mergeHeadersPatch(previous = {}, patch = []) {
  if (!Array.isArray(patch)) {
    throw new RegistryStoreError('Invalid headers patch', 400, 'INVALID_HEADERS_PATCH');
  }
  const result = structuredClone(previous);
  for (const item of patch) {
    if (!item || typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.name)) {
      throw new RegistryStoreError('Invalid header name', 400, 'INVALID_HEADER_NAME');
    }
    const name = item.name;
    if (item.op === 'remove') {
      delete result[name];
      continue;
    }
    if (item.value !== undefined) {
      if (typeof item.value !== 'string' || item.value.includes('\0')) {
        throw new RegistryStoreError('Invalid header value', 400, 'INVALID_HEADER_VALUE');
      }
      result[name] = {
        value: item.value,
        secret: sensitiveName(name) || item.secret !== false
      };
    } else if (result[name]) {
      if (item.secret !== undefined) {
        result[name].secret = sensitiveName(name) || item.secret !== false;
      }
    } else {
      throw new RegistryStoreError(`New header '${name}' must have a value`, 400, 'HEADER_VALUE_REQUIRED');
    }
  }
  return result;
}

function mergeHeadersObject(previous = {}, headersObj = {}) {
  if (!isRecord(headersObj)) {
    throw new RegistryStoreError('Headers must be a record object', 400, 'INVALID_HTTP_HEADERS');
  }
  const result = structuredClone(previous);
  for (const [name, entry] of Object.entries(headersObj)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
      throw new RegistryStoreError(`Invalid header name: ${name}`, 400, 'INVALID_HEADER_NAME');
    }
    if (entry === null || entry?.op === 'remove') {
      delete result[name];
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      if (entry.value !== undefined) {
        result[name] = {
          value: String(entry.value),
          secret: sensitiveName(name) || entry.secret !== false
        };
      } else if (result[name]) {
        if (entry.secret !== undefined) {
          result[name].secret = sensitiveName(name) || entry.secret !== false;
        }
      } else {
        throw new RegistryStoreError(`New header '${name}' must have a value`, 400, 'HEADER_VALUE_REQUIRED');
      }
    } else {
      result[name] = {
        value: String(entry),
        secret: sensitiveName(name) || true
      };
    }
  }
  return result;
}

function formatPublicBinding(binding) {
  if (!binding || typeof binding !== 'object') return null;
  const pub = publicBinding(binding);
  return pub || { type: String(binding.type) };
}

function formatPublicEnvironment(environment) {
  if (!environment || typeof environment !== 'object') return [];
  if (Array.isArray(environment)) {
    return environment.map(entry => {
      if (!entry || typeof entry !== 'object') return entry;
      const name = entry.name;
      const secret = sensitiveName(name) || entry.secret !== false;
      if (secret) {
        return { name, secret: true, configured: Boolean(entry.configured ?? true) };
      }
      return {
        name,
        secret: false,
        configured: Boolean(entry.configured ?? true),
        ...(entry.value !== undefined ? { value: entry.value } : {})
      };
    });
  }
  return publicEnvironment(environment);
}

function formatPublicLocations(locations) {
  if (!locations || typeof locations !== 'object') return {};
  const safe = {};
  if (locations.sourceConfigPath) safe.sourceConfigPath = String(locations.sourceConfigPath);
  if (locations.effectiveConfigPath !== undefined) safe.effectiveConfigPath = locations.effectiveConfigPath;
  if (locations.installationRoot !== undefined) safe.installationRoot = locations.installationRoot;
  if (locations.executable) safe.executable = String(locations.executable);
  if (locations.cwd) safe.cwd = String(locations.cwd);
  if (locations.managerStorePath) safe.managerStorePath = String(locations.managerStorePath);
  return safe;
}

export function formatTunnelClientDto(tc, serviceId = null) {
  if (!tc || typeof tc !== 'object') {
    return {
      state: 'unobserved',
      managed: false,
      pid: null,
      startedAt: null,
      profileId: null,
      operationId: null,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 90000).toISOString(),
      reasonCode: 'external_process_unobserved',
      lastExitCode: null
    };
  }
  const VALID_STATES = new Set(['running', 'stopped', 'starting', 'stopping', 'restarting', 'failed', 'unmanaged', 'unobserved']);
  const state = VALID_STATES.has(tc.state) ? tc.state : 'unobserved';
  return {
    state,
    managed: Boolean(tc.managed ?? (state !== 'unmanaged')),
    pid: Number.isSafeInteger(tc.pid) && tc.pid > 0 ? tc.pid : null,
    startedAt: typeof tc.startedAt === 'string' ? tc.startedAt : null,
    profileId: typeof tc.profileId === 'string' ? tc.profileId : null,
    operationId: typeof tc.operationId === 'string' ? tc.operationId : null,
    observedAt: typeof tc.observedAt === 'string' ? tc.observedAt : (typeof tc.observedAt === 'number' ? new Date(tc.observedAt).toISOString() : new Date().toISOString()),
    expiresAt: typeof tc.expiresAt === 'string' ? tc.expiresAt : (typeof tc.expiresAt === 'number' ? new Date(tc.expiresAt).toISOString() : new Date(Date.now() + 90000).toISOString()),
    reasonCode: typeof tc.reasonCode === 'string' ? tc.reasonCode : 'not_observed',
    lastExitCode: Number.isInteger(tc.lastExitCode) ? tc.lastExitCode : null
  };
}

function formatRuntime(serviceId, serviceRevision, runtime, observer = null) {
  let observation;
  if (runtime?.observation) {
    observation = normalizeObservation(runtime.observation);
  } else if (observer && typeof observer.peek === 'function') {
    observation = observer.peek(serviceId, serviceRevision);
  } else {
    observation = normalizeObservation(null);
  }

  let tunnelClient = undefined;
  if (runtime?.tunnelClient !== undefined) {
    tunnelClient = formatTunnelClientDto(runtime.tunnelClient, serviceId);
  } else if (observer && typeof observer.peekTunnelClient === 'function') {
    tunnelClient = formatTunnelClientDto(observer.peekTunnelClient(serviceId), serviceId);
  }

  if (!runtime || typeof runtime !== 'object') {
    const res = {
      state: 'unknown',
      activeProfileRevision: null,
      activeServiceRevision: null,
      pendingApply: false,
      observation
    };
    if (tunnelClient !== undefined) res.tunnelClient = tunnelClient;
    return res;
  }
  const rawState = runtime.state || runtime.runtimeState || 'unknown';
  const state = ['running', 'stopped', 'starting', 'not_running', 'never_started'].includes(rawState)
    ? (rawState === 'starting' || rawState === 'running' ? 'running' : 'stopped')
    : (rawState || 'unknown');
  const activeProfileRevision = Number.isSafeInteger(runtime.activeProfileRevision)
    ? runtime.activeProfileRevision
    : null;
  const activeServiceRevision = Number.isSafeInteger(runtime.activeServiceRevision)
    ? runtime.activeServiceRevision
    : null;
  const pendingApply = Boolean(
    runtime.pendingApply ||
    (activeServiceRevision !== null && activeServiceRevision !== serviceRevision)
  );
  const res = {
    state,
    activeProfileRevision,
    activeServiceRevision,
    pendingApply,
    observation
  };
  if (tunnelClient !== undefined) res.tunnelClient = tunnelClient;
  // Additive (contract §4): the console reads `mcp.runtime.instances` to render the
  // per-account rows, so this MUST be forwarded from the runtime provider. It was
  // being dropped here, which left the UI with an always-empty instance list even
  // though `instance_runtime` held the rows. Absent => `[]`, never undefined, so
  // callers can iterate unconditionally.
  res.instances = Array.isArray(runtime?.instances) ? runtime.instances : [];
  return res;
}

function formatPublicService(row, def, runtime, observer = null) {
  const isDeleted = Boolean(row.deleted_at);
  const dto = {
    id: row.id,
    label: row.label,
    enabled: Boolean(row.enabled),
    revision: row.revision,
    sortOrder: row.sort_order,
    controlCarrier: Boolean(row.control_carrier),
    binding: formatPublicBinding(def.binding),
    environment: formatPublicEnvironment(def.environment || {}),
    locations: formatPublicLocations(def.locations),
    runtime: formatRuntime(row.id, row.revision, runtime, observer),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (isDeleted) {
    dto.deletedAt = row.deleted_at;
  }
  return dto;
}

function formatPublicAction(row, extra = null) {
  if (!row) return null;
  const kind = extra?.action || extra?.kind || row.kind || 'stop';
  const profileId = extra?.profileId !== undefined ? extra.profileId : (row.profileId || null);
  const state = extra?.state || row.state;
  // Instance scope is additive: `null` for every legacy whole-service action, so
  // existing consumers that ignore it are unaffected. The `mcp_actions.instance_id`
  // column wins over any sealed-payload copy, so a payload that predates the
  // column can never fabricate a scope. Exposed under both names because the
  // runner/HTTP layers read either `instanceId` or `instance_id`.
  const instanceId = row.instance_id || extra?.instanceId || null;
  return {
    operationId: row.id,
    id: row.id,
    kind,
    action: kind,
    profileId,
    instanceId,
    instance_id: instanceId,
    serviceId: row.service_id,
    state,
    status: state,
    errorCode: extra?.errorCode !== undefined ? extra.errorCode : (row.error_code || null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function computeStopFingerprint(serviceId, expectedRevision) {
  const norm = JSON.stringify({
    action: 'stop',
    serviceId: String(serviceId),
    expectedRevision: expectedRevision !== undefined && expectedRevision !== null ? Number(expectedRevision) : null
  });
  return createHash('sha256').update(norm).digest('hex');
}

function computeLifecycleActionFingerprint(action, serviceId, profileId, expectedRevision, instanceId = null) {
  const norm = {
    action: String(action),
    serviceId: String(serviceId),
    profileId: profileId ? String(profileId) : null,
    expectedRevision: expectedRevision !== undefined && expectedRevision !== null ? Number(expectedRevision) : null
  };
  // Additive + backward compatible: the key is only added when an instance is
  // addressed, so fingerprints persisted by previous releases stay byte-identical
  // and in-flight idempotency keys keep replaying instead of colliding.
  // It IS present for instance actions, so two profiles of one service cannot
  // reuse one idempotency key.
  if (instanceId) norm.instanceId = String(instanceId);
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

/**
 * Decides what the REMOVAL guard may believe about a service's runtime.
 *
 * Why this exists: `remove()` used to read `rt.runtimeState`, which the store
 * derives from the legacy `active_profiles` pointer alone. A pointer left behind
 * by a tunnel that died outside the console therefore read as `running` forever:
 * removal returned 409 MCP_RUNNING, the UI advised "stop it first", that advice
 * landed on an ALREADY_STOPPED noop (which never cleared the pointer), and the
 * service could never be deleted.
 *
 * Rules, in priority order (blocking evidence first):
 *   1. ANY instance row that holds a live pid blocks removal, whatever state that
 *      row records -- a real tunnel must never be archived.
 *   2. A declared transition blocks, and so does a `running` row with no pid: a
 *      missing pid is an UNRESOLVED claim, never a dead process.
 *   3. Over the observation channels (observer row, then the DTO's tunnelClient),
 *      ALL blocking evidence is evaluated before ANY permitting evidence: a live
 *      pid, a declared transition, or an unresolved `running` claim anywhere in
 *      that set wins over a `stopped` / dead-pid row sitting beside it. Reaching
 *      the permitting checks therefore means the whole set was already consulted.
 *   4. Synthetic placeholders (`synthetic: true`, emitted when the observer has
 *      no row or its observation expired), a missing observation, an unknown
 *      identity, and an empty instance array are NOT absence proof on their own.
 *   5. Only then may a non-synthetic `stopped` row or a pid that genuinely no
 *      longer exists be read as absent, followed by the store's own pointer fact
 *      ("no active profile") plus the absence of any live instance pid.
 *
 * Everything else resolves to `unknown`, and `removalDecision` keeps rejecting
 * it with 409 RUNTIME_STATE_UNKNOWN instead of deleting on a guess.
 */
export function resolveRemovalRuntimeState({ serviceId, rt, observer, isAlive = isProcessAlive } = {}) {
  const pidOf = (row) => {
    const pid = Number(row?.pid);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  };
  const rows = Array.isArray(rt?.instances) ? rt.instances.filter(row => row && typeof row === 'object') : [];

  // Blocking pass 1 -- EVERY row, not just `running`/`starting`. Filtering by state
  // here let a row that still carried a live pid under unmanaged/stopped/failed be
  // skipped; the permitting evidence that followed then allowed the deletion.
  const liveRow = rows.find(row => isAlive(pidOf(row)));
  if (liveRow) return { state: 'running', evidence: 'instance_pid_alive' };

  if (rt?.state === 'running' || rt?.state === 'starting') {
    // Legacy/explicit DTO claim: a claim may always BLOCK, never permit.
    return { state: rt.state, evidence: 'dto_state_claim' };
  }

  const transitionRow = rows.find(row => ['starting', 'stopping', 'restarting'].includes(row.state));
  if (transitionRow) return { state: 'starting', evidence: 'instance_transition' };

  // Blocking pass 2 -- a `running` row without a pid is unresolved, not absent.
  // It must be rejected BEFORE any observation is allowed to permit.
  if (rows.some(row => row.state === 'running' && pidOf(row) === null)) {
    return { state: 'unknown', evidence: 'instance_running_without_pid' };
  }

  let observed = null;
  try {
    observed = typeof observer?.peekTunnelClient === 'function' ? observer.peekTunnelClient(serviceId) : null;
  } catch (_) {
    observed = null;
  }
  // Every real observation channel, collected up front so the permitting checks
  // below cannot run before the blocking ones have seen the WHOLE set. Previously
  // the loop returned on the first candidate, so a `stopped` or dead-pid row hid a
  // live / unresolved / transitioning claim sitting right behind it.
  const candidates = [observed, rt?.tunnelClient]
    .filter(c => c && typeof c === 'object' && c.synthetic !== true);

  // Blocking pass 3a -- a live pid anywhere in the set wins.
  for (const candidate of candidates) {
    const pid = pidOf(candidate);
    if (pid && isAlive(pid)) return { state: 'running', evidence: 'observation_pid_alive' };
  }
  // Blocking pass 3b -- a declared transition anywhere in the set wins.
  for (const candidate of candidates) {
    if (['starting', 'stopping', 'restarting'].includes(candidate.state)) {
      return { state: 'starting', evidence: 'observation_transition' };
    }
  }
  // Blocking pass 3c -- a `running` claim with no usable pid is unresolved.
  // Reading it as "the pid died" would DELETE a service the observer still
  // reports as running, so it may only ever block here (never permit).
  for (const candidate of candidates) {
    if (candidate.state === 'running' && pidOf(candidate) === null) {
      return { state: 'running', evidence: 'observation_running_without_pid' };
    }
  }

  // Permitting pass -- reached only after 3a/3b/3c saw the entire set, so no
  // blocking evidence can be hiding behind the row examined here.
  for (const candidate of candidates) {
    if (candidate.state === 'running' || candidate.state === 'starting') {
      const pid = pidOf(candidate);
      if (pid) {
        // Observed running with a real pid that no longer exists: converged to absent.
        return { state: 'stopped', evidence: 'observation_dead_pid' };
      }
      continue;
    }
    if (candidate.state === 'stopped') {
      // Every real writer of a service-keyed `stopped` row does so only AFTER an
      // authoritative absence check (a verified stop receipt, or an inspection
      // that reported running === false), and `peekTunnelClient` already labels
      // the rows it INVENTED with `synthetic: true`, which is filtered out above.
      // main.mjs is one such writer and does not set the flag, so demanding the
      // flag here would strand a genuinely-verified absence as `unknown` and
      // re-open the removal deadlock this function exists to break.
      return { state: 'stopped', evidence: 'observation_stopped' };
    }
  }

  if (rt?.state === 'stopped' && !rows.some(row => isAlive(pidOf(row)))) {
    return { state: 'stopped', evidence: 'dto_state_stopped_no_live_pid' };
  }

  const anyLiveInstance = rows.some(row => isAlive(pidOf(row)));
  if (rows.length > 0 && rows.every(row => pidOf(row) !== null && !isAlive(pidOf(row)))) {
    // Every instance row carries a REAL pid that no longer exists: those claims
    // have converged to absent. Rows WITHOUT a pid are deliberately excluded --
    // a missing identity is "unobserved", not "verified gone", so it may not
    // become absence proof (plan: synthetic / missing observation / unknown
    // identity / an empty instance array are never proof of stopped).
    return { state: 'stopped', evidence: 'instance_pids_absent' };
  }

  const pointerAbsent = ['stopped', 'not_running', 'never_started'].includes(rt?.runtimeState);
  if (!anyLiveInstance && pointerAbsent) {
    return { state: 'stopped', evidence: 'pointer_absent_no_live_process' };
  }

  return { state: 'unknown', evidence: 'no_absence_evidence' };
}

export function attachRegistry({
  db,
  vault,
  withWriteTransaction,
  getGlobalRevision,
  bumpGlobalRevision,
  assertIdle,
  getServiceRuntime,
  clearActiveService,
  observer: initialObserver = null,
  maxPendingActions: maxPendingActionsOption = 64,
  reservedCriticalActions: reservedCriticalActionsOption = 8
}) {
  let observer = initialObserver;
  const maxPendingActions = Number.isSafeInteger(maxPendingActionsOption) && maxPendingActionsOption >= 0
    ? maxPendingActionsOption : 64;
  const reservedCriticalActions = Number.isSafeInteger(reservedCriticalActionsOption)
    && reservedCriticalActionsOption >= 0 ? reservedCriticalActionsOption : 8;

  function assertActionQueueCapacity(serviceDef) {
    let row;
    try {
      row = db.prepare("SELECT COUNT(*) AS n FROM mcp_actions WHERE state = 'QUEUED'").get();
    } catch (_) {
      // An unreadable queue must not be treated as empty.
      throw new RegistryStoreError('Action queue capacity could not be verified', 503, 'ACTION_QUEUE_UNVERIFIED');
    }
    const pending = Number(row?.n ?? 0);
    const limit = maxPendingActions + (serviceDef?.controlCarrier ? reservedCriticalActions : 0);
    if (Number.isFinite(pending) && pending >= limit) {
      throw new RegistryStoreError(`Action queue full (${pending}/${limit})`, 429, 'ACTION_QUEUE_FULL');
    }
  }
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('attachRegistry requires a synchronous SQLite db (node:sqlite DatabaseSync)');
  }
  if (!vault || typeof vault.seal !== 'function' || typeof vault.unseal !== 'function') {
    throw new TypeError('attachRegistry requires a vault instance with seal and unseal methods');
  }

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_services (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 500,
      control_carrier INTEGER NOT NULL DEFAULT 0,
      sealed_definition TEXT NOT NULL,
      provenance_identity TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_services_provenance
      ON mcp_services(provenance_identity)
      WHERE provenance_identity IS NOT NULL;

    CREATE TABLE IF NOT EXISTS mcp_actions (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      idempotency_key TEXT,
      request_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'QUEUED',
      error_code TEXT,
      sealed_payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_actions_idempotency
      ON mcp_actions(idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('revision', '0');
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('recovery_gated', '0');
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('recovery_reason', '');

    -- Instance-scoped recovery gates (see src/store.mjs). Declared here too so a
    -- registry store opened on its own never writes to a missing table.
    CREATE TABLE IF NOT EXISTS recovery_gates (
      scope TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Additive migrations for existing databases (must be no-ops on fresh DBs).
  // `instance_id` scopes a lifecycle action to ONE concurrent profile instance;
  // NULL keeps the legacy whole-service semantics byte-identical.
  try {
    db.exec('ALTER TABLE mcp_actions ADD COLUMN instance_id TEXT;');
  } catch (_) {}
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mcp_actions_service_instance
        ON mcp_actions (service_id, instance_id);
    `);
  } catch (_) {}

  // Initial legacy seeding: only seed if absent and never tombstoned
  const now = new Date().toISOString();
  for (const legacy of LEGACY_SERVICES) {
    const existing = db.prepare('SELECT id FROM mcp_services WHERE id = ?').get(legacy.id);
    if (!existing) {
      const def = {
        id: legacy.id,
        label: legacy.id === 'overleaf-mcp' ? 'Overleaf MCP' : 'Antigravity MCP',
        enabled: legacy.enabled !== false,
        revision: 1,
        sortOrder: legacy.sortOrder ?? 500,
        controlCarrier: Boolean(legacy.controlCarrier),
        binding: {
          type: 'stdio',
          executable: legacy.id === 'overleaf-mcp' ? 'node' : 'antigravity-mcp',
          args: []
        },
        environment: {},
        locations: {
          installationRoot: null
        },
        deletedAt: null
      };
      const sealed = vault.seal(def, JSON.stringify(['mcp-service', legacy.id, 1, 'definition-v1']));
      const sealedText = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
      db.prepare(`
        INSERT INTO mcp_services (
          id, label, enabled, revision, sort_order, control_carrier,
          sealed_definition, provenance_identity, deleted_at, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(
        def.id,
        def.label,
        def.enabled ? 1 : 0,
        def.sortOrder,
        def.controlCarrier ? 1 : 0,
        sealedText,
        now,
        now
      );
    }
  }

  // Fallbacks for optional callbacks
  const runWriteTransaction = withWriteTransaction || (fn => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const res = fn();
      db.exec('COMMIT;');
      return Promise.resolve(res);
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      return Promise.reject(err);
    }
  });

  const readGlobalRevision = typeof getGlobalRevision === 'function'
    ? getGlobalRevision
    : () => {
        const row = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
        return row ? parseInt(row.value, 10) : 0;
      };

  const incrementGlobalRevision = typeof bumpGlobalRevision === 'function'
    ? bumpGlobalRevision
    : () => {
        const current = readGlobalRevision();
        const next = current + 1;
        db.prepare("UPDATE metadata SET value = ? WHERE key = 'revision'").run(String(next));
        return next;
      };

  const fetchServiceRuntime = typeof getServiceRuntime === 'function'
    ? getServiceRuntime
    : () => null;

  const handleClearActiveService = (serviceId) => {
    if (typeof clearActiveService === 'function') {
      clearActiveService(serviceId);
    }
    try {
      db.prepare('DELETE FROM active_profiles WHERE service_id = ?').run(serviceId);
    } catch {}
  };

  const handleSetActiveService = (serviceId, profileId, profileRevision = null, serviceRevision = null) => {
    try {
      let resolvedProfileRev = profileRevision;
      if (resolvedProfileRev === null || resolvedProfileRev === undefined) {
        const pRow = db.prepare('SELECT revision FROM profiles WHERE id = ?').get(profileId);
        resolvedProfileRev = pRow && typeof pRow.revision === 'number' ? pRow.revision : 1;
      }
      let resolvedServiceRev = serviceRevision;
      if (resolvedServiceRev === null || resolvedServiceRev === undefined) {
        const sRow = db.prepare('SELECT revision FROM mcp_services WHERE id = ?').get(serviceId);
        resolvedServiceRev = sRow && typeof sRow.revision === 'number' ? sRow.revision : 1;
      }
      db.prepare(`
        INSERT INTO active_profiles (service_id, profile_id, profile_revision, service_revision)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(service_id) DO UPDATE SET
          profile_id = excluded.profile_id,
          profile_revision = excluded.profile_revision,
          service_revision = excluded.service_revision
      `).run(serviceId, profileId, resolvedProfileRev, resolvedServiceRev);
    } catch {}
  };

  // Synchronous read helpers
  function getDefinition(id, { includeDeleted = false } = {}) {
    if (typeof id !== 'string' || !id) return null;
    const row = db.prepare('SELECT * FROM mcp_services WHERE id = ?').get(id);
    if (!row) return null;
    if (row.deleted_at && !includeDeleted) return null;
    const def = vault.unseal(
      row.sealed_definition,
      JSON.stringify(['mcp-service', row.id, row.revision, 'definition-v1'])
    );
    def.id = row.id;
    def.label = row.label;
    def.enabled = Boolean(row.enabled);
    def.revision = row.revision;
    def.sortOrder = row.sort_order;
    def.controlCarrier = Boolean(row.control_carrier);
    def.deletedAt = row.deleted_at || null;
    return def;
  }

  function listDefinitions({ includeDeleted = false } = {}) {
    const query = includeDeleted
      ? 'SELECT * FROM mcp_services ORDER BY control_carrier ASC, sort_order ASC, id ASC'
      : 'SELECT * FROM mcp_services WHERE deleted_at IS NULL ORDER BY control_carrier ASC, sort_order ASC, id ASC';
    const rows = db.prepare(query).all();
    return rows.map(row => {
      const def = vault.unseal(
        row.sealed_definition,
        JSON.stringify(['mcp-service', row.id, row.revision, 'definition-v1'])
      );
      def.id = row.id;
      def.label = row.label;
      def.enabled = Boolean(row.enabled);
      def.revision = row.revision;
      def.sortOrder = row.sort_order;
      def.controlCarrier = Boolean(row.control_carrier);
      def.deletedAt = row.deleted_at || null;
      return def;
    });
  }

  function listServices({ includeDeleted = false } = {}) {
    const query = includeDeleted
      ? 'SELECT * FROM mcp_services ORDER BY control_carrier ASC, sort_order ASC, id ASC'
      : 'SELECT * FROM mcp_services WHERE deleted_at IS NULL ORDER BY control_carrier ASC, sort_order ASC, id ASC';
    const rows = db.prepare(query).all();
    return rows.map(row => {
      const def = vault.unseal(
        row.sealed_definition,
        JSON.stringify(['mcp-service', row.id, row.revision, 'definition-v1'])
      );
      const rt = fetchServiceRuntime(row.id);
      return formatPublicService(row, def, rt, observer);
    });
  }

  function snapshot(targetIds, expectedRevision) {
    const currentGlobalRev = readGlobalRevision();
    const services = listDefinitions({ includeDeleted: false });
    return pinRegistrySnapshot(targetIds, { services, revision: currentGlobalRev }, expectedRevision);
  }

  // Internal helper to validate and insert a service record (used by create and importDefinition)
  function insertServiceRecord(input, { provenance } = {}) {
    if (!input || typeof input !== 'object') {
      throw new RegistryStoreError('Service input must be an object', 400, 'INVALID_INPUT');
    }

    let id;
    if (input.id) {
      if (!isMcpServiceId(input.id)) {
        throw new RegistryStoreError(`Invalid MCP service ID '${input.id}'`, 400, 'INVALID_MCP_ID');
      }
      const existing = db.prepare('SELECT id FROM mcp_services WHERE id = ?').get(input.id);
      if (existing) {
        throw new RegistryStoreError(`MCP '${input.id}' already exists`, 409, 'MCP_ALREADY_EXISTS');
      }
      id = input.id;
    } else {
      id = 'mcp_' + randomUUID().replace(/-/g, '');
      if (!isMcpServiceId(id)) {
        throw new RegistryStoreError('Failed to generate valid service ID', 500, 'ID_GENERATION_FAILED');
      }
    }

    const label = (input.label && String(input.label).trim()) || id;
    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : true;
    const sortOrder = Number.isSafeInteger(input.sortOrder) ? input.sortOrder : 500;
    const controlCarrier = Boolean(input.controlCarrier);

    // Binding validation
    const rawBinding = input.binding || { type: 'stdio', executable: 'node', args: [] };
    if (typeof rawBinding !== 'object') {
      throw new RegistryStoreError('Binding is required and must be an object', 400, 'INVALID_BINDING');
    }

    let binding;
    if (rawBinding.type === 'stdio') {
      validateExecutable(rawBinding.executable);
      const args = validateAndParseArgs(rawBinding.args);
      binding = {
        type: 'stdio',
        executable: rawBinding.executable.trim(),
        args
      };
      if (rawBinding.cwd && typeof rawBinding.cwd === 'string' && !rawBinding.cwd.includes('\0')) {
        binding.cwd = rawBinding.cwd;
      }
    } else if (rawBinding.type === 'http') {
      validateHttpUrl(rawBinding.url);
      const headers = validateAndParseHeaders(rawBinding.headers);
      binding = {
        type: 'http',
        url: rawBinding.url,
        headers
      };
    } else {
      throw new RegistryStoreError(`Unsupported binding type: ${rawBinding.type}`, 400, 'UNSUPPORTED_BINDING_TYPE');
    }

    // Environment handling
    let environment = {};
    if (Array.isArray(input.environmentPatch)) {
      for (const item of input.environmentPatch) {
        if (item && isReservedServiceEnvName(item.name)) {
          throw new RegistryStoreError(`Reserved environment name: ${item.name}`, 400, 'RESERVED_ENV_NAME');
        }
      }
      environment = mergeEnvironmentPatch({}, input.environmentPatch);
    } else if (Array.isArray(input.environment)) {
      for (const item of input.environment) {
        if (item && isReservedServiceEnvName(item.name)) {
          throw new RegistryStoreError(`Reserved environment name: ${item.name}`, 400, 'RESERVED_ENV_NAME');
        }
      }
      environment = mergeEnvironmentPatch({}, input.environment);
    } else if (input.environment && typeof input.environment === 'object') {
      const patch = Object.entries(input.environment).map(([name, v]) => {
        if (isReservedServiceEnvName(name)) {
          throw new RegistryStoreError(`Reserved environment name: ${name}`, 400, 'RESERVED_ENV_NAME');
        }
        if (typeof v === 'object' && v !== null) {
          return { name, op: 'set', value: v.value ?? '', secret: v.secret };
        }
        return { name, op: 'set', value: String(v) };
      });
      environment = mergeEnvironmentPatch({}, patch);
    }

    const locations = (input.locations && typeof input.locations === 'object')
      ? structuredClone(input.locations)
      : {};

    const prov = provenance || input.provenance || null;
    let provIdentity = null;
    if (prov && prov.identity) {
      if (typeof prov.identity !== 'string' || !prov.identity.trim()) {
        throw new RegistryStoreError('Provenance identity must be a non-empty string', 400, 'INVALID_PROVENANCE');
      }
      const existingProv = db.prepare('SELECT id FROM mcp_services WHERE provenance_identity = ?').get(prov.identity);
      if (existingProv) {
        throw new RegistryStoreError(`Provenance identity '${prov.identity}' already exists`, 409, 'PROVENANCE_CONFLICT');
      }
      provIdentity = prov.identity;
    }

    const def = {
      id,
      label,
      enabled,
      revision: 1,
      sortOrder,
      controlCarrier,
      binding,
      environment,
      locations,
      ...(prov ? { provenance: prov } : {}),
      deletedAt: null
    };

    const sealed = vault.seal(def, JSON.stringify(['mcp-service', id, 1, 'definition-v1']));
    const sealedText = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
    const createdAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO mcp_services (
        id, label, enabled, revision, sort_order, control_carrier,
        sealed_definition, provenance_identity, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      label,
      enabled ? 1 : 0,
      sortOrder,
      controlCarrier ? 1 : 0,
      sealedText,
      provIdentity,
      createdAt,
      createdAt
    );

    const row = {
      id,
      label,
      enabled: enabled ? 1 : 0,
      revision: 1,
      sort_order: sortOrder,
      control_carrier: controlCarrier ? 1 : 0,
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null
    };

    return formatPublicService(row, def, fetchServiceRuntime(id), observer);
  }

  // Mutating Registry Methods (Promise-returning via runWriteTransaction)
  async function create(input, options = {}) {
    const expRev = options.expectedRevision ?? input?.expectedRevision;
    const prov = options.provenance ?? input?.provenance;

    return await runWriteTransaction(() => {
      if (expRev !== undefined && expRev !== null) {
        const currentRev = readGlobalRevision();
        if (expRev !== currentRev) {
          throw new RegistryStoreError(`Revision conflict: expected ${expRev}, global revision is ${currentRev}`, 409, 'REVISION_CONFLICT');
        }
      }

      const serviceDTO = insertServiceRecord(input, { provenance: prov });
      incrementGlobalRevision();
      return serviceDTO;
    });
  }

  async function update(id, patch = {}, options = {}) {
    const expRev = options.expectedRevision ?? patch?.expectedRevision;

    return await runWriteTransaction(() => {
      if (expRev !== undefined && expRev !== null) {
        const currentRev = readGlobalRevision();
        if (expRev !== currentRev) {
          throw new RegistryStoreError(`Revision conflict: expected ${expRev}, global revision is ${currentRev}`, 409, 'REVISION_CONFLICT');
        }
      }

      const row = db.prepare('SELECT * FROM mcp_services WHERE id = ?').get(id);
      if (!row || row.deleted_at) {
        throw new RegistryStoreError(`MCP '${id}' not found`, 404, 'MCP_NOT_FOUND');
      }

      const expServiceRev = options.expectedServiceRevision ?? options.serviceRevision ?? patch.expectedServiceRevision ?? patch.serviceRevision;
      if (expServiceRev !== undefined && expServiceRev !== null && expServiceRev !== row.revision) {
        throw new RegistryStoreError(`Service revision conflict: expected ${expServiceRev}, service revision is ${row.revision}`, 409, 'REVISION_CONFLICT');
      }

      const def = vault.unseal(
        row.sealed_definition,
        JSON.stringify(['mcp-service', id, row.revision, 'definition-v1'])
      );

      // Label update
      if (patch.label !== undefined) {
        const l = String(patch.label).trim();
        if (!l) {
          throw new RegistryStoreError('Label cannot be empty', 400, 'INVALID_LABEL');
        }
        def.label = l;
      }

      // Enabled update
      if (patch.enabled !== undefined) {
        def.enabled = Boolean(patch.enabled);
      }

      // Binding update
      if (patch.binding !== undefined) {
        const pb = patch.binding;
        if (!pb || typeof pb !== 'object') {
          throw new RegistryStoreError('Binding must be an object', 400, 'INVALID_BINDING');
        }

        if (def.binding.type === 'stdio') {
          if (pb.type && pb.type !== 'stdio') {
            throw new RegistryStoreError('Cannot change binding type on update', 400, 'INVALID_BINDING_TYPE');
          }
          if (pb.executable !== undefined) {
            validateExecutable(pb.executable);
            def.binding.executable = pb.executable.trim();
          }
          if (pb.cwd !== undefined) {
            if (pb.cwd === null || pb.cwd === '') {
              delete def.binding.cwd;
            } else if (typeof pb.cwd === 'string' && !pb.cwd.includes('\0')) {
              def.binding.cwd = pb.cwd;
            }
          }
          if (pb.args !== undefined) {
            if (!Array.isArray(pb.args)) {
              throw new RegistryStoreError('Args must be an array', 400, 'INVALID_ARGS');
            }
            const existingArgs = Array.isArray(def.binding.args) ? def.binding.args : [];
            const existingMap = new Map(existingArgs.map(a => [a.id, a]));
            const nextArgs = [];
            for (const item of pb.args) {
              if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.includes('\0')) {
                throw new RegistryStoreError('Arg id must be a non-empty string', 400, 'INVALID_ARG_ID');
              }
              const argId = item.id.trim();
              const match = existingMap.get(argId);
              let value;
              if (item.value !== undefined) {
                if (typeof item.value !== 'string' || item.value.includes('\0')) {
                  throw new RegistryStoreError(`Arg '${argId}' value must be a string`, 400, 'INVALID_ARG_VALUE');
                }
                value = item.value;
              } else if (match) {
                value = match.value;
              } else {
                throw new RegistryStoreError(`New arg '${argId}' must provide a value`, 400, 'ARG_VALUE_REQUIRED');
              }
              const isSecret = sensitiveName(argId) || (item.secret !== undefined ? item.secret !== false : (match ? match.secret !== false : true));
              nextArgs.push({ id: argId, value, secret: isSecret });
            }
            def.binding.args = nextArgs;
          }
        } else if (def.binding.type === 'http') {
          if (pb.type && pb.type !== 'http') {
            throw new RegistryStoreError('Cannot change binding type on update', 400, 'INVALID_BINDING_TYPE');
          }
          if (pb.url !== undefined) {
            validateHttpUrl(pb.url);
            def.binding.url = pb.url;
          }
          if (pb.headersPatch !== undefined) {
            def.binding.headers = mergeHeadersPatch(def.binding.headers || {}, pb.headersPatch);
          } else if (pb.headers !== undefined) {
            if (Array.isArray(pb.headers)) {
              def.binding.headers = mergeHeadersPatch(def.binding.headers || {}, pb.headers);
            } else if (isRecord(pb.headers)) {
              def.binding.headers = mergeHeadersObject(def.binding.headers || {}, pb.headers);
            } else {
              throw new RegistryStoreError('Headers must be a record object', 400, 'INVALID_HTTP_HEADERS');
            }
          }
        }
      }

      // Environment update
      if (patch.environmentPatch !== undefined) {
        if (Array.isArray(patch.environmentPatch)) {
          for (const item of patch.environmentPatch) {
            if (item && isReservedServiceEnvName(item.name)) {
              throw new RegistryStoreError(`Reserved environment name: ${item.name}`, 400, 'RESERVED_ENV_NAME');
            }
          }
        }
        def.environment = mergeEnvironmentPatch(def.environment || {}, patch.environmentPatch);
      } else if (patch.environment !== undefined) {
        if (Array.isArray(patch.environment)) {
          for (const item of patch.environment) {
            if (item && isReservedServiceEnvName(item.name)) {
              throw new RegistryStoreError(`Reserved environment name: ${item.name}`, 400, 'RESERVED_ENV_NAME');
            }
          }
          def.environment = mergeEnvironmentPatch(def.environment || {}, patch.environment);
        } else if (typeof patch.environment === 'object') {
          const p = Object.entries(patch.environment).map(([name, v]) => {
            if (isReservedServiceEnvName(name)) {
              throw new RegistryStoreError(`Reserved environment name: ${name}`, 400, 'RESERVED_ENV_NAME');
            }
            if (v === null || (typeof v === 'object' && v.op === 'remove')) {
              return { name, op: 'remove' };
            }
            if (typeof v === 'object' && v !== null) {
              return { name, op: 'set', value: v.value ?? '', secret: v.secret };
            }
            return { name, op: 'set', value: String(v) };
          });
          def.environment = mergeEnvironmentPatch(def.environment || {}, p);
        }
      }

      // Locations update
      if (patch.locations !== undefined && typeof patch.locations === 'object') {
        def.locations = { ...(def.locations || {}), ...patch.locations };
      }

      const nextRevision = row.revision + 1;
      def.revision = nextRevision;

      const sealed = vault.seal(def, JSON.stringify(['mcp-service', id, nextRevision, 'definition-v1']));
      const sealedText = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);
      const updatedAt = new Date().toISOString();

      db.prepare(`
        UPDATE mcp_services
        SET label = ?, enabled = ?, revision = ?, sealed_definition = ?, updated_at = ?
        WHERE id = ?
      `).run(
        def.label,
        def.enabled ? 1 : 0,
        nextRevision,
        sealedText,
        updatedAt,
        id
      );

      incrementGlobalRevision();

      if (observer && typeof observer.invalidate === 'function') {
        observer.invalidate(id);
      }

      const updatedRow = {
        ...row,
        label: def.label,
        enabled: def.enabled ? 1 : 0,
        revision: nextRevision,
        updated_at: updatedAt
      };

      return formatPublicService(updatedRow, def, fetchServiceRuntime(id), observer);
    });
  }

  async function remove(id, options = {}) {
    const expRev = options.expectedRevision;

    return await runWriteTransaction(() => {
      if (expRev !== undefined && expRev !== null) {
        const currentRev = readGlobalRevision();
        if (expRev !== currentRev) {
          throw new RegistryStoreError(`Revision conflict: expected ${expRev}, global revision is ${currentRev}`, 409, 'REVISION_CONFLICT');
        }
      }

      const row = db.prepare('SELECT * FROM mcp_services WHERE id = ?').get(id);
      if (!row || row.deleted_at) {
        throw new RegistryStoreError(`MCP '${id}' not found`, 404, 'MCP_NOT_FOUND');
      }

      const def = vault.unseal(
        row.sealed_definition,
        JSON.stringify(['mcp-service', id, row.revision, 'definition-v1'])
      );

      const rt = fetchServiceRuntime(id);
      // The runtime DTO is a set of CLAIMS: {runtimeState, activeProfileId,
      // instances} carries no live process fact, and `runtimeState` is derived
      // from the legacy active-profiles pointer alone. Reading it directly made
      // a pointer left by a dead tunnel look "running" forever. Resolve instead
      // from the real observer plus a synchronous liveness pass over every
      // instance row; see resolveRemovalRuntimeState for the evidence rules.
      const runtimeState = resolveRemovalRuntimeState({
        serviceId: id,
        rt,
        observer
      }).state;

      let busy = false;
      if (typeof assertIdle === 'function') {
        try {
          assertIdle();
        } catch {
          busy = true;
        }
      }
      const activeAction = db.prepare(
        "SELECT 1 FROM mcp_actions WHERE service_id = ? AND state IN ('QUEUED', 'APPLYING')"
      ).get(id);
      if (activeAction) {
        busy = true;
      }

      const decision = removalDecision({ service: def, runtimeState, busy });
      if (!decision.allowed) {
        const status = decision.code === 'MCP_NOT_FOUND' ? 404 : 409;
        throw new RegistryStoreError(decision.code, status, decision.code);
      }

      const now = new Date().toISOString();
      const nextRevision = row.revision + 1;
      def.deletedAt = now;
      def.revision = nextRevision;

      const sealed = vault.seal(def, JSON.stringify(['mcp-service', id, nextRevision, 'definition-v1']));
      const sealedText = typeof sealed === 'string' ? sealed : JSON.stringify(sealed);

      db.prepare(`
        UPDATE mcp_services
        SET deleted_at = ?, revision = ?, sealed_definition = ?, updated_at = ?
        WHERE id = ?
      `).run(now, nextRevision, sealedText, now, id);

      handleClearActiveService(id);
      incrementGlobalRevision();
      if (observer && typeof observer.invalidate === 'function') {
        observer.invalidate(id);
      }

      return {
        success: true,
        id
      };
    });
  }

  async function importDefinition(input, options = {}) {
    const prov = options.provenance || input?.provenance;
    if (!prov || typeof prov.identity !== 'string' || !prov.identity.trim()) {
      throw new RegistryStoreError('Provenance with non-empty identity required', 400, 'INVALID_PROVENANCE');
    }

    return await runWriteTransaction(() => {
      const existing = db.prepare('SELECT * FROM mcp_services WHERE provenance_identity = ?').get(prov.identity);
      if (existing) {
        const def = vault.unseal(
          existing.sealed_definition,
          JSON.stringify(['mcp-service', existing.id, existing.revision, 'definition-v1'])
        );
        const rt = fetchServiceRuntime(existing.id);
        return {
          service: formatPublicService(existing, def, rt, observer),
          created: false
        };
      }

      const expRev = options.expectedRevision ?? input?.expectedRevision;
      if (expRev !== undefined && expRev !== null) {
        const currentRev = readGlobalRevision();
        if (expRev !== currentRev) {
          throw new RegistryStoreError(`Revision conflict: expected ${expRev}, global revision is ${currentRev}`, 409, 'REVISION_CONFLICT');
        }
      }

      if (input.id) {
        const existingById = db.prepare('SELECT id FROM mcp_services WHERE id = ?').get(input.id);
        if (existingById) {
          throw new RegistryStoreError(`Service '${input.id}' already exists and cannot be overwritten by import`, 409, 'CONFLICT');
        }
      }

      const serviceDTO = insertServiceRecord(input, { provenance: prov });
      incrementGlobalRevision();

      return {
        service: serviceDTO,
        created: true
      };
    });
  }

  // Lifecycle Actions (start, stop, restart)
  //
  // `instanceId` is OPTIONAL and additive (see
  // docs/analysis/concurrent-instances-contract.md §2.3):
  //   absent  -> legacy whole-service behaviour, byte-identical to before.
  //   present -> must equal buildInstanceId(serviceId, profileId), else
  //              INVALID_INSTANCE; the action then targets ONLY that instance and
  //              `stop` keeps its profileId so the right process is stopped.
  async function createLifecycleAction({
    action = 'stop',
    serviceId,
    profileId = null,
    instanceId = null,
    expectedRevision,
    idempotencyKey,
    carrierToken = null,
    sessionBinding = null
  } = {}) {
    if (!isMcpServiceId(serviceId)) {
      throw new RegistryStoreError(`Invalid service ID '${serviceId}'`, 400, 'INVALID_MCP_ID');
    }
    if (!['start', 'stop', 'restart'].includes(action)) {
      throw new RegistryStoreError(`Invalid lifecycle action '${action}'`, 400, 'INVALID_ACTION');
    }

    // Normalize the optional instance scope up front. An empty string is treated
    // as absent so `instanceId: ''` from a DTO cannot create a bogus scope.
    let resolvedInstanceId = null;
    if (instanceId !== null && instanceId !== undefined) {
      if (typeof instanceId !== 'string' || !instanceId) {
        throw new RegistryStoreError(`Invalid instance id '${instanceId}'`, 400, 'INVALID_INSTANCE');
      }
      resolvedInstanceId = instanceId;
      // The profile must be known NOW to verify the composite id; an instance
      // action can never fall back to the active profile (that would let the
      // caller target a different account than the one it named).
      if (!profileId) {
        throw new RegistryStoreError(
          `Profile required to address instance '${resolvedInstanceId}'`,
          400,
          'PROFILE_REQUIRED'
        );
      }
      let expectedInstanceId = null;
      try {
        expectedInstanceId = buildInstanceId(serviceId, profileId);
      } catch (_) {
        throw new RegistryStoreError(`Invalid instance id '${resolvedInstanceId}'`, 400, 'INVALID_INSTANCE');
      }
      if (expectedInstanceId !== resolvedInstanceId) {
        throw new RegistryStoreError(
          `instanceId '${resolvedInstanceId}' does not match service '${serviceId}' / profile '${profileId}'`,
          400,
          'INVALID_INSTANCE'
        );
      }
    }

    const fingerprint = computeLifecycleActionFingerprint(action, serviceId, profileId, expectedRevision, resolvedInstanceId);

    // 1. Initial idempotency check outside sync transaction
    if (idempotencyKey) {
      const existing = db.prepare('SELECT * FROM mcp_actions WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new RegistryStoreError('Idempotency key collision with different request payload', 409, 'IDEMPOTENCY_CONFLICT');
        }
        return publicAction(existing.id);
      }
    }

    // 2. Initial busy check outside transaction.
    // Contract §2.3: an instance-scoped action must not be blocked by a pending action
    // for a DIFFERENT instance. This pre-transaction check has to honour the same rule
    // as the in-transaction recheck below, otherwise it rejects before ever reaching it.
    if (typeof assertIdle === 'function') {
      assertIdle({ allowParallelInstanceAction: resolvedInstanceId });
    }

    // 3. Initial revision check outside transaction
    const currentGlobalRev = readGlobalRevision();
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== currentGlobalRev) {
      throw new RegistryStoreError(`Revision conflict: expected ${expectedRevision}, global revision is ${currentGlobalRev}`, 409, 'REVISION_CONFLICT');
    }

    // 4. Verify service exists and is not deleted
    const serviceRow = db.prepare('SELECT * FROM mcp_services WHERE id = ?').get(serviceId);
    if (!serviceRow || serviceRow.deleted_at) {
      throw new RegistryStoreError(`Service '${serviceId}' not found`, 404, 'MCP_NOT_FOUND');
    }

    const serviceDef = await vault.unseal(
      serviceRow.sealed_definition,
      JSON.stringify(['mcp-service', serviceId, serviceRow.revision, 'definition-v1'])
    );

    if (action !== 'stop' && serviceDef.enabled === false) {
      throw new RegistryStoreError(`Service '${serviceId}' is disabled`, 409, 'SERVICE_DISABLED');
    }

    // Bounded intake for NEW work. The runner executes actions serially, so an
    // unbounded QUEUED backlog only hides congestion. A control-carrier action
    // (server-side definition flag, never caller input) keeps a reserved slot so
    // the GPT control chain still gets through. Already accepted rows are never
    // dropped by this check.
    assertActionQueueCapacity(serviceDef);

    // Verify profile if start/restart
    let resolvedProfileId = profileId;
    if (action !== 'stop') {
      // An instance-scoped action always names its profile already (validated
      // above), so it must never fall back to the active-profile pointer.
      if (!resolvedProfileId && !resolvedInstanceId) {
        const actRow = db.prepare('SELECT profile_id FROM active_profiles WHERE service_id = ?').get(serviceId);
        resolvedProfileId = actRow?.profile_id || null;
      }
      if (!resolvedProfileId) {
        throw new RegistryStoreError(`Profile required to ${action} service '${serviceId}'`, 400, 'PROFILE_REQUIRED');
      }
      const profRow = db.prepare('SELECT * FROM profiles WHERE id = ?').get(resolvedProfileId);
      if (!profRow) {
        throw new RegistryStoreError(`Profile '${resolvedProfileId}' not found`, 404, 'PROFILE_NOT_FOUND');
      }
      const creds = JSON.parse(profRow.sealed_credentials || '{}');
      if (!creds[serviceId]) {
        throw new RegistryStoreError(`Profile '${resolvedProfileId}' has no credentials for '${serviceId}'`, 409, 'PROFILE_NOT_CONFIGURED');
      }
    } else if (resolvedInstanceId) {
      // Instance-scoped stop keeps its profileId so the right instance is
      // targeted, and only requires the profile to exist (credentials are not
      // needed just to stop a process, and may have been removed meanwhile).
      const profRow = db.prepare('SELECT id FROM profiles WHERE id = ?').get(String(resolvedProfileId));
      if (!profRow) {
        throw new RegistryStoreError(`Profile '${resolvedProfileId}' not found`, 404, 'PROFILE_NOT_FOUND');
      }
    }

    const registrySnapshot = {
      revision: currentGlobalRev,
      services: [structuredClone(serviceDef)]
    };

    const originalRuntime = fetchServiceRuntime(serviceId) || null;
    const actionId = 'act_' + randomUUID().replace(/-/g, '');

    const payloadObj = {
      action,
      kind: action,
      serviceId,
      profileId: resolvedProfileId,
      instanceId: resolvedInstanceId,
      expectedRevision,
      carrierToken,
      carrierContext: serviceDef?.controlCarrier ? {
        sessionBinding,
        idempotencyKey,
        serviceRevision: serviceRow.revision,
        profileId: resolvedProfileId,
        instanceId: resolvedInstanceId
      } : null,
      sessionBinding,
      idempotencyKey,
      registrySnapshot,
      originalRuntime,
      operationId: actionId
    };

    const sealedPayload = await vault.seal(
      payloadObj,
      JSON.stringify(['mcp-action', actionId, serviceId, 'action-v1'])
    );
    const sealedPayloadText = typeof sealedPayload === 'string' ? sealedPayload : JSON.stringify(sealedPayload);

    return await runWriteTransaction(() => {
      // Recheck idempotency inside sync transaction
      if (idempotencyKey) {
        const existing = db.prepare('SELECT * FROM mcp_actions WHERE idempotency_key = ?').get(idempotencyKey);
        if (existing) {
          if (existing.request_fingerprint !== fingerprint) {
            throw new RegistryStoreError('Idempotency key collision with different request payload', 409, 'IDEMPOTENCY_CONFLICT');
          }
          return publicAction(existing.id);
        }
      }

      // Recheck busy inside sync transaction.
      // Contract §2.3: an instance-scoped action may queue alongside OTHER instances;
      // only a legacy whole-service action or an action on the SAME instance conflicts.
      if (typeof assertIdle === 'function') {
        assertIdle({ allowParallelInstanceAction: resolvedInstanceId });
      }

      // Recheck revision inside sync transaction
      const latestRev = readGlobalRevision();
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== latestRev) {
        throw new RegistryStoreError(`Revision conflict: expected ${expectedRevision}, global revision is ${latestRev}`, 409, 'REVISION_CONFLICT');
      }

      // Recheck capacity inside the transaction: concurrent callers can race the
      // pre-check, and the last one must see the true QUEUED count.
      assertActionQueueCapacity(serviceDef);

      const now = new Date().toISOString();
      try {
        db.prepare(`
          INSERT INTO mcp_actions (
            id, service_id, idempotency_key, request_fingerprint,
            state, error_code, sealed_payload, instance_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'QUEUED', NULL, ?, ?, ?, ?)
        `).run(
          actionId,
          serviceId,
          idempotencyKey || null,
          fingerprint,
          sealedPayloadText,
          resolvedInstanceId,
          now,
          now
        );
      } catch (err) {
        if (idempotencyKey) {
          const existing = db.prepare('SELECT * FROM mcp_actions WHERE idempotency_key = ?').get(idempotencyKey);
          if (existing) {
            if (existing.request_fingerprint !== fingerprint) {
              throw new RegistryStoreError('Idempotency key collision with different request payload', 409, 'IDEMPOTENCY_CONFLICT');
            }
            return publicAction(existing.id);
          }
        }
        throw err;
      }

      return {
        operationId: actionId,
        id: actionId,
        kind: action,
        action,
        profileId: resolvedProfileId,
        instanceId: resolvedInstanceId,
        instance_id: resolvedInstanceId,
        serviceId,
        state: 'QUEUED',
        status: 'QUEUED',
        errorCode: null,
        createdAt: now,
        updatedAt: now
      };
    });
  }

  async function createStopAction({ serviceId, profileId = null, instanceId = null, expectedRevision, idempotencyKey } = {}) {
    // Legacy callers pass neither profileId nor instanceId: the action stays a
    // whole-service stop whose payload profileId resolves to null, exactly as before.
    const args = { action: 'stop', serviceId, expectedRevision, idempotencyKey };
    if (profileId !== null && profileId !== undefined) args.profileId = profileId;
    if (instanceId !== null && instanceId !== undefined) args.instanceId = instanceId;
    return await createLifecycleAction(args);
  }

  function listPendingActionIds() {
    const rows = db.prepare(
      "SELECT id FROM mcp_actions WHERE state IN ('QUEUED', 'APPLYING') ORDER BY created_at ASC, id ASC"
    ).all();
    return rows.map(r => r.id);
  }

  function isActionId(id) {
    if (typeof id !== 'string' || !id) return false;
    const row = db.prepare('SELECT 1 FROM mcp_actions WHERE id = ?').get(id);
    return Boolean(row);
  }

  async function loadAction(id) {
    if (typeof id !== 'string' || !id) return null;
    const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
    if (!row) return null;
    let payload = null;
    try {
      payload = await vault.unseal(
        row.sealed_payload,
        JSON.stringify(['mcp-action', id, row.service_id, 'action-v1'])
      );
    } catch (_) {
      try {
        payload = await vault.unseal(
          row.sealed_payload,
          JSON.stringify(['mcp-action', id, row.service_id, 'stop-v1'])
        );
      } catch (_) {
        payload = {};
      }
    }
    const kind = payload?.action || payload?.kind || 'stop';
    // `instance_id` is the authoritative column (survives payload/seal changes);
    // the sealed payload is only a fallback for rows written before the column
    // existed. Both are surfaced so callers can read either spelling.
    const instanceId = row.instance_id || payload?.instanceId || null;
    return {
      operationId: row.id,
      id: row.id,
      kind,
      action: kind,
      profileId: payload?.profileId || null,
      instanceId,
      instance_id: instanceId,
      serviceId: row.service_id,
      state: row.state,
      status: row.state,
      errorCode: row.error_code || null,
      registrySnapshot: payload?.registrySnapshot,
      originalRuntime: payload?.originalRuntime,
      carrierToken: payload?.carrierToken || null,
      carrierContext: payload?.carrierContext || null,
      sessionBinding: payload?.sessionBinding || row.session_binding || null,
      idempotencyKey: payload?.idempotencyKey || row.idempotency_key || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function publicAction(id) {
    if (typeof id !== 'string' || !id) return null;
    const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
    if (!row) return null;
    let payload = null;
    try {
      payload = vault.unseal(
        row.sealed_payload,
        JSON.stringify(['mcp-action', id, row.service_id, 'action-v1'])
      );
      if (payload && typeof payload.then === 'function') payload = null;
    } catch (_) {
      try {
        payload = vault.unseal(
          row.sealed_payload,
          JSON.stringify(['mcp-action', id, row.service_id, 'stop-v1'])
        );
        if (payload && typeof payload.then === 'function') payload = null;
      } catch (_) {
        payload = {};
      }
    }
    return formatPublicAction(row, payload);
  }

  async function transitionAction(id, patch = {}) {
    return await runWriteTransaction(() => {
      const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
      if (!row) {
        throw new RegistryStoreError(`Action '${id}' not found`, 404, 'ACTION_NOT_FOUND');
      }
      const VALID_STATES = new Set(['QUEUED', 'APPLYING', 'SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION']);
      if (patch.state && !VALID_STATES.has(patch.state)) {
        throw new RegistryStoreError(`Invalid action state: ${patch.state}`, 400, 'INVALID_ACTION_STATE');
      }
      const nextState = patch.state || row.state;
      let nextErrorCode = row.error_code;
      if (patch.errorCode !== undefined) {
        nextErrorCode = patch.errorCode ? String(patch.errorCode) : null;
      }
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE mcp_actions
        SET state = ?, error_code = ?, updated_at = ?
        WHERE id = ?
      `).run(nextState, nextErrorCode, now, id);

      let payload = null;
      try {
        payload = vault.unseal(row.sealed_payload, JSON.stringify(['mcp-action', id, row.service_id, 'action-v1']));
      } catch (_) {
        try {
          payload = vault.unseal(row.sealed_payload, JSON.stringify(['mcp-action', id, row.service_id, 'stop-v1']));
        } catch (_) {}
      }

      return formatPublicAction(row, { ...payload, state: nextState, errorCode: nextErrorCode });
    });
  }

  async function finishStoppedAction(id, receipt) {
    return await finishLifecycleAction(id, receipt, { action: 'stop' });
  }

  async function finishLifecycleAction(id, receipt, { action = 'stop', profileId = null, instanceId = null } = {}) {
    return await runWriteTransaction(() => {
      const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
      if (!row) {
        throw new RegistryStoreError(`Action '${id}' not found`, 404, 'ACTION_NOT_FOUND');
      }
      // Stop receipts are always validated, whichever scope the action belongs to.
      if (action === 'stop') {
        assertStoppedConnectionReceipt(receipt, id, row.service_id);
      }
      // The legacy single-active pointer is ADVANCED ONLY by whole-service actions.
      // A concurrent instance action targets one profile of several that may run at
      // once, so it must never move (or clear) the pointer: doing so would report the
      // service as stopped while a tunnel is live, show the wrong active account, and
      // silently retarget a later legacy start that resolves its profile from here.
      if (!instanceId) {
        if (action === 'stop') {
          handleClearActiveService(row.service_id);
        } else if (profileId) {
          handleSetActiveService(row.service_id, profileId);
        }
      }

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE mcp_actions
        SET state = 'SUCCEEDED', error_code = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, id);

      incrementGlobalRevision();

      let payload = null;
      try {
        payload = vault.unseal(row.sealed_payload, JSON.stringify(['mcp-action', id, row.service_id, 'action-v1']));
      } catch (_) {
        try {
          payload = vault.unseal(row.sealed_payload, JSON.stringify(['mcp-action', id, row.service_id, 'stop-v1']));
        } catch (_) {}
      }

      return formatPublicAction(row, { ...payload, state: 'SUCCEEDED', errorCode: null });
    });
  }

  async function markActionAttention(id, safeCode) {
    return await runWriteTransaction(() => {
      const row = db.prepare('SELECT * FROM mcp_actions WHERE id = ?').get(id);
      if (!row) {
        throw new RegistryStoreError(`Action '${id}' not found`, 404, 'ACTION_NOT_FOUND');
      }
      const code = String(safeCode || 'STOP_ACTION_FAILED');
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE mcp_actions
        SET state = 'NEEDS_ATTENTION', error_code = ?, updated_at = ?
        WHERE id = ?
      `).run(code, now, id);

      const reason = `Action ${id} ended in NEEDS_ATTENTION: ${code}`;
      /*
       * Scope the gate to the instance that actually failed. A legacy action
       * (instance_id IS NULL) covers the whole service, so it keeps opening the
       * global gate; a concurrent instance action only gates its own instance and
       * leaves sibling accounts runnable.
       */
      const scopeInstanceId = row.instance_id || null;
      try {
        if (scopeInstanceId) {
          db.prepare(`
            INSERT INTO recovery_gates (scope, reason, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(scope) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at
          `).run(String(scopeInstanceId), reason, now);
        } else {
          db.prepare("UPDATE metadata SET value = '1' WHERE key = 'recovery_gated'").run();
          db.prepare("UPDATE metadata SET value = ? WHERE key = 'recovery_reason'").run(reason);
        }
      } catch {}

      return {
        operationId: row.id,
        id: row.id,
        kind: 'stop',
        profileId: null,
        serviceId: row.service_id,
        state: 'NEEDS_ATTENTION',
        errorCode: code,
        createdAt: row.created_at,
        updatedAt: now
      };
    });
  }

  return {
    listServices,
    listDefinitions,
    getDefinition,
    create,
    update,
    remove,
    snapshot,
    importDefinition,
    createStopAction,
    createLifecycleAction,
    listPendingActionIds,
    isActionId,
    loadAction,
    publicAction,
    transitionAction,
    finishStoppedAction,
    finishLifecycleAction,
    handleSetActiveService,
    handleClearActiveService,
    markActionAttention,
    setObserver: (obs) => { observer = obs; },
    getObserver: () => observer
  };
}
