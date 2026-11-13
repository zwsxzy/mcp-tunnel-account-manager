const STATES = new Set(['available', 'authentication_required', 'unreachable', 'unobserved', 'check_failed']);
const SOURCES = new Set(['http_mcp', 'process_controller', 'tunnel_health', 'none']);
const REASONS = new Set(['not_observed', 'observation_expired', 'mcp_initialize_verified',
  'http_authentication_required', 'connection_refused', 'connection_failed', 'timeout',
  'invalid_mcp_response', 'unsupported_transport', 'external_process_unobserved',
  'process_alive_mcp_unverified', 'tunnel_online_backend_unverified', 'probe_failed',
  'observation_disabled', 'observer_unavailable', 'invalid_observation', 'configuration_changed']);

function empty(reasonCode = 'not_observed') {
  return { state: 'unobserved', reasonCode, source: 'none',
    observedAt: null, expiresAt: null, evidence: {} };
}
function time(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) && Number.isFinite(new Date(n).getTime()) ? n : NaN;
}
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
export function normalizeObservation(raw, { nowMs = Date.now(), ttlMs = 90000 } = {}) {
  if (!raw || typeof raw !== 'object') return empty();
  let state = STATES.has(raw.state) ? raw.state : 'check_failed';
  let reasonCode = REASONS.has(raw.reasonCode) ? raw.reasonCode : 'invalid_observation';
  const source = SOURCES.has(raw.source) ? raw.source : 'none';
  const evidence = {};
  for (const key of ['processAlive', 'tunnelConnected', 'mcpVerified']) {
    if (typeof raw.evidence?.[key] === 'boolean') evidence[key] = raw.evidence[key];
  }
  const status = raw.evidence?.httpStatus;
  if (Number.isInteger(status) && status >= 100 && status <= 599) evidence.httpStatus = status;
  const observed = time(raw.observedAt);
  if (!Number.isFinite(observed)) {
    return state === 'unobserved' ? empty(reasonCode) : {
      ...empty('invalid_observation'), state: 'check_failed'
    };
  }
  if (observed > nowMs + 5000) return { ...empty('invalid_observation'), state: 'check_failed' };
  let expires = observed + positive(ttlMs, 90000);
  const suppliedExpiry = time(raw.expiresAt);
  if (Number.isFinite(suppliedExpiry)) expires = Math.min(expires, suppliedExpiry);
  if (!Number.isFinite(new Date(expires).getTime())) return { ...empty('invalid_observation'), state: 'check_failed' };
  if (state === 'available' && (evidence.mcpVerified !== true || source === 'none'
      || status === 401 || status === 403)) {
    state = 'check_failed'; reasonCode = 'invalid_observation';
  }
  if (state === 'authentication_required' && status !== 401 && status !== 403) {
    state = 'check_failed'; reasonCode = 'invalid_observation';
  }
  if (expires <= nowMs) { state = 'unobserved'; reasonCode = 'observation_expired'; }
  return { state, reasonCode, source, observedAt: new Date(observed).toISOString(),
    expiresAt: new Date(expires).toISOString(), evidence };
}

/**
 * Shared concurrency gate for observation cycles.
 *
 * `observe()` is called from the dashboard route, the MCP list routes and the
 * recovery paths. Each cycle may probe HTTP or read process/tunnel health, so an
 * unbounded fan-out turned one dashboard refresh into N simultaneous probes.
 * The gate is shared by every observer in the process by default (a manager
 * creates one), so "everywhere" really means at most 2 probes in flight.
 */
export function createObservationLimiter({ maxConcurrent = 2, maxWaiting = 16 } = {}) {
  let active = 0;
  const waiters = [];
  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      pump();
    };
  }
  function pump() {
    while (active < maxConcurrent && waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter || waiter.cancelled) continue;
      active += 1;
      waiter.resolve(makeRelease());
    }
  }
  function acquire(owner) {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(makeRelease());
    }
    if (waiters.length >= maxWaiting) return Promise.resolve(null);
    return new Promise(resolve => waiters.push({ owner, resolve, cancelled: false }));
  }
  function cancel(owner) {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].owner !== owner) continue;
      const [waiter] = waiters.splice(i, 1);
      waiter.cancelled = true;
      waiter.resolve(null);
    }
  }
  function getStats() {
    return { maxConcurrent, maxWaiting, active, waiting: waiters.length };
  }
  return { acquire, cancel, getStats };
}

let defaultLimiter = null;
function getDefaultLimiter() {
  if (!defaultLimiter) defaultLimiter = createObservationLimiter({});
  return defaultLimiter;
}

