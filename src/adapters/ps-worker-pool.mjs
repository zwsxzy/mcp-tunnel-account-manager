/**
 * Backpressure for the shared PowerShell helper worker.
 *
 * The worker itself is a single long-lived `powershell` process that reads one
 * JSON request per line from stdin and writes one `__MCP_PS_RESP__` line back.
 * That pipe is a REAL serial resource: the script runs one request at a time.
 * The old implementation pushed every request straight into stdin, so N
 * simultaneous Inspect/Verify calls became N queued PowerShell scripts inside
 * one process with no visibility and no bound, and a timeout released nothing.
 *
 * This pool enforces:
 *   - exactly ONE dispatched request on the pipe at a time;
 *   - a bounded queue (8 normal + 4 reserved for critical control services);
 *   - critical requests are selected first, but at most `maxConsecutiveCritical`
 *     in a row so normal work cannot be starved;
 *   - a queue-wait timeout that is SEPARATE from the execution timeout, and the
 *     execution timer starts at dispatch, not at enqueue;
 *   - after a dispatch timeout the promise rejects, but the pipe stays occupied
 *     until the late response (or worker death) finally releases it: the request
 *     may still be executing and must never be replayed;
 *   - worker death fails every queued and in-flight request with an identifiable
 *     code and clears every timer.
 *
 * Nothing here spawns tunnel clients or touches the OS process table.
 */

export const PS_FAULT_CODES = Object.freeze({
  UNAVAILABLE: 'PS_WORKER_UNAVAILABLE',
  SPAWN_FAILED: 'PS_WORKER_SPAWN_FAILED',
  WRITE_FAILED: 'PS_WORKER_WRITE_FAILED',
  EXITED: 'PS_WORKER_EXITED',
  QUEUE_FULL: 'PS_QUEUE_FULL',
  QUEUE_TIMEOUT: 'PS_QUEUE_TIMEOUT',
  EXECUTION_TIMEOUT: 'PS_EXECUTION_TIMEOUT',
  CLOSED: 'PS_POOL_CLOSED'
});

export class PsWorkerFault extends Error {
  constructor(code, message, { dispatched = false, critical = false } = {}) {
    super(message || code);
    this.name = 'PsWorkerFault';
    this.code = code;
    // `dispatched` is the fallback decision input: a request that already
    // reached the pipe must never be replayed by another transport.
    this.dispatched = dispatched === true;
    this.critical = critical === true;
  }
}

function noop() {}

