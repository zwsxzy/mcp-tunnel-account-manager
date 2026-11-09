/**
 * Concurrent multi-profile tunnel instances (pure core).
 *
 * This module is the single source of truth for the composite instance namespace
 * that lets the manager run SEVERAL tunnel-client processes for ONE MCP service,
 * each bound to a different account/profile:
 *
 *   instanceId = `${serviceId}__${sanitizedProfileId}`
 *
 * Design constraints (must stay pure + deterministic):
 *  - No filesystem, no network, no timers, no process effects. Allowed to be
 *    imported by adapters, stores, routes, the runner and tests alike.
 *  - Never mutates its inputs.
 *  - Never leaks credentials: nothing here reads or returns tunnel_id/api_key.
 *  - Sibling instances of the same service are INFORMATIONAL ONLY. A running
 *    sibling must never block starting/stopping another profile's instance;
 *    that is the whole point of this feature.
 *
 * The legacy single-active-profile switching model keeps using
 * tunnel-client-lifecycle.mjs (decideTunnelClientAction) untouched.
 */

export const INSTANCE_SEPARATOR = '__';

/** Hard cap so one service cannot spawn unbounded tunnel processes. */
export const MAX_INSTANCES_PER_SERVICE = 8;

const ACTIONS = new Set(['start', 'stop', 'restart']);
const TRANSITIONS = new Set(['starting', 'stopping', 'restarting']);
const TERMINAL_ABSENT = new Set(['stopped', 'failed']);

/** Bounded, deterministic failure codes usable as public diagnostics. */
export const INSTANCE_FAILURE_CODES = Object.freeze([
  'INVALID_ACTION',
  'INVALID_INSTANCE',
  'INVALID_SERVICE',
  'INVALID_PROFILE',
  'OPERATION_IN_PROGRESS',
  'STATE_REFRESH_REQUIRED',
  'EXTERNAL_CLIENT_NOT_MANAGED',
  'STATE_UNVERIFIED',
  'PROCESS_IDENTITY_MISMATCH',
  'ALREADY_RUNNING',
  'ALREADY_STOPPED',
  'CARRIER_CONFIRMATION_REQUIRED',
  'SERVICE_DISABLED',
  'PROFILE_REQUIRED',
  'PROFILE_NOT_CONFIGURED',
  'EXECUTABLE_NOT_FOUND',
  'INSTANCE_LIMIT_REACHED'
]);

export class InstanceFault extends Error {
  constructor(code, message = null) {
    super(message || code);
    this.name = 'InstanceFault';
    this.code = INSTANCE_FAILURE_CODES.includes(code) ? code : 'INVALID_INSTANCE';
  }
}

const SERVICE_ID_RE = /^(?:mcp_[a-z0-9][a-z0-9_-]{0,63}|[a-z0-9][a-z0-9_-]{0,63})$/;

function isServiceId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 && SERVICE_ID_RE.test(value);
}

/**
 * Normalizes a profile id into a filesystem- and filename-safe segment.
 * Deterministic: same input always yields the same output.
 * UUIDs and ordinary account ids survive unchanged; anything exotic is folded
 * to `_` and the result is bounded so it cannot overflow MAX_PATH budgets.
 */
export function sanitizeProfileSegment(profileId) {
  if (profileId === null || profileId === undefined) return '';
  const raw = String(profileId).trim();
  if (!raw) return '';
  const folded = raw
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  return folded.slice(0, 64);
}

/** Builds the composite instance id. Throws InstanceFault on unusable input. */
export function buildInstanceId(serviceId, profileId) {
  if (!isServiceId(serviceId)) throw new InstanceFault('INVALID_SERVICE');
  const segment = sanitizeProfileSegment(profileId);
  if (!segment) throw new InstanceFault('INVALID_PROFILE');
  return `${serviceId}${INSTANCE_SEPARATOR}${segment}`;
}

/**
 * Parses a composite instance id.
 * Returns {instanceId, serviceId, profileSegment} or null when malformed.
 * Note: profileSegment is the SANITIZED segment; the authoritative profile id
 * always comes from the store record, never from a filename.
 */
export function parseInstanceId(instanceId) {
  if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 160) return null;
  const at = instanceId.indexOf(INSTANCE_SEPARATOR);
  if (at <= 0) return null;
  const serviceId = instanceId.slice(0, at);
  const profileSegment = instanceId.slice(at + INSTANCE_SEPARATOR.length);
  if (!isServiceId(serviceId)) return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(profileSegment)) return null;
  return { instanceId, serviceId, profileSegment };
}

