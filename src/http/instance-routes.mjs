/**
 * HTTP routes for concurrent per-account tunnel instances (contract §4).
 *
 *   GET  /api/mcps/:id/instances                        -> { serviceId, instances: [publicInstanceDTO] }
 *   POST /api/mcps/:id/instances/:profileId/start       -> 202 action DTO | 200 noop
 *   POST /api/mcps/:id/instances/:profileId/stop        -> 202 action DTO | 200 noop
 *   POST /api/mcps/:id/instances/:profileId/restart     -> 202 action DTO | 200 noop
 *
 * Conventions (sendJson / sendError / readJsonBody / guard / Idempotency-Key /
 * carrier confirmation) are lifted verbatim from `./mcp-routes.mjs` so the new
 * endpoints behave exactly like the legacy start/restart/stop handlers.
 *
 * Legacy routes are NOT matched here: every matcher below requires the literal
 * `/instances` segment, so `matchInstanceRoute` never intercepts
 * `/api/mcps/:id/start|restart|stop` or `/api/mcps/:id`.
 */

import fs from 'node:fs';
import {
  sanitizeProfileSegment,
  buildInstanceId,
  publicInstanceDTO,
  InstanceFault
} from '../core/concurrent-instances.mjs';
import { issueCarrierConfirmation, verifyCarrierConfirmation } from '../core/carrier-confirmation.mjs';
import { isProcessAlive, reconcileStaleRunning } from '../core/process-liveness.mjs';

const INSTANCE_ACTIONS = new Set(['start', 'stop', 'restart']);

/** Codes that represent a client-visible rejection rather than a server fault. */
const REJECT_STATUS = Object.freeze({
  INVALID_ACTION: 400,
  INVALID_INSTANCE: 400,
  INVALID_SERVICE: 400,
  INVALID_PROFILE: 400,
  PROFILE_REQUIRED: 400,
  PROFILE_NOT_FOUND: 404,
  PROFILE_NOT_CONFIGURED: 409,
  SERVICE_DISABLED: 409,
  EXTERNAL_CLIENT_NOT_MANAGED: 409,
  STATE_REFRESH_REQUIRED: 409,
  STATE_UNVERIFIED: 409,
  PROCESS_IDENTITY_MISMATCH: 409,
  OPERATION_IN_PROGRESS: 409,
  INSTANCE_LIMIT_REACHED: 409,
  CARRIER_CONFIRMATION_REQUIRED: 409,
  EXECUTABLE_NOT_FOUND: 400,
  ALREADY_RUNNING: 200,
  ALREADY_STOPPED: 200,
  // Instance-layer-only codes (never produced by the legacy lifecycle).
  INSTANCE_ADAPTER_UNAVAILABLE: 409,
  INSTANCE_ISOLATION_UNVERIFIED: 409
});