export function createPsWorkerPool(options = {}) {
  const {
    spawnWorker,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    executionTimeoutMs = 12000,
    queueWaitTimeoutMs = 30000,
    maxNormalQueue = 8,
    maxCriticalQueue = 4,
    maxConsecutiveCritical = 4
  } = options || {};

  if (typeof spawnWorker !== 'function') {
    throw new TypeError('createPsWorkerPool requires a spawnWorker function');
  }
  for (const [name, value] of Object.entries({
    executionTimeoutMs, queueWaitTimeoutMs, maxNormalQueue, maxCriticalQueue, maxConsecutiveCritical
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`createPsWorkerPool: ${name} must be a positive finite number`);
    }
  }

  let worker = null;
  let dead = false;
  let closed = false;
  let inFlight = null;
  let buffer = '';
  let requestCounter = 0;
  let consecutiveCritical = 0;
  const pending = new Map();
  const queueNormal = [];
  const queueCritical = [];
  const stats = {
    dispatched: 0,
    completed: 0,
    timedOut: 0,
    lateResponses: 0,
    rejectedQueue: 0,
    rejectedWorker: 0,
    spawns: 0
  };

  function fault(code, message, extra) {
    return new PsWorkerFault(code, message, extra);
  }

  function clearEntryTimers(entry) {
    if (entry?.queueTimer) { clearTimeoutFn(entry.queueTimer); entry.queueTimer = null; }
    if (entry?.execTimer) { clearTimeoutFn(entry.execTimer); entry.execTimer = null; }
  }

  function settleReject(entry, error) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearEntryTimers(entry);
    try { entry.reject(error); } catch (_) {}
  }

  function settleResolve(entry, value) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearEntryTimers(entry);
    try { entry.resolve(value); } catch (_) {}
  }

  function onWorkerFailure(code, message) {
    if (dead && !worker) return;
    const dying = worker;
    worker = null;
    dead = true;
    const queued = [...queueCritical, ...queueNormal];
    queueCritical.length = 0;
    queueNormal.length = 0;
    buffer = '';
    const inFlightEntry = inFlight;
    inFlight = null;
    pending.clear();
    const spawnConfirmed = dying?.spawnConfirmed === true;
    if (dying) {
      try { dying.removeAllListeners?.(); } catch (_) {}
    }
    stats.rejectedWorker += 1;
    if (inFlightEntry) {
      // A write into the stdin of a child that never emitted 'spawn' (ENOENT,
      // access denied) never reached a helper: that, and only that, is a
      // provably-undispatched failure the caller may retry elsewhere.
      settleReject(inFlightEntry, fault(code, message, {
        dispatched: spawnConfirmed && inFlightEntry.written === true,
        critical: inFlightEntry.critical
      }));
    }
    for (const entry of queued) {
      settleReject(entry, fault(
        code === PS_FAULT_CODES.EXITED ? PS_FAULT_CODES.EXITED : PS_FAULT_CODES.UNAVAILABLE,
        message,
        { dispatched: false, critical: entry.critical }
      ));
    }
  }

  function scheduleExecutionTimer(entry) {
    entry.execTimer = setTimeoutFn(() => {
      entry.execTimer = null;
      if (entry.settled) return;
      // Do NOT free the pipe here. The helper is still executing an unknown
      // script; only its late response (or worker death) proves the pipe idle.
      entry.timedOut = true;
      stats.timedOut += 1;
      entry.settled = true;
      try {
        entry.reject(fault(PS_FAULT_CODES.EXECUTION_TIMEOUT,
          'PS worker request timed out after dispatch', {
            dispatched: true,
            critical: entry.critical
          }));
      } catch (_) {}
    }, executionTimeoutMs);
    // The deadline owns the public request's remaining lifetime even if the
    // worker exposes no referenced handle. Its expiry still retains the real
    // pipe occupancy until a late response or worker death proves it free.
  }

  function dispatch(entry) {
    const id = `req_${++requestCounter}`;
    entry.id = id;
    entry.dispatchedAt = now();
    if (entry.queueTimer) { clearTimeoutFn(entry.queueTimer); entry.queueTimer = null; }
    inFlight = entry;
    pending.set(id, entry);
    stats.dispatched += 1;
    if (entry.critical) consecutiveCritical += 1;
    else consecutiveCritical = 0;
    scheduleExecutionTimer(entry);
    let written = false;
    try {
      const line = `${JSON.stringify({ id, scriptPath: entry.scriptPath, params: entry.params })}\n`;
      worker.child.stdin.write(line, 'utf8');
      written = true;
      entry.written = true;
    } catch (error) {
      if (!written) {
        // The line never reached the pipe: a replay through a standalone helper is
        // safe for idempotent actions (the caller decides; Launch never replays).
        pending.delete(id);
        inFlight = null;
        stats.rejectedWorker += 1;
        settleReject(entry, fault(PS_FAULT_CODES.WRITE_FAILED,
          error?.message || 'PS worker write failed', { dispatched: false, critical: entry.critical }));
        onWorkerFailure(PS_FAULT_CODES.WRITE_FAILED, 'PS worker write failed');
      }
    }
  }

  function pickQueue() {
    const hasCritical = queueCritical.length > 0;
    const hasNormal = queueNormal.length > 0;
    if (!hasCritical) return hasNormal ? 'normal' : null;
    if (!hasNormal) return 'critical';
    if (consecutiveCritical >= maxConsecutiveCritical) return 'normal';
    return 'critical';
  }

  // A request whose execution deadline elapsed keeps the real pipe occupied, so a
  // new request must wait for its late response. Past this grace the pipe is
  // treated as lost: the worker is marked failed and every waiter gets an
  // explicit error instead of silently occupying the pipe forever. Nothing is
  // respawned here, so an old-client worker process is never killed.
  const ORPHAN_GRACE_MS = Math.max(executionTimeoutMs, 60000);

  function pump() {
    while (!closed && !dead && worker && !inFlight) {
      const which = pickQueue();
      if (!which) return;
      const entry = which === 'critical' ? queueCritical.shift() : queueNormal.shift();
      if (!entry || entry.settled) continue;
      dispatch(entry);
    }
    if (!closed && !dead && inFlight?.timedOut && queueCritical.length + queueNormal.length > 0) {
      const orphanedFor = now() - (inFlight.dispatchedAt ?? now());
      if (orphanedFor >= ORPHAN_GRACE_MS) {
        onWorkerFailure(PS_FAULT_CODES.EXECUTION_TIMEOUT, 'PS worker pipe stalled after a timed-out request');
      }
    }
  }

  function ensureWorker() {
    if (closed) throw fault(PS_FAULT_CODES.CLOSED, 'PS worker pool is closed', { dispatched: false });
    if (dead) throw fault(PS_FAULT_CODES.UNAVAILABLE, 'PS worker is unavailable', { dispatched: false });
    if (worker) return worker;
    let child;
    try {
      child = spawnWorker();
    } catch (error) {
      dead = true;
      throw fault(PS_FAULT_CODES.SPAWN_FAILED, error?.message || 'PS worker failed to start',
        { dispatched: false });
    }
    if (!child || !child.stdin || !child.stdout || typeof child.on !== 'function') {
      dead = true;
      throw fault(PS_FAULT_CODES.SPAWN_FAILED, 'PS worker did not expose a usable pipe', { dispatched: false });
    }
    stats.spawns += 1;
    worker = { child, spawnConfirmed: false };
    child.on('spawn', () => { if (worker?.child === child) worker.spawnConfirmed = true; });
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const markerIdx = line.indexOf('__MCP_PS_RESP__');
        if (markerIdx === -1) continue;
        const jsonPart = line.slice(markerIdx + '__MCP_PS_RESP__'.length);
        let msg;
        try { msg = JSON.parse(jsonPart); } catch (_) { continue; }
        const entry = pending.get(msg.id);
        if (!entry) continue;
        pending.delete(msg.id);
        if (inFlight === entry) inFlight = null;
        if (entry.timedOut) {
          // Late answer for a request we already rejected. It proves the pipe is
          // idle now; release the real occupancy and continue. Never resolve.
          stats.lateResponses += 1;
          entry.settled = true;
        } else {
          let parsed = null;
          try {
            if (msg.stdout && msg.stdout.trim()) parsed = JSON.parse(msg.stdout.trim());
          } catch (_) {}
          stats.completed += 1;
          settleResolve(entry, {
            code: msg.code ?? 0,
            stdout: msg.stdout || '',
            stderr: msg.stderr || '',
            data: parsed,
            ...(parsed || {})
          });
        }
        pump();
      }
    });
    child.on('error', () => onWorkerFailure(PS_FAULT_CODES.UNAVAILABLE, 'PS worker error'));
    child.on('close', () => onWorkerFailure(PS_FAULT_CODES.EXITED, 'PS worker closed'));
    return worker;
  }

  function enqueue(entry, critical) {
    const queue = critical ? queueCritical : queueNormal;
    const limit = critical ? maxCriticalQueue : maxNormalQueue;
    const waiting = critical ? queueCritical.length : queueNormal.length;
    if (!worker || waiting >= limit) {
      stats.rejectedQueue += 1;
      throw fault(PS_FAULT_CODES.QUEUE_FULL,
        critical ? 'Critical PS helper queue is full' : 'PS helper queue is full',
        { dispatched: false, critical });
    }
    queue.push(entry);
    entry.queueTimer = setTimeoutFn(() => {
      entry.queueTimer = null;
      if (entry.settled) return;
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      stats.rejectedQueue += 1;
      settleReject(entry, fault(PS_FAULT_CODES.QUEUE_TIMEOUT, 'PS worker request waited too long in queue',
        { dispatched: false, critical }));
    }, queueWaitTimeoutMs);
    // A queued caller must receive its timeout even with no other event-loop
    // handles. Dispatch, close, and worker failure clear this referenced timer.
  }

  function send(scriptPath, params, { critical = false } = {}) {
    return new Promise((resolve, reject) => {
      const entry = {
        id: null,
        scriptPath,
        params,
        critical: critical === true,
        settled: false,
        timedOut: false,
        enqueuedAt: now(),
        dispatchedAt: null,
        queueTimer: null,
        execTimer: null,
        resolve,
        reject
      };
      try {
        ensureWorker();
        if (!inFlight && queueCritical.length === 0 && queueNormal.length === 0) {
          dispatch(entry);
          return;
        }
        enqueue(entry, entry.critical);
        pump();
      } catch (error) {
        settleReject(entry, error);
      }
    });
  }

  function getStats() {
    return {
      ...stats,
      workerAlive: Boolean(worker) && !dead,
      inflight: inFlight ? { id: inFlight.id, critical: inFlight.critical, timedOut: inFlight.timedOut } : null,
      queuedNormal: queueNormal.length,
      queuedCritical: queueCritical.length,
      consecutiveCritical,
      limits: {
        executionTimeoutMs,
        queueWaitTimeoutMs,
        maxNormalQueue,
        maxCriticalQueue,
        maxConsecutiveCritical
      }
    };
  }

  function close(reason = PS_FAULT_CODES.CLOSED) {
    if (closed) return;
    closed = true;
    const queued = [...queueCritical, ...queueNormal];
    queueCritical.length = 0;
    queueNormal.length = 0;
    const current = inFlight;
    inFlight = null;
    pending.clear();
    const dying = worker;
    worker = null;
    dead = true;
    for (const entry of queued) {
      settleReject(entry, fault(reason, 'PS worker pool closed', { dispatched: false, critical: entry.critical }));
    }
    if (current) {
      settleReject(current, fault(reason, 'PS worker pool closed', {
        dispatched: Boolean(current.dispatchedAt),
        critical: current.critical
      }));
    }
    if (dying) {
      try { dying.removeAllListeners?.(); } catch (_) {}
    }
  }

  return { send, getStats, close, isDead: () => dead, noop };
}