export function isValidInstanceId(instanceId) {
  return parseInstanceId(instanceId) !== null;
}

/** Composite check used by routes before any effect. */
export function assertInstanceTarget({ serviceId, profileId, instanceId } = {}) {
  if (!isServiceId(serviceId)) throw new InstanceFault('INVALID_SERVICE');
  if (!sanitizeProfileSegment(profileId)) throw new InstanceFault('INVALID_PROFILE');
  const expected = buildInstanceId(serviceId, profileId);
  if (instanceId && instanceId !== expected) throw new InstanceFault('INVALID_INSTANCE');
  return { instanceId: expected, serviceId, profileId: String(profileId), profileSegment: sanitizeProfileSegment(profileId) };
}

/**
 * Base stem used for per-instance file naming.
 * `antigravity-mcp` -> `antigravity` so generated YAML matches the documented
 * `antigravity_profile_<account>.yaml` convention.
 */
export function instanceProfileStem(serviceId) {
  if (!isServiceId(serviceId)) throw new InstanceFault('INVALID_SERVICE');
  const stem = serviceId.replace(/-mcp$/i, '').replace(/^mcp_/i, '');
  return stem || serviceId;
}

/**
 * Isolated per-account profile YAML filename, e.g. `antigravity_profile_userA.yaml`.
 * These files live in an isolated profile directory and are NEVER the production
 * `%APPDATA%\tunnel-client\<service>.yaml` files.
 */
export function profileYamlFileName(serviceId, profileId) {
  const stem = instanceProfileStem(serviceId);
  const segment = sanitizeProfileSegment(profileId);
  if (!segment) throw new InstanceFault('INVALID_PROFILE');
  return `${stem}_profile_${segment}.yaml`;
}

/** Per-instance runtime record/intent filenames (inside <dataDir>/runtime). */
export function instanceRecordFileName(serviceId, profileId, kind = 'process') {
  const id = buildInstanceId(serviceId, profileId);
  if (kind !== 'process' && kind !== 'intent' && kind !== 'health') {
    throw new InstanceFault('INVALID_INSTANCE');
  }
  return `${id}-${kind}.json`;
}

/**
 * Profile directory for concurrent instances.
 * Callers pass an isolated base (dev/test MUST pass a non-production path).
 */