export function createRuntimeObserver(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = positive(options.ttlMs, 90000);
  const minIntervalMs = positive(options.minIntervalMs, 30000);
  const timeoutMs = positive(options.timeoutMs, 5000);
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries : 256;
  const backoffScheduleMs = Array.isArray(options.backoffScheduleMs) && options.backoffScheduleMs.length > 0
    ? options.backoffScheduleMs.filter(value => Number.isFinite(value) && value > 0)
    : [30000, 60000, 120000, 240000, 300000];
  const limiter = options.limiter || getDefaultLimiter();
  const rows = new Map();
  const tunnelClientRows = new Map();
  let closed = false;

  function evictIdleRows() {
    if (rows.size <= maxEntries) return;
    const candidates = [...rows.entries()]
      .filter(([, row]) => !row.promise && !row.cancel)
      .sort((a, b) => (a[1].started ?? 0) - (b[1].started ?? 0));
    for (const [key] of candidates) {
      if (rows.size <= maxEntries) break;
      rows.delete(key);
    }
  }

  function evictIdleTunnelRows() {
    if (tunnelClientRows.size <= maxEntries) return;
    const candidates = [...tunnelClientRows.entries()]
      .sort((a, b) => (time(a[1]?.observedAt) || 0) - (time(b[1]?.observedAt) || 0));
    for (const [key, row] of candidates) {
      if (tunnelClientRows.size <= maxEntries) break;
      // Never drop a row whose observation is still fresh: that would turn a
      // known running client into an unknown one for no memory win.
      const expires = time(row?.expiresAt);
      if (Number.isFinite(expires) && expires > now()) continue;
      tunnelClientRows.delete(key);
    }
  }

  function peek(id, revision = null) {
    if (closed) return empty('observer_unavailable');
    const row = rows.get(String(id));
    if (!row) return empty();
    if (row.revision !== revision) return empty('configuration_changed');
    return normalizeObservation(row.raw, { nowMs: now(), ttlMs });
  }
  /**
   * A value this observer INVENTED rather than observed. `synthetic: true` lets
   * publication layers tell the two apart: a placeholder must never outrank a
   * stored record just because it carries a fresh timestamp.
   */
  function syntheticTunnelClient(reasonCode, state) {
    return {
      state,
      managed: state === 'stopped',
      pid: null,
      startedAt: null,
      profileId: null,
      operationId: null,
      observedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + ttlMs).toISOString(),
      reasonCode,
      lastExitCode: null,
      synthetic: true
    };
  }
  function peekTunnelClient(id) {
    if (closed) {
      return {
        state: 'unobserved',
        managed: false,
        pid: null,
        startedAt: null,
        profileId: null,
        operationId: null,
        observedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + ttlMs).toISOString(),
        reasonCode: 'observer_unavailable',
        lastExitCode: null,
        synthetic: true
      };
    }
    const row = tunnelClientRows.get(String(id));
    if (!row) {
      return syntheticTunnelClient('process_stopped', 'stopped');
    }
    // A cached observation is evidence with a shelf life. `peek()` honours ttlMs
    // through normalizeObservation; this projection returned the row verbatim, so a
    // `running` entry could outlive its process indefinitely for any service the
    // collector stops re-probing (e.g. a disabled one).
    const expiresAt = typeof row.expiresAt === 'number' ? row.expiresAt : Date.parse(row.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now()) {
      return syntheticTunnelClient('observation_expired', 'unobserved');
    }
    return row;
  }
  function setTunnelClient(id, status) {
    if (closed) return;
    tunnelClientRows.set(String(id), status);
    evictIdleTunnelRows();
  }
  function invalidate(id) {
    const key = String(id);
    const row = rows.get(key);
    rows.delete(key);
    tunnelClientRows.delete(key);
    row?.cancel?.('configuration_changed');
  }
  async function collect(target, signal) {
    if (signal.aborted) return empty('observer_unavailable');
    if (target.transport === 'http') {
      if (typeof options.probeHttpMcp !== 'function') return empty('observer_unavailable');
      return options.probeHttpMcp({ serviceId: target.id, url: target.url, signal });
    }
    if (target.carrier && typeof options.readTunnelHealth === 'function') {
      return options.readTunnelHealth({ serviceId: target.id, signal,
        readProcess: target.readProcess, adapter: target.adapter });
    }
    if (target.transport === 'stdio' && typeof options.inspectProcess === 'function') {
      return options.inspectProcess({ serviceId: target.id, signal,
        readProcess: target.readProcess, adapter: target.adapter });
    }
    return empty(target.transport === 'stdio' ? 'external_process_unobserved' : 'unsupported_transport');
  }
  function observe(input) {
    const target = { id: String(input.id), revision: input.revision ?? null,
      enabled: input.enabled === true, transport: input.transport, url: input.url, carrier: !!input.carrier,
      // Internal, cycle-local read-through context; never stored as identity proof.
      readProcess: input.readProcess, adapter: input.adapter };
    if (closed) return Promise.resolve(empty('observer_unavailable'));
    if (!target.enabled) { invalidate(target.id); return Promise.resolve(empty('observation_disabled')); }
    const stamp = JSON.stringify([target.revision, target.transport, target.url ?? null, target.carrier]);
    let row = rows.get(target.id);
    if (row && row.stamp !== stamp) { invalidate(target.id); row = undefined; }
    if (row?.promise) return row.promise;
    const started = now();
    // Failure backoff: 30s -> 60s -> 120s -> 240s -> 300s. A healthy row keeps
    // the ordinary 30s minimum interval.
    const failures = Number.isFinite(row?.failures) ? row.failures : 0;
    const interval = failures > 0
      ? backoffScheduleMs[Math.min(failures, backoffScheduleMs.length) - 1]
      : minIntervalMs;
    if (row && started >= row.started && started < row.started + interval) {
      return Promise.resolve(peek(target.id, target.revision));
    }
    const controller = new AbortController();
    row = {
      revision: target.revision,
      stamp,
      started,
      raw: row?.raw ?? null,
      failures,
      promise: null,
      cancel: null
    };
    rows.set(target.id, row);
    let releaseCancel;
    const cancelled = new Promise(resolve => { releaseCancel = resolve; });
    row.cancel = reason => {
      controller.abort();
      limiter.cancel(row);
      releaseCancel(empty(reason));
    };
    let timer;
    const source = target.transport === 'http' ? 'http_mcp' : target.carrier ? 'tunnel_health' : 'process_controller';
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ state: target.transport === 'http' ? 'unreachable' : 'check_failed',
          reasonCode: 'timeout', source, observedAt: now(), evidence: { mcpVerified: false } });
      }, timeoutMs);
      // A pending public observation must reach its deadline even when the
      // injected probe has no OS handle. The cycle's finally clears this timer.
    });
    const runCycle = async () => {
      // The gate is acquired for the actual probe only. If the bounded wait
      // queue is full, this cycle reports "unobserved" instead of inventing a
      // stopped/running state; a previous cached observation is never upgraded.
      const release = await limiter.acquire(row);
      if (!release) return empty('observer_unavailable');
      try {
        const operation = Promise.resolve().then(() => collect(target, controller.signal)).catch(error => {
          const code = error?.cause?.code ?? error?.code;
          const network = target.transport === 'http' &&
            ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
          return { state: network ? 'unreachable' : 'check_failed',
            reasonCode: code === 'ECONNREFUSED' && network ? 'connection_refused' : network ? 'connection_failed' : 'probe_failed',
            source, observedAt: now(), evidence: { mcpVerified: false } };
        });
        return await Promise.race([operation, deadline, cancelled]);
      } finally {
        release();
      }
    };
    row.promise = runCycle().then(raw => {
      const result = normalizeObservation(raw, { nowMs: now(), ttlMs });
      if (!closed && rows.get(target.id) === row) {
        row.raw = result;
        // Only `available` / `authentication_required` are real observations.
        // Everything else (timeout, refused, invalid) backs off exponentially.
        const healthy = result.state === 'available' || result.state === 'authentication_required';
        row.failures = healthy ? 0 : Math.min((row.failures || 0) + 1, backoffScheduleMs.length);
      }
      return result;
    }).finally(() => {
      clearTimeout(timer);
      if (rows.get(target.id) === row) { row.promise = null; row.cancel = null; }
      evictIdleRows();
    });
    return row.promise;
  }
  function close() {
    closed = true;
    const pending = [...rows.values()];
    rows.clear();
    for (const row of pending) row.cancel?.('observer_unavailable');
    tunnelClientRows.clear();
  }
  function getStats() {
    return {
      closed,
      rows: rows.size,
      tunnelClientRows: tunnelClientRows.size,
      maxEntries,
      limiter: typeof limiter.getStats === 'function' ? limiter.getStats() : null
    };
  }
  return { observe, peek, peekTunnelClient, setTunnelClient, invalidate, close, getStats };
}