/**
 * Global budget for STANDALONE PowerShell helpers (the fallback path used for
 * read-only/idempotent actions when the shared worker cannot be used).
 *
 * Before this budget the fallback spawned one `powershell` per call with no
 * bound at all: a burst of Inspect/Verify could start a dozen interpreters and
 * the manager's own memory pressure is what the user sees as "parallel tunnels
 * squeezed out the control chain". Peak is now 2 helpers: 1 normal + 1 reserved
 * for a critical control service.
 */
export function createHelperBudget(options = {}) {
  const {
    maxTotal = 2,
    maxNormal = 1,
    maxWaiting = 8,
    waitTimeoutMs = 5000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = options || {};

  let activeNormal = 0;
  let activeCritical = 0;
  let closed = false;
  const waiters = [];

  function total() { return activeNormal + activeCritical; }

  function canAdmit(critical) {
    if (closed) return false;
    if (total() >= maxTotal) return false;
    if (!critical && activeNormal >= maxNormal) return false;
    return true;
  }

  /**
   * Chooses the next waiter to admit.
   *
   * The reserved critical slot is the whole point of this budget, so a critical
   * waiter must never be blocked behind a normal waiter that happens to sit at
   * the head of the queue: with `maxNormal` already in use, a head-first pump
   * returned early and left the reserved slot idle until the running normal
   * helper finished. That is precisely the congestion the reserve exists for.
   */
  function pickWaiterIndex() {
    const settledIndex = waiters.findIndex(waiter => waiter.settled);
    if (settledIndex !== -1) return settledIndex;
    if (canAdmit(true)) {
      const criticalIndex = waiters.findIndex(waiter => waiter.critical);
      if (criticalIndex !== -1) return criticalIndex;
    }
    for (let i = 0; i < waiters.length; i += 1) {
      if (canAdmit(waiters[i].critical)) return i;
    }
    return -1;
  }

  function pump() {
    while (total() < maxTotal) {
      const index = pickWaiterIndex();
      if (index === -1) return;
      const [picked] = waiters.splice(index, 1);
      if (!picked || picked.settled) continue;
      if (picked.timer) { clearTimeoutFn(picked.timer); picked.timer = null; }
      picked.settled = true;
      grant(picked.critical, picked.resolve);
    }
  }

  function grant(critical, resolve) {
    if (critical) activeCritical += 1;
    else activeNormal += 1;
    let released = false;
    resolve(() => {
      if (released) return;
      released = true;
      if (critical) activeCritical = Math.max(0, activeCritical - 1);
      else activeNormal = Math.max(0, activeNormal - 1);
      pump();
    });
  }

  function acquire({ critical = false } = {}) {
    const role = critical === true;
    if (canAdmit(role)) {
      return new Promise(resolve => grant(role, resolve));
    }
    if (closed) {
      return Promise.reject(new PsWorkerFault(PS_FAULT_CODES.CLOSED, 'PS helper budget is closed',
        { dispatched: false, critical: role }));
    }
    if (waiters.length >= maxWaiting) {
      return Promise.reject(new PsWorkerFault(PS_FAULT_CODES.QUEUE_FULL, 'PS helper helper queue is full',
        { dispatched: false, critical: role }));
    }
    return new Promise((resolve, reject) => {
      const waiter = { critical: role, resolve, reject, timer: null, settled: false };
      waiters.push(waiter);
      waiter.timer = setTimeoutFn(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new PsWorkerFault(PS_FAULT_CODES.QUEUE_TIMEOUT, 'PS helper waited too long for a slot',
          { dispatched: false, critical: role }));
      }, waitTimeoutMs);
      // A pending acquire owns this bounded timer until grant, timeout, or
      // close; unref would let the public promise disappear on process exit.
    });
  }

  function getStats() {
    return { maxTotal, maxNormal, maxWaiting, waitTimeoutMs, active: total(), activeNormal,
      activeCritical, waiting: waiters.length, closed };
  }

  function close() {
    closed = true;
    const pending = waiters.splice(0, waiters.length);
    for (const waiter of pending) {
      if (waiter.timer) clearTimeoutFn(waiter.timer);
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.reject(new PsWorkerFault(PS_FAULT_CODES.CLOSED, 'PS helper budget is closed',
        { dispatched: false, critical: waiter.critical }));
    }
  }

  return { acquire, getStats, close };
}