export function instanceProfileDir(baseDir) {
  if (typeof baseDir !== 'string' || !baseDir) throw new InstanceFault('INVALID_INSTANCE');
  return baseDir.replace(/[\\/]+$/, '');
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Pure per-instance lifecycle decision.
 *
 * ctx (SERVER-VERIFIED facts only, never trusted request fields):
 *   serviceId, profileId, instanceId
 *   snapshot: {
 *     state: 'running'|'stopped'|'failed'|'starting'|'stopping'|'restarting'|'unmanaged'|'unobserved',
 *     owned, identityVerified, pid, startedAt, executablePath,
 *     absenceVerified, externalProcessPresent, observedAt
 *   }
 *   serviceEnabled, controlCarrier, carrierConfirmationVerified,
 *   eligibleProfileIds[], binaryAvailable,
 *   pendingOperationId (same instance only),
 *   siblingRunningProfileIds[] (INFORMATIONAL, never blocking),
 *   nowMs
 *
 * Returns:
 *   { decision:'reject', code }
 *   { decision:'noop', code, pid?, instanceId }
 *   { decision:'enqueue', action, serviceId, profileId, instanceId,
 *     expectedIdentity, siblingProfileIds }
 */
export function decideInstanceAction(action, ctx) {
  const reject = (code) => ({ decision: 'reject', code });

  if (!ACTIONS.has(action)) return reject('INVALID_ACTION');
  if (!ctx || typeof ctx !== 'object') return reject('INVALID_INSTANCE');

  const { serviceId, profileId } = ctx;
  if (!isServiceId(serviceId)) return reject('INVALID_SERVICE');
  if (!sanitizeProfileSegment(profileId)) return reject('INVALID_PROFILE');

  let instanceId;
  try {
    instanceId = buildInstanceId(serviceId, profileId);
  } catch {
    return reject('INVALID_PROFILE');
  }

  const siblings = Array.isArray(ctx.siblingRunningProfileIds)
    ? ctx.siblingRunningProfileIds.filter(id => typeof id === 'string' && id !== String(profileId))
    : [];

  if (ctx.pendingOperationId) {
    return { decision: 'busy', code: 'OPERATION_IN_PROGRESS', operationId: ctx.pendingOperationId, instanceId };
  }

  const snap = ctx.snapshot;
  const observed = typeof snap?.observedAt === 'number' ? snap.observedAt : Date.parse(snap?.observedAt);
  const now = ctx.nowMs ?? Date.now();
  if (!snap || !Number.isFinite(observed) || observed > now + 5000 || now - observed > 10000) {
    return reject('STATE_REFRESH_REQUIRED');
  }

  if (snap.state === 'unmanaged' || snap.externalProcessPresent === true) {
    return reject('EXTERNAL_CLIENT_NOT_MANAGED');
  }
  if (TRANSITIONS.has(snap.state)) return reject('OPERATION_IN_PROGRESS');

  const live = snap.state === 'running';
  const absent = TERMINAL_ABSENT.has(snap.state) && snap.absenceVerified === true;
  if (!live && !absent) return reject('STATE_UNVERIFIED');

  if (live && (snap.owned !== true || snap.identityVerified !== true ||
      !positiveInt(snap.pid) || !snap.startedAt || !snap.executablePath)) {
    return reject('PROCESS_IDENTITY_MISMATCH');
  }

  // A running instance of THIS profile is a no-op; running SIBLINGS never are.
  if (action === 'start' && live) {
    return { decision: 'noop', code: 'ALREADY_RUNNING', pid: snap.pid, instanceId };
  }
  if (action === 'stop' && absent) {
    return { decision: 'noop', code: 'ALREADY_STOPPED', instanceId };
  }

  if ((action === 'stop' || action === 'restart') && ctx.controlCarrier &&
      ctx.carrierConfirmationVerified !== true) {
    return reject('CARRIER_CONFIRMATION_REQUIRED');
  }

  if (action !== 'stop') {
    if (!ctx.serviceEnabled) return reject('SERVICE_DISABLED');
    if (!Array.isArray(ctx.eligibleProfileIds) ||
        !ctx.eligibleProfileIds.some(id => String(id) === String(profileId))) {
      return reject('PROFILE_NOT_CONFIGURED');
    }
    if (ctx.binaryAvailable !== true) return reject('EXECUTABLE_NOT_FOUND');
    // Starting one more instance must respect the per-service cap only.
    if (!live && siblings.length >= MAX_INSTANCES_PER_SERVICE) {
      return reject('INSTANCE_LIMIT_REACHED');
    }
  }

  return {
    decision: 'enqueue',
    action,
    serviceId,
    profileId: String(profileId),
    instanceId,
    expectedIdentity: live ? {
      pid: snap.pid,
      startedAt: snap.startedAt,
      executablePath: snap.executablePath
    } : null,
    siblingProfileIds: siblings
  };
}

/**
 * Public DTO for one instance, safe to render in the UI and return over HTTP.
 * `maskedTunnelId` must already be masked by the caller (store.maskTunnelId).
 */
export function publicInstanceDTO(input = {}) {
  const { serviceId, profileId } = input;
  let instanceId = input.instanceId;
  if (!instanceId) {
    try { instanceId = buildInstanceId(serviceId, profileId); } catch { instanceId = null; }
  }
  const state = typeof input.state === 'string' ? input.state : 'unobserved';
  return {
    instanceId,
    serviceId: isServiceId(serviceId) ? serviceId : null,
    profileId: profileId ? String(profileId) : null,
    profileLabel: input.profileLabel ? String(input.profileLabel) : null,
    state,
    managed: input.managed === true,
    owned: input.owned === true,
    identityVerified: input.identityVerified === true,
    pid: positiveInt(input.pid) ? input.pid : null,
    startedAt: typeof input.startedAt === 'string' ? input.startedAt : null,
    healthURL: typeof input.healthURL === 'string' ? input.healthURL : null,
    localPort: positiveInt(input.localPort) ? input.localPort : null,
    maskedTunnelId: typeof input.maskedTunnelId === 'string' ? input.maskedTunnelId : null,
    operationId: typeof input.operationId === 'string' ? input.operationId : null,
    reasonCode: typeof input.reasonCode === 'string' ? input.reasonCode : null,
    lastExitCode: Number.isInteger(input.lastExitCode) ? input.lastExitCode : null,
    observedAt: typeof input.observedAt === 'string' ? input.observedAt : null
  };
}