function sendJson(res, status, data) {
  if (!res || res.writableEnded) return;
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendError(res, status, code) {
  if (!res || res.writableEnded) return;
  const statusCode = typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
  let errorCode = code;
  if (typeof errorCode !== 'string' || !errorCode) {
    if (statusCode === 400) errorCode = 'BAD_REQUEST';
    else if (statusCode === 401) errorCode = 'UNAUTHORIZED';
    else if (statusCode === 403) errorCode = 'FORBIDDEN';
    else if (statusCode === 404) errorCode = 'NOT_FOUND';
    else if (statusCode === 409) errorCode = 'CONFLICT';
    else errorCode = 'INTERNAL_ERROR';
  }
  const payload = JSON.stringify({
    error: {
      code: errorCode,
      status: statusCode
    }
  });
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let exceeded = false;

    req.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        req.pause();
        req.resume();
        const err = new Error('Payload Too Large');
        err.status = 413;
        err.code = 'JSON_LIMIT_EXCEEDED';
        return reject(err);
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (exceeded) return;
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON');
        err.status = 400;
        err.code = 'INVALID_JSON';
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

/**
 * Pure route matcher. Returns `{route, params}` or null.
 * Only paths containing the literal `/instances` segment are matched, so legacy
 * `/api/mcps/*` routes keep their existing handler untouched.
 */
export function matchInstanceRoute(pathname, method = 'GET') {
  const normPath = (pathname || '').replace(/\/+$/, '') || '/';
  const m = String(method || 'GET').toUpperCase();

  if (!normPath.startsWith('/api/mcps/')) return null;

  const listMatch = normPath.match(/^\/api\/mcps\/([^/]+)\/instances$/);
  if (listMatch) {
    if (m === 'GET') {
      let id;
      try { id = decodeURIComponent(listMatch[1]); } catch { return { route: 'invalidTarget', params: {} }; }
      return { route: 'listInstances', params: { id } };
    }
    return { route: 'methodNotAllowed', params: {} };
  }

  const actionMatch = normPath.match(/^\/api\/mcps\/([^/]+)\/instances\/([^/]+)\/(start|stop|restart)$/);
  if (actionMatch) {
    const action = actionMatch[3];
    if (m !== 'POST') return { route: 'methodNotAllowed', params: {} };
    let id;
    let profileId;
    try {
      id = decodeURIComponent(actionMatch[1]);
      profileId = decodeURIComponent(actionMatch[2]);
    } catch {
      return { route: 'invalidTarget', params: {} };
    }
    return { route: 'instanceAction', params: { id, profileId, action } };
  }

  // Any other /api/mcps/.../instances/... shape is a client error, not a fallthrough.
  const strayMatch = normPath.match(/^\/api\/mcps\/[^/]+\/instances(?:\/|$)/);
  if (strayMatch) return { route: 'methodNotAllowed', params: {} };

  return null;
}

function replyFault(res, err) {
  const code = err instanceof InstanceFault
    ? err.code
    : (err && typeof err.code === 'string' && /^[A-Z_]{1,48}$/.test(err.code) ? err.code : null);
  if (!code) return false;
  const status = err?.status || REJECT_STATUS[code];
  if (!status) return false;
  sendError(res, status, code);
  return true;
}

/**
 * Creates the instance-routes handler.
 *
 * @param {object} params
 * @param {object} params.repo - Store repository
 * @param {object} [params.runner] - Execution runner (woken after enqueue)
 * @param {object} [params.vault] - Vault for carrier confirmation
 * @returns {{ handle: (ctx: object) => Promise<boolean>, matchInstanceRoute: Function }}
 */
export function createInstanceRoutes({
  repo,
  runner,
  vault,
  instanceAdapterProvider = null,
  dataDir = null,
  // Authoritative identity verifier for the persisted-record fallback. Must be
  // processController.verify or equivalent; when absent the fallback can only
  // degrade to `unverified` (see getInstanceProcessIdentity).
  verifyProcessIdentity = null
} = {}) {
  let lazyProvider = null;
  let lazyProviderAttempted = false;

  async function loadServiceDefinition(serviceId) {
    if (repo?.registry && typeof repo.registry.getDefinition === 'function') {
      try { return await repo.registry.getDefinition(serviceId); } catch (_) {}
    }
    if (repo?.registry && typeof repo.registry.getMcp === 'function') {
      try { return await repo.registry.getMcp(serviceId); } catch (_) {}
    }
    if (typeof repo?.getDefinition === 'function') {
      try { return await repo.getDefinition(serviceId); } catch (_) {}
    }
    return null;
  }

  function resolveDataDir() {
    if (typeof dataDir === 'string' && dataDir) return dataDir;
    const candidates = [
      repo?.dataDir,
      repo?.paths?.dataDir,
      repo?.registry?.dataDir,
      repo?.options?.dataDir
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate) return candidate;
    }
    // The runner already reports its resolved data dir; use it rather than
    // guessing, so the lazy provider never invents a production path.
    try {
      const status = typeof runner?.getStatus === 'function' ? runner.getStatus() : null;
      if (status && typeof status.dataDir === 'string' && status.dataDir) return status.dataDir;
    } catch (_) {}
    return null;
  }

  /**
   * Resolves the instance-scoped adapter provider, feature-detected.
   * Returns `null` (caller degrades to store-only facts) when the adapter layer
   * for concurrent instances is not available in this build.
   */
  async function resolveInstanceProvider() {
    if (typeof instanceAdapterProvider === 'function') return instanceAdapterProvider;

    // The runner owns the authoritative instance provider; reuse it when exposed
    // so carrier-confirmation inspection sees the same adapters/cache.
    const runnerProvider = runner?.deps?.instanceAdapterProvider || runner?.instanceAdapterProvider || null;
    if (typeof runnerProvider === 'function') return runnerProvider;

    const direct = repo?.instanceAdapterProvider
      || repo?.adapters?.instanceAdapterProvider
      || null;
    if (typeof direct === 'function') return direct;

    if (typeof repo?.getInstanceAdapterProvider === 'function') {
      try {
        const got = await repo.getInstanceAdapterProvider();
        if (typeof got === 'function') return got;
      } catch (_) {}
    }

    const registryProvider = repo?.registry?.instanceAdapterProvider || null;
    if (typeof registryProvider === 'function') return registryProvider;

    // Last resort: build one from the adapters module when a data dir is known.
    // Only ever used for read-only identity/inspection, and fully guarded.
    if (!lazyProviderAttempted) {
      lazyProviderAttempted = true;
      const dir = resolveDataDir();
      if (dir) {
        try {
          const mod = await import('../adapters/index.mjs');
          if (mod && typeof mod.createInstanceAdapterProvider === 'function') {
            let definitions;
            if (typeof repo?.registry?.listDefinitions === 'function') {
              try { definitions = await repo.registry.listDefinitions(); } catch (_) {}
            }
            const built = mod.createInstanceAdapterProvider({
              dataDir: dir,
              vault,
              definitions: Array.isArray(definitions) ? definitions : undefined,
              resolveDefinition: loadServiceDefinition
            });
            if (typeof built === 'function') lazyProvider = built;
          }
        } catch (_) {
          lazyProvider = null;
        }
      }
    }
    return lazyProvider;
  }

  async function listStoredInstances(serviceId) {
    const readers = [
      () => repo?.listInstanceRuntimes?.(serviceId),
      () => repo?.registry?.listInstanceRuntimes?.(serviceId),
      async () => {
        const rt = typeof repo?.registry?.getServiceRuntime === 'function'
          ? await repo.registry.getServiceRuntime(serviceId)
          : (typeof repo?.getServiceRuntime === 'function' ? await repo.getServiceRuntime(serviceId) : null);
        return Array.isArray(rt?.instances) ? rt.instances : [];
      }
    ];
    for (const read of readers) {
      let rows;
      try {
        rows = await read();
      } catch (_) {
        continue;
      }
      if (Array.isArray(rows)) return rows;
    }
    return [];
  }

  /**
   * Overlays live observer state onto the stored instance records.
   *
   * The observer is a short-lived CACHE: a row may be stale (or describe a state
   * that a later verified stop has already superseded). It is therefore only
   * allowed to win when it is still fresh AND was observed at least as recently
   * as the persisted instance record. The store record stays authoritative.
   */
  function overlayObserver(rows, serviceId) {
    const obs = typeof repo?.registry?.getObserver === 'function'
      ? repo.registry.getObserver()
      : (typeof repo?.getObserver === 'function' ? repo.getObserver() : null);
    if (!obs || typeof obs.peekTunnelClient !== 'function') return rows;

    const now = Date.now();
    const toMs = value => {
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return Date.parse(value);
      return NaN;
    };

    return rows.map(row => {
      const instanceId = row?.instanceId || row?.instance_id;
      if (!instanceId) return row;

      let live = null;
      try { live = obs.peekTunnelClient(instanceId); } catch (_) { live = null; }
      if (!live || typeof live !== 'object') return row;

      // A synthetic value is the observer's "I have nothing cached" placeholder,
      // not an observation. It carries observedAt = now, so it would always outrank
      // the stored record and turn a LIVE instance into a phantom "stopped" row —
      // worse than the staleness this overlay was added to fix.
      if (live.synthetic === true) return row;

      // Drop stale cache rows entirely.
      const expires = toMs(live.expiresAt);
      if (Number.isFinite(expires) && expires <= now) return row;

      // Never let an older observation override a newer verified record.
      const liveAt = toMs(live.observedAt);
      const storedAt = toMs(row.observedAt);
      if (Number.isFinite(liveAt) && Number.isFinite(storedAt) && liveAt < storedAt) return row;

      if (typeof live.state !== 'string' || live.state === 'unobserved') return row;

      const merged = { ...row, state: live.state };
      if (live.pid != null) merged.pid = live.pid;
      if (typeof live.startedAt === 'string' && live.startedAt) merged.startedAt = live.startedAt;
      if (typeof live.reasonCode === 'string' && live.reasonCode) merged.reasonCode = live.reasonCode;
      if (Number.isFinite(liveAt)) merged.observedAt = new Date(liveAt).toISOString();
      if (live.managed === true) merged.managed = true;
      // Ownership evidence travels with the live observation so the row keeps
      // offering stop/restart. Only affirmative evidence is merged: absence of the
      // field must never be read as "owned".
      if (live.owned === true) merged.owned = true;
      if (live.identityVerified === true) merged.identityVerified = true;

      // Running means a live pid; stopped means no pid.
      if (merged.state === 'stopped') {
        merged.pid = null;
        merged.owned = false;
        merged.identityVerified = false;
      }
      return merged;
    });
  }

  async function handleList({ res, serviceId }) {
    const def = await loadServiceDefinition(serviceId);
    if (!def || def.deletedAt) {
      sendError(res, 404, 'MCP_NOT_FOUND');
      return true;
    }
    let rows = await listStoredInstances(serviceId);
    rows = overlayObserver(Array.isArray(rows) ? rows : [], serviceId);
    // Both sides can hand back a `running` claim whose process is already gone: a
    // stored row survives a crash, and the observer is a cache that can outlive
    // the pid. Downgrade before publishing so the list never invents a live one.
    rows = rows.map(row => reconcileStaleRunning(row));
    const instances = rows
      .map(record => publicInstanceDTO({
        ...record,
        serviceId: record?.serviceId || serviceId,
        instanceId: record?.instanceId || record?.instance_id || null
      }))
      .filter(dto => dto && dto.instanceId);
    sendJson(res, 200, { serviceId, instances });
    return true;
  }

  async function handleAction({ req, res, url, payload, serviceId, rawProfileId, action }) {
    // 1. Validate the profile segment exactly like the instance namespace does.
    const segment = sanitizeProfileSegment(rawProfileId);
    if (!segment) {
      sendError(res, 400, 'INVALID_PROFILE');
      return true;
    }

    const def = await loadServiceDefinition(serviceId);
    if (!def || def.deletedAt) {
      sendError(res, 404, 'MCP_NOT_FOUND');
      return true;
    }

    // 2. The profile must exist and be configured for this service.
    let profileId = String(rawProfileId);
    if (typeof repo?.getProfile === 'function') {
      let profile = null;
      try { profile = await repo.getProfile(profileId); } catch (_) { profile = null; }
      if (!profile) {
        // The path may carry the sanitized segment rather than the raw id.
        let all = [];
        try {
          all = typeof repo.listProfiles === 'function' ? await repo.listProfiles() : [];
        } catch (_) { all = []; }
        const match = (Array.isArray(all) ? all : []).find(p =>
          p && (String(p.id) === profileId || sanitizeProfileSegment(p.id) === segment));
        if (!match) {
          sendError(res, 404, 'PROFILE_NOT_FOUND');
          return true;
        }
        profileId = String(match.id);
      }
    }

    // Body may echo profileId; it must agree with the path when supplied.
    if (payload && typeof payload === 'object' && payload.profileId != null) {
      const bodyProfileId = String(payload.profileId);
      if (bodyProfileId !== profileId && sanitizeProfileSegment(bodyProfileId) !== segment) {
        sendError(res, 400, 'INVALID_PROFILE');
        return true;
      }
    }

    let instanceId;
    try {
      instanceId = buildInstanceId(serviceId, profileId);
    } catch (err) {
      replyFault(res, err) || sendError(res, 400, 'INVALID_INSTANCE');
      return true;
    }

    let expectedRevision = payload?.expectedRevision;
    if (expectedRevision === undefined && url?.searchParams?.has('expectedRevision')) {
      const parsed = parseInt(url.searchParams.get('expectedRevision'), 10);
      if (Number.isSafeInteger(parsed)) expectedRevision = parsed;
    }

    const rawIdempotencyKey = req?.headers?.['idempotency-key'] || req?.headers?.['idempotencykey'];
    const idempotencyKey = typeof rawIdempotencyKey === 'string'
      ? rawIdempotencyKey.trim() || undefined
      : undefined;

    // 3. Credential pre-check (mirrors the legacy restart handler's 409).
    if (action !== 'stop' && typeof repo?.hasServiceCredential === 'function') {
      let hasCred = true;
      try { hasCred = await repo.hasServiceCredential(profileId, serviceId); } catch (_) { hasCred = true; }
      if (!hasCred) {
        sendError(res, 409, 'PROFILE_NOT_CONFIGURED');
        return true;
      }
    }

    // 4. Fast noop checks against the live observer for THIS instance only.
    const obs = typeof repo?.registry?.getObserver === 'function'
      ? repo.registry.getObserver()
      : (typeof repo?.getObserver === 'function' ? repo.getObserver() : null);
    if (obs && typeof obs.peekTunnelClient === 'function') {
      let current = null;
      try { current = obs.peekTunnelClient(instanceId); } catch (_) { current = null; }
      if (action === 'start' && current?.state === 'running') {
        const livePid = Number.isSafeInteger(current.pid) && current.pid > 0 ? current.pid : null;
        // The observer cache can outlive the process (killed externally, or by the
        // "close all tunnel-client" button). Trusting it blindly turned a real start
        // into a noop that silently did nothing. Only treat ALREADY_RUNNING as true
        // when the recorded pid is actually alive; otherwise drop the stale entry.
        if (livePid && isProcessAlive(livePid)) {
          sendJson(res, 200, {
            decision: 'noop',
            code: 'ALREADY_RUNNING',
            pid: livePid,
            serviceId,
            instanceId
          });
          return true;
        }
        try { if (typeof obs.invalidate === 'function') obs.invalidate(instanceId); } catch (_) {}
        current = null;
      }
      if (action === 'stop' && current?.state === 'stopped' && current?.absenceVerified) {
        sendJson(res, 200, {
          decision: 'noop',
          code: 'ALREADY_STOPPED',
          serviceId,
          instanceId
        });
        return true;
      }
    }

    // 5. Carrier confirmation — identical flow to legacy restart/stop.
    let carrierToken = payload?.carrierToken;
    if (def?.controlCarrier && action !== 'start') {
      if (!vault || typeof vault.seal !== 'function' || typeof vault.unseal !== 'function') {
        sendError(res, 500, 'CARRIER_CONFIRMATION_UNAVAILABLE');
        return true;
      }

      const auth = req?.authSession || {};
      const sessionBinding = typeof auth?.sessionBinding === 'string' && auth.sessionBinding
        ? auth.sessionBinding
        : (typeof auth?.sessionId === 'string' && auth.sessionId ? auth.sessionId : null);
      if (!sessionBinding) {
        sendError(res, 401, 'UNAUTHORIZED');
        return true;
      }

      if (!idempotencyKey) {
        sendError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED');
        return true;
      }

      const serviceRevision = Number.isSafeInteger(def.revision) && def.revision >= 1 ? def.revision : 1;
      const procInfo = await getInstanceProcessIdentity({ serviceId, profileId, instanceId });

      const confirmCtx = {
        action,
        serviceId,
        serviceRevision,
        profileId,
        sessionBinding,
        idempotencyKey,
        identity: procInfo.identity,
        absenceVerified: procInfo.absenceVerified
      };

      if (!carrierToken) {
        let previewToken;
        try {
          previewToken = await issueCarrierConfirmation(vault, confirmCtx);
        } catch (err) {
          if (err?.code === 'PROCESS_IDENTITY_UNVERIFIED'
            || err?.code === 'INVALID_CARRIER_CONFIRMATION_CONTEXT'
            || err?.code === 'INVALID_CARRIER_ACTION') {
            sendError(res, 409, err.code);
            return true;
          }
          if (err?.code === 'CARRIER_CONFIRMATION_UNAVAILABLE') {
            sendError(res, 500, err.code);
            return true;
          }
          throw err;
        }
        sendJson(res, 409, {
          error: 'CARRIER_CONFIRMATION_REQUIRED',
          code: 'CARRIER_CONFIRMATION_REQUIRED',
          status: 409,
          confirmationRequired: true,
          carrierToken: previewToken,
          message: action === 'restart'
            ? '此服务承载控制平面连接，重启该账号的隧道进程将短暂断开当前 ChatGPT 连接。若确认操作，请在确认对话框中继续。'
            : '此服务承载控制平面连接，停止该账号的隧道进程将断开当前 ChatGPT 连接。若确认操作，请在对话框中继续。'
        });
        return true;
      }

      const isValid = await verifyCarrierConfirmation(vault, carrierToken, confirmCtx);
      if (!isValid) {
        sendError(res, 403, 'CARRIER_CONFIRMATION_INVALID');
        return true;
      }
    }

    // 6. Persist the lifecycle action (instance-scoped).
    if (!repo?.registry || (typeof repo.registry.createLifecycleAction !== 'function'
      && typeof repo.registry.createStopAction !== 'function')) {
      sendError(res, 500, 'REGISTRY_NOT_INITIALIZED');
      return true;
    }

    const sessionBindingForAction = req?.authSession
      ? (req.authSession.sessionBinding || req.authSession.sessionId || null)
      : null;

    const createPayload = {
      action,
      serviceId,
      profileId,
      instanceId,
      expectedRevision,
      idempotencyKey,
      carrierToken: carrierToken ?? null,
      sessionBinding: sessionBindingForAction
    };
    // Drop undefined so legacy createStopAction strictness is unaffected.
    for (const key of Object.keys(createPayload)) {
      if (createPayload[key] === undefined) delete createPayload[key];
    }

    const actionRecord = typeof repo.registry.createLifecycleAction === 'function'
      ? await repo.registry.createLifecycleAction(createPayload)
      : await repo.registry.createStopAction(createPayload);

    // 7. Wake the runner so the queued action is picked up.
    if (runner) {
      if (typeof runner.wake === 'function') {
        try { runner.wake(); } catch (_) {}
      } else if (typeof runner.notify === 'function') {
        try { runner.notify(); } catch (_) {}
      }
    }

    const dto = (actionRecord && typeof actionRecord === 'object') ? { ...actionRecord } : {};
    // Never echo the sealed carrier token back.
    delete dto.carrierToken;
    if (dto.instanceId === undefined) dto.instanceId = instanceId;
    if (dto.profileId === undefined) dto.profileId = profileId;

    sendJson(res, 202, dto);
    return true;
  }

  /**
   * Instance-scoped process identity, used only for carrier confirmation binding.
   *
   * Resolution order (all feature-detected):
   *   1. The instance adapter provider + its process controller (authoritative).
   *   2. The persisted `instance_runtime` record, which the lifecycle module only
   *      writes after a verified start/stop — a legitimate server-side fact.
   *   3. Degrade to `{unverified:true}` so carrier-gated actions are refused
   *      rather than silently bound to a wrong identity.
   *
   * OWNERSHIP, not just self-consistency: `verify(inspected)` only proves that the
   * process the OS reports right now matches ITSELF. After pid reuse it happily
   * validates whatever now owns that pid, so the identity that must be handed to
   * the verifier is the one this instance was LAUNCHED with (the adapter's launch
   * record, else the persisted instance row). The inspected pid must equal that
   * expected pid before the verifier is consulted at all.
   */
  async function getInstanceProcessIdentity({ serviceId, profileId, instanceId }) {
    const provider = await resolveInstanceProvider();

    // Persisted expected identity, read once: it is the only thing that ties a
    // live pid to THIS instance rather than to whatever recycled it.
    let record = null;
    try {
      if (typeof repo?.getInstanceRuntime === 'function') {
        record = await repo.getInstanceRuntime(instanceId);
      } else if (typeof repo?.registry?.getInstanceRuntime === 'function') {
        record = await repo.registry.getInstanceRuntime(instanceId);
      }
    } catch (_) {
      record = null;
    }

    /** Normalizes a launch/persisted record into the expected-identity shape. */
    const expectedFrom = (src) => {
      if (!src || typeof src !== 'object') return null;
      const pid = Number.isSafeInteger(src.pid) && src.pid > 0 ? src.pid : null;
      const startedAt = typeof (src.startedAt || src.startTime) === 'string'
        ? (src.startedAt || src.startTime) : null;
      const executablePath = typeof (src.executablePath || src.executable) === 'string'
        ? (src.executablePath || src.executable) : null;
      if (!pid || !startedAt || !executablePath) return null;
      return { pid, startedAt, executablePath };
    };

    /** Reads the adapter's own launch record (written when this instance started). */
    const expectedFromAdapter = (adapter) => {
      const p = adapter?.processPath;
      if (typeof p !== 'string' || !p) return null;
      try {
        if (!fs.existsSync(p)) return null;
        return expectedFrom(JSON.parse(fs.readFileSync(p, 'utf8')));
      } catch (_) {
        return null;
      }
    };

    /** Consults a controller verifier against an EXPLICIT expected identity. */
    const verifyAgainst = async (controller, expected) => {
      if (!expected) return false;
      if (typeof controller?.verify !== 'function') return false;
      try {
        const v = await controller.verify(expected);
        return v?.valid === true;
      } catch (_) {
        return false;
      }
    };

    if (typeof provider === 'function') {
      let adapter = null;
      try {
        adapter = await provider({ instanceId }, serviceId, profileId);
      } catch (_) {
        adapter = null;
      }

      if (adapter && typeof adapter === 'object') {
        let inspected = null;
        let failed = false;
        try {
          if (adapter.processController && typeof adapter.processController.inspectInstance === 'function') {
            inspected = await adapter.processController.inspectInstance(instanceId);
          } else if (adapter.processController && typeof adapter.processController.inspect === 'function') {
            inspected = await adapter.processController.inspect(serviceId, instanceId);
          } else {
            failed = true;
          }
        } catch (_) {
          failed = true;
        }

        if (!failed && inspected && typeof inspected === 'object') {
          if (inspected.running && inspected.pid > 0) {
            // The expected identity decides whether this pid is OURS.
            const expected = expectedFromAdapter(adapter)
              || (record && record.state === 'running' ? expectedFrom(record) : null);
            // A live pid with no expected identity is an unowned process: it must
            // never become the target of a carrier-bound stop/restart.
            if (!expected || expected.pid !== inspected.pid) return { unverified: true };
            const verified = await verifyAgainst(adapter.processController, expected);
            if (!verified) return { unverified: true };
            return {
              identity: {
                pid: expected.pid,
                startedAt: expected.startedAt,
                executablePath: expected.executablePath,
                verified: true
              },
              absenceVerified: false
            };
          }
          if (inspected.running === false) {
            return { identity: null, absenceVerified: true };
          }
          return { unverified: true };
        }
      }
    }

    // Fallback: the persisted instance runtime record is a CLAIM, never proof.
    //
    // This branch used to return {identity:{...}, verified:true} for any row that
    // said `running` with a pid, and `absenceVerified:true` for any row that said
    // `stopped`. Both feed carrier confirmation directly, and
    // carrier-confirmation.mjs requires little more than `verified === true` plus
    // a well-shaped identity -- so a tunnel that had already died still produced a
    // valid carrier-management token bound to whatever now holds that pid.
    //
    // A stored `running` row is usable only when the pid is actually alive AND an
    // authoritative verifier confirms executable path + creation time. Anything
    // else (dead pid, missing verifier, verifier false/throwing, recycled pid)
    // degrades to `unverified`, which makes carrier-gated actions refuse instead
    // of binding a token to the wrong process. A stored `stopped`/`failed` row is
    // NOT absence: only an authoritative inspection may claim that.
    const persisted = record && record.state === 'running' ? expectedFrom(record) : null;
    if (persisted) {
      // Existence is not identity: a recycled pid would pass this alone.
      if (!isProcessAlive(persisted.pid)) return { unverified: true };
      if (typeof verifyProcessIdentity !== 'function') return { unverified: true };
      let verified = false;
      try {
        const verdict = await verifyProcessIdentity(persisted);
        verified = verdict?.valid === true;
      } catch (_) {
        verified = false;
      }
      if (!verified) return { unverified: true };
      return {
        identity: { ...persisted, verified: true },
        absenceVerified: false
      };
    }

    return { unverified: true };
  }

  /**
   * Handles one request. Returns `true` when this module produced the response,
   * `false` when the path is not an instance route (caller must fall through).
   *
   * @param {object} ctx - { req, res, url, body, auth }
   * @returns {Promise<boolean>}
   */
  async function handle(ctx = {}) {
    const { req, res, url, body } = ctx;

    const parsedUrl = typeof url === 'string'
      ? (() => { try { return new URL(url, 'http://localhost'); } catch { return null; } })()
      : (url instanceof URL ? url : null);

    if (!parsedUrl || !req || !res) return false;

    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    const matched = matchInstanceRoute(pathname, method);
    if (!matched) return false;

    if (matched.route === 'methodNotAllowed') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED');
      return true;
    }
    if (matched.route === 'invalidTarget') {
      sendError(res, 400, 'INVALID_TARGETS');
      return true;
    }

    const auth = ctx.auth || req.authSession || null;
    if (!auth || auth.authenticated === false) {
      sendError(res, 401, 'UNAUTHORIZED');
      return true;
    }

    const { id: serviceId } = matched.params;

    let payload = body;
    if (payload && typeof payload.then === 'function') {
      payload = await payload;
    }
    if (matched.route === 'instanceAction') {
      if (payload === undefined) {
        try {
          payload = await readJsonBody(req);
        } catch (err) {
          sendError(res, err.status || 400, err.code || 'INVALID_JSON');
          return true;
        }
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        payload = {};
      }
    } else {
      payload = (payload && typeof payload === 'object') ? payload : {};
    }

    try {
      if (matched.route === 'listInstances') {
        return await handleList({ res, serviceId });
      }
      if (matched.route === 'instanceAction') {
        const { profileId, action } = matched.params;
        if (!INSTANCE_ACTIONS.has(action)) {
          sendError(res, 400, 'INVALID_ACTION');
          return true;
        }
        return await handleAction({
          req,
          res,
          url: parsedUrl,
          payload,
          serviceId,
          rawProfileId: profileId,
          action
        });
      }
      return false;
    } catch (err) {
      if (replyFault(res, err)) return true;

      let status = err?.status || err?.statusCode;
      let code = err?.code;
      if (!status) {
        if (code === 'REVISION_CONFLICT' || code === 'CONFLICT' || err?.name === 'ConflictError') {
          status = 409;
          code = code || 'REVISION_CONFLICT';
        } else if (code === 'MCP_NOT_FOUND' || code === 'PROFILE_NOT_FOUND' || code === 'NOT_FOUND'
          || err?.name === 'NotFoundError') {
          status = 404;
          code = code || 'NOT_FOUND';
        } else if (code === 'PROFILE_REQUIRED' || code === 'IDEMPOTENCY_KEY_REQUIRED'
          || code === 'INVALID_ACTION' || code === 'INVALID_PROFILE' || code === 'EXECUTABLE_NOT_FOUND') {
          status = 400;
        } else if (code === 'IDEMPOTENCY_CONFLICT' || code === 'SERVICE_DISABLED'
          || code === 'PROFILE_NOT_CONFIGURED' || code === 'OPERATION_IN_PROGRESS'
          || code === 'STATE_REFRESH_REQUIRED' || code === 'STATE_UNVERIFIED'
          || code === 'PROCESS_IDENTITY_MISMATCH' || code === 'EXTERNAL_CLIENT_NOT_MANAGED') {
          status = 409;
        } else {
          status = 500;
          code = code || 'INTERNAL_ERROR';
        }
      }
      sendError(res, status, code);
      return true;
    }
  }

  return { handle, matchInstanceRoute };
}

/**
 * Stateless convenience export used by `src/server.mjs`.
 *
 * @param {object} ctx - { req, res, url, body, auth, repo, runner, vault }
 * @returns {Promise<boolean>} true when the request was handled here
 */
export async function handleInstanceRoutes(ctx = {}) {
  const { repo, runner, vault } = ctx;
  const routes = createInstanceRoutes({ repo, runner, vault });
  return await routes.handle(ctx);
}

export default handleInstanceRoutes;
