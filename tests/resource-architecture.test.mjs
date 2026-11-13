/**
 * Resource-architecture suite (2026-11-13).
 *
 * Everything here is FAKE: no tunnel-client, no PowerShell, no network, no
 * production dataDir. Each case drives a REAL production entry point with an
 * injected fake, so a regression in the wiring (not just in a helper) turns the
 * test red:
 *
 *   src/core/resource-policy.mjs          -> via runner/lifecycle/switch entries
 *   src/adapters/ps-worker-pool.mjs       -> via createDefaultProcessController
 *   src/adapters/runtime-observer.mjs     -> via createRuntimeObserver
 *   src/server.mjs                        -> via createHttpServer (fake runner gate)
 *   public/app.js                         -> via loadDashboardData (fake fetch)
 *
 * All temp dirs and logs stay inside the worktree:
 *   artifacts/resource-architecture-20261113/tmp
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { createResourcePolicy, DEFAULT_CRITICAL_SERVICE_IDS } from '../src/core/resource-policy.mjs';
import { createPsWorkerPool, createHelperBudget, PsWorkerFault, PS_FAULT_CODES } from '../src/adapters/ps-worker-pool.mjs';
import { createDefaultProcessController } from '../src/adapters/index.mjs';
import { createRegisteredAdapterProvider } from '../src/adapters/registry-provider.mjs';
import { createRuntimeObserver, createObservationLimiter } from '../src/adapters/runtime-observer.mjs';
import { runMcpLifecycleAction } from '../src/core/mcp-lifecycle.mjs';
import { executeOperation } from '../src/core/switch-core.mjs';
import { createHttpServer } from '../src/server.mjs';
import { createRunner } from '../src/runner.mjs';
import { loadDashboardData } from '../public/app.js';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');
const ARTIFACT_ROOT = path.join(projectRoot, 'artifacts', 'resource-architecture-20261113');
const TMP_ROOT = path.join(ARTIFACT_ROOT, 'tmp');

fs.mkdirSync(TMP_ROOT, { recursive: true });

/** Temp dir confined to the worktree; the test owns cleanup of exactly this dir. */
function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });
  return dir;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// 1. Shared start budget (resource-policy)
// ---------------------------------------------------------------------------

test('start budget: N=1/4/8/32 concurrent starts never exceed the shared limit', async (t) => {
  const policy = createResourcePolicy({
    maxConcurrentStarts: 4,
    maxWaitingStarts: 64,
    waitTimeoutMs: 2000,
    availableMemoryBytes: () => 16 * 1024 ** 3
  });
  t.after(() => policy.close());

  for (const n of [1, 4, 8, 32]) {
    const peak = { active: 0 };
    const holdMs = 8;
    const starts = Array.from({ length: n }, (_, i) => (async () => {
      const reservation = await policy.admitStart({ serviceId: `svc-${n}-${i}`, carrier: false, kind: 'start' });
      peak.active = Math.max(peak.active, policy.getStats().activeStarts);
      await sleep(holdMs);
      policy.release(reservation);
      return reservation;
    })());
    const reservations = await Promise.all(starts);
    assert.equal(reservations.length, n, `N=${n}: every start is admitted eventually`);
    assert.ok(peak.active <= 4, `N=${n}: peak active ${peak.active} must stay <= 4`);
    assert.equal(policy.getStats().activeStarts, 0, `N=${n}: every reservation is released`);
    assert.equal(policy.getStats().waitingStarts, 0, `N=${n}: no waiter is left behind`);
  }
});

test('start budget: a full budget refuses NEW starts instead of evicting a running client', async (t) => {
  const policy = createResourcePolicy({
    maxConcurrentStarts: 2, waitTimeoutMs: 0, availableMemoryBytes: () => 16 * 1024 ** 3
  });
  t.after(() => policy.close());
  const a = await policy.admitStart({ serviceId: 'svc-a' });
  const b = await policy.admitStart({ serviceId: 'svc-b' });
  await assert.rejects(() => policy.admitStart({ serviceId: 'svc-c' }),
    error => error.code === 'START_QUEUE_FULL');
  // The two existing reservations are untouched by the refusal.
  assert.equal(policy.getStats().activeStarts, 2);
  policy.release(a);
  policy.release(b);
  const c = await policy.admitStart({ serviceId: 'svc-c' });
  assert.equal(c.role, 'normal');
});

test('start budget: critical control carriers keep their reserve under memory pressure', async (t) => {
  const free = { bytes: 3 * 1024 ** 3 };
  const policy = createResourcePolicy({
    maxConcurrentStarts: 8, waitTimeoutMs: 0, availableMemoryBytes: () => free.bytes
  });
  t.after(() => policy.close());

  // 2 GiB normal reserve: 3 GiB free admits one normal start, then refuses.
  const first = await policy.admitStart({ serviceId: 'overleaf-mcp' });
  assert.equal(first.role, 'normal');
  await assert.rejects(() => policy.admitStart({ serviceId: 'overleaf-mcp' }),
    error => error.code === 'INSUFFICIENT_MEMORY' && error.role === 'normal');

  // A critical carrier only needs 512 MiB and is still admitted.
  const critical = await policy.admitStart({ serviceId: 'mcp_dsh_chatgpt_bridge' });
  assert.equal(critical.role, 'critical');
  const carrierFlag = await policy.admitStart({ serviceId: 'some-other-mcp', carrier: true });
  assert.equal(carrierFlag.role, 'critical', 'a stored controlCarrier flag makes a service critical');

  policy.release(first);
  policy.release(critical);
  policy.release(carrierFlag);
});

test('start budget: an unreadable memory probe fails closed for NEW starts only', async (t) => {
  const policy = createResourcePolicy({
    maxConcurrentStarts: 4,
    waitTimeoutMs: 0,
    availableMemoryBytes: () => { throw new Error('probe unavailable'); }
  });
  t.after(() => policy.close());
  await assert.rejects(() => policy.admitStart({ serviceId: 'overleaf-mcp' }),
    error => error.code === 'INSUFFICIENT_MEMORY');
  assert.equal(policy.getStats().activeStarts, 0);
});

test('start budget: DEFAULT_CRITICAL_SERVICE_IDS keeps the GPT control chain critical', () => {
  assert.deepEqual([...DEFAULT_CRITICAL_SERVICE_IDS].sort(),
    ['antigravity-mcp', 'mcp_dsh_chatgpt_bridge'].sort());
});

test('start budget: queued waiters are bounded and timed out with their own code', async (t) => {
  const policy = createResourcePolicy({
    maxConcurrentStarts: 1, maxWaitingStarts: 2, waitTimeoutMs: 40,
    availableMemoryBytes: () => 16 * 1024 ** 3
  });
  t.after(() => policy.close());
  const held = await policy.admitStart({ serviceId: 'svc-held' });
  const w1 = policy.admitStart({ serviceId: 'svc-w1' }).catch(error => error.code);
  const w2 = policy.admitStart({ serviceId: 'svc-w2' }).catch(error => error.code);
  await assert.rejects(() => policy.admitStart({ serviceId: 'svc-w3' }),
    error => error.code === 'START_QUEUE_FULL');
  assert.equal(await w1, 'START_QUEUE_TIMEOUT');
  assert.equal(await w2, 'START_QUEUE_TIMEOUT');
  policy.release(held);
  assert.equal(policy.getStats().waitingStarts, 0);
});

test('start budget: a critical waiter is admitted before an older normal waiter', async (t) => {
  const policy = createResourcePolicy({
    maxConcurrentStarts: 1, maxWaitingStarts: 8, waitTimeoutMs: 1000,
    availableMemoryBytes: () => 16 * 1024 ** 3
  });
  t.after(() => policy.close());
  const held = await policy.admitStart({ serviceId: 'svc-held' });
  const order = [];
  const normal = policy.admitStart({ serviceId: 'overleaf-mcp' }).then(r => { order.push('normal'); return r; });
  await sleep(5);
  const critical = policy.admitStart({ serviceId: 'antigravity-mcp' }).then(r => { order.push('critical'); return r; });
  await sleep(5);
  policy.release(held);
  const criticalReservation = await critical;
  assert.deepEqual(order, ['critical'], 'the reserved control-chain slot is not queued behind normal work');
  policy.release(criticalReservation);
  const normalReservation = await normal;
  assert.deepEqual(order, ['critical', 'normal']);
  policy.release(normalReservation);
});

test('start budget: admitBatch reserves the whole batch and follows its weakest role', async (t) => {
  const free = { bytes: 6 * 1024 ** 3 };
  const policy = createResourcePolicy({
    maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => free.bytes
  });
  t.after(() => policy.close());

  const batch = await policy.admitBatch({
    serviceIds: ['overleaf-mcp', 'mcp_speed_f', 'antigravity-mcp'], carriers: [false, false, true]
  });
  assert.equal(batch.role, 'critical', 'a carrier in the batch keeps critical SCHEDULING priority');
  assert.equal(batch.memoryRole, 'normal', 'but the MEMORY headroom follows the ordinary service in the batch');
  assert.equal(batch.bytes, 2 * 1024 ** 3 + 2 * 1024 ** 3 + 512 * 1024 ** 2,
    'every start the batch will make is reserved, not just the first one');
  assert.equal(policy.getStats().reservedBytes, batch.bytes);

  // A concurrent NEW start cannot be admitted against memory this batch will use.
  await assert.rejects(() => policy.admitStart({ serviceId: 'overleaf-mcp' }),
    error => error.code === 'INSUFFICIENT_MEMORY');
  assert.equal(policy.getStats().activeStarts, 1, 'the batch still holds exactly one slot');

  policy.release(batch);
  assert.equal(policy.getStats().activeStarts, 0, 'the batch reservation is released in the caller\'s finally');
  assert.equal(policy.getStats().reservedBytes, 0);
});

test('start budget: a mixed batch must leave the critical reserve untouched', async (t) => {
  const batchBytes = 2 * 1024 ** 3 + 512 * 1024 ** 2;   // one normal + one carrier start
  const tight = createResourcePolicy({
    maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => batchBytes - 1
  });
  t.after(() => tight.close());
  // Summing the batch alone is not enough: the ordinary service in it also has to
  // leave the 512 MiB critical reserve untouched.
  await assert.rejects(() => tight.admitBatch({ serviceIds: ['overleaf-mcp', 'antigravity-mcp'] }),
    error => error.code === 'INSUFFICIENT_MEMORY' && error.role === 'normal');

  const exact = createResourcePolicy({
    maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => batchBytes + 512 * 1024 ** 2
  });
  t.after(() => exact.close());
  const reservation = await exact.admitBatch({ serviceIds: ['overleaf-mcp', 'antigravity-mcp'] });
  assert.equal(reservation.bytes, batchBytes, 'the batch reserves every start it will make');
  assert.equal(reservation.role, 'critical', 'scheduling priority is unchanged');
  exact.release(reservation);
});

test('start budget: close() rejects every waiter and releases every reservation', async (t) => {
  const policy = createResourcePolicy({
    maxConcurrentStarts: 1, maxWaitingStarts: 4, waitTimeoutMs: 5000,
    availableMemoryBytes: () => 16 * 1024 ** 3
  });
  const held = await policy.admitStart({ serviceId: 'svc-held' });
  const waiter = policy.admitStart({ serviceId: 'svc-waiting' }).catch(error => error.code);
  policy.close();
  assert.equal(await waiter, 'POLICY_CLOSED');
  assert.equal(policy.getStats().activeStarts, 0);
  assert.equal(policy.getStats().waitingStarts, 0);
  // A late release after close must be inert, never a throw.
  assert.doesNotThrow(() => policy.release(held));
  await assert.rejects(() => policy.admitStart({ serviceId: 'svc-late' }),
    error => error.code === 'POLICY_CLOSED');
});

// ---------------------------------------------------------------------------
// 2. PowerShell worker pool: real dispatch timing, bounded queues, no replay
// ---------------------------------------------------------------------------

function fakeWorker() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.writes = [];
  child.stdin = {
    write(line) {
      child.writes.push(String(line));
      return true;
    },
    unref() {}
  };
  child.kill = () => {};
  // Emit spawn on the next tick, like a real child_process would.
  process.nextTick(() => child.emit('spawn'));
  return child;
}

function respond(child, id, payload) {
  child.stdout.emit('data', `__MCP_PS_RESP__${JSON.stringify({ id, code: 0, stdout: JSON.stringify(payload) })}\n`);
}

function writtenIds(child) {
  return child.writes.map(line => JSON.parse(line.trim()).id);
}

test('ps pool: one request on the pipe at a time and the queue is bounded (8 normal / 4 critical)', async (t) => {
  const child = fakeWorker();
  const pool = createPsWorkerPool({ spawnWorker: () => child, maxNormalQueue: 2, maxCriticalQueue: 1 });
  t.after(() => pool.close());

  const inFlight = pool.send('x.ps1', { n: 0 });
  assert.deepEqual(writtenIds(child).length, 1, 'the first request is dispatched immediately');

  const n1 = pool.send('x.ps1', { n: 1 });
  const n2 = pool.send('x.ps1', { n: 2 });
  await assert.rejects(() => pool.send('x.ps1', { n: 3 }),
    error => error instanceof PsWorkerFault && error.code === PS_FAULT_CODES.QUEUE_FULL && error.dispatched === false);

  // The critical queue is a SEPARATE reserve: a full normal queue does not block it.
  const c1 = pool.send('x.ps1', { n: 'c1' }, { critical: true });
  await assert.rejects(() => pool.send('x.ps1', { n: 'c2' }, { critical: true }),
    error => error.code === PS_FAULT_CODES.QUEUE_FULL && error.critical === true);

  const stats = pool.getStats();
  assert.equal(stats.queuedNormal, 2);
  assert.equal(stats.queuedCritical, 1);
  assert.notEqual(stats.inflight, null);
  assert.equal(writtenIds(child).length, 1, 'nothing else reached the pipe');

  // Drain: every answer frees the pipe for exactly one more request.
  const settled = [];
  for (const promise of [inFlight, n1, n2, c1]) settled.push(promise.then(value => ({ value })));
  for (let i = 0; i < 4; i += 1) {
    const ids = writtenIds(child);
    assert.equal(ids.length, i + 1, `request ${i + 1} is dispatched only after the previous answer`);
    respond(child, ids[i], { ok: i });
    await sleep(5);
  }
  const values = await Promise.all(settled);
  assert.equal(values.length, 4);
  assert.equal(pool.getStats().completed, 4);
  assert.equal(pool.getStats().dispatched, 4);
});

test('ps pool: the execution timer starts at DISPATCH, not at enqueue', async (t) => {
  const child = fakeWorker();
  const pool = createPsWorkerPool({
    spawnWorker: () => child, executionTimeoutMs: 150, queueWaitTimeoutMs: 5000,
    maxNormalQueue: 4, maxCriticalQueue: 2
  });
  t.after(() => pool.close());

  const first = pool.send('x.ps1', { n: 'first' });
  const enqueuedAt = Date.now();
  const second = pool.send('x.ps1', { n: 'second' });
  await sleep(110);
  // Answer the first request after 110ms; the second is then dispatched ~110ms
  // after it was enqueued. If the execution timer had started at enqueue it
  // would already have ~40ms left and fire before we answer it.
  respond(child, writtenIds(child)[0], { ok: 'first' });
  await first;
  await sleep(20);
  assert.equal(writtenIds(child).length, 2, 'the queued request is dispatched after the pipe frees up');
  const dispatchedAfterMs = Date.now() - enqueuedAt;
  assert.ok(dispatchedAfterMs >= 100, `second request waited for the pipe (${dispatchedAfterMs}ms)`);

  await sleep(60);
  assert.equal(pool.getStats().timedOut, 0, 'the execution deadline restarted at dispatch');
  respond(child, writtenIds(child)[1], { ok: 'second' });
  const result = await second;
  assert.equal(result.ok, 'second');
});

test('ps pool: a dispatch timeout rejects but never replays, and holds the pipe until the late answer', async (t) => {
  const child = fakeWorker();
  const pool = createPsWorkerPool({
    spawnWorker: () => child, executionTimeoutMs: 40, queueWaitTimeoutMs: 5000,
    maxNormalQueue: 4, maxCriticalQueue: 2
  });
  t.after(() => pool.close());

  const slow = pool.send('x.ps1', { n: 'slow' });
  await assert.rejects(() => slow, error => {
    assert.equal(error.code, PS_FAULT_CODES.EXECUTION_TIMEOUT);
    assert.equal(error.dispatched, true, 'a dispatched request must never be replayed elsewhere');
    return true;
  });

  const next = pool.send('x.ps1', { n: 'next' });
  await sleep(20);
  assert.equal(writtenIds(child).length, 1, 'no new dispatch while the late response is outstanding');
  assert.equal(pool.getStats().queuedNormal, 1);

  const firstId = writtenIds(child)[0];
  respond(child, firstId, { ok: 'late' });
  await sleep(20);
  const ids = writtenIds(child);
  assert.equal(ids.length, 2, 'the pipe is released only by the late answer');
  assert.equal(ids.filter(id => id === firstId).length, 1, 'the timed-out request is never re-sent');
  assert.equal(pool.getStats().lateResponses, 1);

  respond(child, ids[1], { ok: 'next' });
  assert.equal((await next).ok, 'next');
});

test('ps pool: worker death fails in-flight and queued requests and clears every timer', async (t) => {
  const child = fakeWorker();
  const pool = createPsWorkerPool({
    spawnWorker: () => child, executionTimeoutMs: 5000, queueWaitTimeoutMs: 5000,
    maxNormalQueue: 4, maxCriticalQueue: 2
  });
  t.after(() => pool.close());

  const inFlight = pool.send('x.ps1', { n: 0 });
  const queued = pool.send('x.ps1', { n: 1 });
  child.emit('close');
  await assert.rejects(() => inFlight, error => error.code === PS_FAULT_CODES.EXITED);
  await assert.rejects(() => queued, error => error.code === PS_FAULT_CODES.EXITED && error.dispatched === false);
  assert.equal(pool.isDead(), true);
  await assert.rejects(() => pool.send('x.ps1', { n: 2 }),
    error => error.code === PS_FAULT_CODES.UNAVAILABLE);
});

test('ps pool: close() rejects queued work with CLOSED and spawns nothing afterwards', async (t) => {
  const child = fakeWorker();
  let spawns = 0;
  const pool = createPsWorkerPool({
    spawnWorker: () => { spawns += 1; return child; },
    executionTimeoutMs: 5000, queueWaitTimeoutMs: 5000, maxNormalQueue: 4, maxCriticalQueue: 2
  });
  const inFlight = pool.send('x.ps1', { n: 0 });
  const queued = pool.send('x.ps1', { n: 1 });
  pool.close();
  await assert.rejects(() => inFlight, error => error.code === PS_FAULT_CODES.CLOSED);
  await assert.rejects(() => queued, error => error.code === PS_FAULT_CODES.CLOSED);
  await assert.rejects(() => pool.send('x.ps1', { n: 2 }), error => error.code === PS_FAULT_CODES.CLOSED);
  assert.equal(spawns, 1, 'a closed pool never respawns a helper');
});

// ---------------------------------------------------------------------------
// 3. Standalone helper lane: bounded peak, congestion never becomes a storm
// ---------------------------------------------------------------------------

function fakeSpawnHelper() {
  const calls = [];
  const state = { active: 0, peak: 0, activeNormal: 0, peakNormal: 0 };
  const spawnHelper = (command, args) => {
    calls.push({ command, args });
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    const isCritical = args.includes('Verify') || args.includes('antigravity-mcp');
    if (!isCritical) {
      state.activeNormal += 1;
      state.peakNormal = Math.max(state.peakNormal, state.activeNormal);
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    setTimeout(() => {
      state.active -= 1;
      if (!isCritical) state.activeNormal -= 1;
      child.stdout.emit('data', JSON.stringify({ running: false, success: true }));
      child.emit('close', 0);
    }, 30);
    return child;
  };
  return { spawnHelper, calls, state };
}

function deadPool(code, extra = {}) {
  return {
    send() {
      return Promise.reject(new PsWorkerFault(code, `fake ${code}`, { dispatched: false, ...extra }));
    },
    getStats: () => ({})
  };
}

const VERIFY_IDENTITY = {
  pid: 4242,
  executablePath: 'C:\\fake\\tunnel-client.exe',
  startedAt: '2026-11-13T00:00:00.000Z',
  service: 'overleaf-mcp'
};

/** Seeds an owned-process record so `inspect()` goes straight to the helper lane. */
function seedStoredProcess(dataDir, service, pid = 4242) {
  const runtimeDir = path.join(dataDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, `${service}-process.json`), JSON.stringify({
    pid,
    startedAt: '2026-11-13T00:00:00.000Z',
    executablePath: 'C:\\fake\\tunnel-client.exe',
    service
  }));
}

test('helper lane: congestion is surfaced as a fault and NEVER spawns a process storm', async (t) => {
  const dataDir = makeTempDir(t, 'helper-congested');
  const scriptPath = path.join(dataDir, 'process-control.ps1');
  fs.writeFileSync(scriptPath, '# fake');
  seedStoredProcess(dataDir, 'overleaf-mcp');
  const { spawnHelper, calls } = fakeSpawnHelper();

  for (const code of [PS_FAULT_CODES.QUEUE_FULL, PS_FAULT_CODES.QUEUE_TIMEOUT, PS_FAULT_CODES.EXECUTION_TIMEOUT]) {
    const controller = createDefaultProcessController({
      dataDir, scriptPath, psWorkerPool: deadPool(code), spawnHelper,
      helperBudget: createHelperBudget({ waitTimeoutMs: 50 })
    });
    await assert.rejects(() => controller.inspect('overleaf-mcp', { allowExternalScan: false }), error => {
      const expected = code === PS_FAULT_CODES.EXECUTION_TIMEOUT
        ? 'PROCESS_CONTROL_TIMEOUT' : 'PROCESS_CONTROL_CONGESTED';
      assert.equal(error.code, expected, `${code} must map to ${expected}`);
      return true;
    });
  }
  assert.equal(calls.length, 0, 'a busy worker must not be replaced by standalone helpers');
});

test('helper lane: a control-channel fault is never published as verified absence', async (t) => {
  const dataDir = makeTempDir(t, 'helper-absence');
  const scriptPath = path.join(dataDir, 'process-control.ps1');
  fs.writeFileSync(scriptPath, '# fake');
  seedStoredProcess(dataDir, 'overleaf-mcp');
  const controller = createDefaultProcessController({
    dataDir, scriptPath, psWorkerPool: deadPool(PS_FAULT_CODES.QUEUE_FULL),
    spawnHelper: fakeSpawnHelper().spawnHelper, helperBudget: createHelperBudget({ waitTimeoutMs: 20 })
  });

  // The old code swallowed this error and returned {running:false, absenceVerified:true},
  // which is a POSITIVE absence proof that a stop/removal would consume.
  await assert.rejects(() => controller.inspect('overleaf-mcp', { allowExternalScan: false }),
    error => error.code === 'PROCESS_CONTROL_CONGESTED');
});

test('helper lane: a provably-undispatched worker failure falls back exactly once', async (t) => {
  const dataDir = makeTempDir(t, 'helper-fallback');
  const scriptPath = path.join(dataDir, 'process-control.ps1');
  fs.writeFileSync(scriptPath, '# fake');
  seedStoredProcess(dataDir, 'overleaf-mcp');
  const { spawnHelper, calls } = fakeSpawnHelper();
  const budget = createHelperBudget({});
  const controller = createDefaultProcessController({
    dataDir, scriptPath, psWorkerPool: deadPool(PS_FAULT_CODES.UNAVAILABLE), spawnHelper, helperBudget: budget
  });

  const verdict = await controller.verify(VERIFY_IDENTITY);
  assert.equal(typeof verdict.valid, 'boolean');
  assert.equal(calls.length, 1, 'the fallback lane is used once');
  assert.equal(budget.getStats().active, 0, 'the helper slot is released in a finally');
});

test('helper lane: peak is 2 total and 1 normal under a burst of read-only calls', async (t) => {
  const dataDir = makeTempDir(t, 'helper-peak');
  const scriptPath = path.join(dataDir, 'process-control.ps1');
  fs.writeFileSync(scriptPath, '# fake');
  const { spawnHelper, state } = fakeSpawnHelper();
  const budget = createHelperBudget({ maxTotal: 2, maxNormal: 1, waitTimeoutMs: 500 });
  const controller = createDefaultProcessController({
    dataDir, scriptPath, psWorkerPool: deadPool(PS_FAULT_CODES.UNAVAILABLE), spawnHelper, helperBudget: budget
  });

  const calls = [];
  for (let i = 0; i < 6; i += 1) calls.push(controller.inspect('overleaf-mcp').catch(() => null));
  // One critical (control-carrier) call must get the reserved slot immediately.
  calls.push(controller.verify({
    pid: 4242,
    executablePath: 'C:\\fake\\tunnel-client.exe',
    startedAt: '2026-11-13T00:00:00.000Z',
    service: 'antigravity-mcp'
  }).catch(() => null));
  await Promise.all(calls);

  assert.ok(state.peak <= 2, `peak helpers ${state.peak} must stay <= 2`);
  assert.ok(state.peakNormal <= 1, `peak normal helpers ${state.peakNormal} must stay <= 1`);
  assert.equal(budget.getStats().active, 0);
});

test('helper lane: a Launch is never replayed through the standalone lane', async (t) => {
  const dataDir = makeTempDir(t, 'helper-launch');
  const scriptPath = path.join(dataDir, 'process-control.ps1');
  fs.writeFileSync(scriptPath, '# fake');
  const { spawnHelper, calls } = fakeSpawnHelper();
  const controller = createDefaultProcessController({
    dataDir, scriptPath, psWorkerPool: deadPool(PS_FAULT_CODES.EXECUTION_TIMEOUT), spawnHelper,
    helperBudget: createHelperBudget({})
  });

  await assert.rejects(
    () => controller.launch({ service: 'overleaf-mcp', command: process.execPath, args: [], operationId: 'op-launch' }),
    error => {
      assert.equal(error.code, 'PROCESS_LAUNCH_UNCONFIRMED');
      return true;
    });
  assert.equal(calls.length, 0, 'an unconfirmed launch must not become a second untracked tunnel');
});

// ---------------------------------------------------------------------------
// 3b. Fallback helper: a kill request is NOT an exit (slot stays occupied)
// ---------------------------------------------------------------------------

function lateCloseSpawnHelper({ closeDelayMs = 120 } = {}) {
  const events = [];
  const state = { live: 0, peak: 0, spawns: 0, kills: 0 };
  const spawnHelper = () => {
    state.spawns += 1;
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    events.push({ type: 'spawn', at: Date.now(), live: state.live });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let closed = false;
    const closeIt = () => {
      if (closed) return;
      closed = true;
      state.live -= 1;
      events.push({ type: 'close', at: Date.now(), live: state.live });
      child.emit('close', 0);
    };
    child.kill = () => {
      state.kills += 1;
      events.push({ type: 'kill', at: Date.now() });
      setTimeout(closeIt, closeDelayMs);
    };
    return child;
  };
  return { spawnHelper, events, state };
}

test('helper lane: after a kill request the slot stays occupied until the process actually exits', async (t) => {
  const dataDir = makeTempDir(t, 'helper-late-close');
  const scriptPath = path.join(dataDir, 'process-control.ps1');
  fs.writeFileSync(scriptPath, '# fake');
  seedStoredProcess(dataDir, 'overleaf-mcp');
  const { spawnHelper, state } = lateCloseSpawnHelper({ closeDelayMs: 140 });
  const budget = createHelperBudget({ maxTotal: 2, maxNormal: 1, waitTimeoutMs: 2000 });
  const controller = createDefaultProcessController({
    dataDir, scriptPath, psWorkerPool: deadPool(PS_FAULT_CODES.UNAVAILABLE), spawnHelper,
    helperBudget: budget, helperExecutionTimeoutMs: 40, helperKillGraceMs: 3000
  });

  const outcomes = [];
  const first = controller.verify(VERIFY_IDENTITY).then(() => 'ok', e => e.code);
  const second = controller.verify(VERIFY_IDENTITY).then(() => 'ok', e => e.code);
  outcomes.push(first, second);

  await sleep(70);   // the 40ms deadline has fired and kill() was requested
  assert.equal(state.kills, 1, 'the hung helper was asked to terminate');
  assert.equal(state.spawns, 1, 'no replacement helper is spawned while the killed one is still alive');
  assert.equal(budget.getStats().active, 1, 'the budget slot is still held after kill() returned');
  assert.equal(state.live, 1, 'exactly one real helper exists');

  await sleep(150);  // the child finally reports close
  assert.equal(budget.getStats().active <= 1, true);
  const results = await Promise.all(outcomes);
  assert.equal(results[0], 'PS_HELPER_TIMEOUT', 'the timed-out call reports a timeout, not a success');
  assert.ok(state.peak <= 1, `normal helper peak ${state.peak} must stay <= 1`);
});

const NORMAL_HELPER_PID = 4242;
const CRITICAL_HELPER_PID = 4243;

/**
 * A helper that is spawned, answers NOTHING, ignores kill() (kill() returns
 * false = the termination never happened) and never emits 'close'. This is the
 * worst case for a "the caller timed out, so the slot is free" assumption.
 */
function neverClosingSpawnHelper() {
  const children = [];
  const state = { spawns: 0, live: 0, peak: 0, liveNormal: 0, peakNormal: 0, kills: 0 };
  const spawnHelper = (_command, args) => {
    const pidIndex = args.indexOf('-ProcessId');
    const pid = pidIndex === -1 ? null : Number(args[pidIndex + 1]);
    const critical = pid === CRITICAL_HELPER_PID;
    state.spawns += 1;
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    if (!critical) {
      state.liveNormal += 1;
      state.peakNormal = Math.max(state.peakNormal, state.liveNormal);
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let closed = false;
    const closeIt = () => {
      if (closed) return;
      closed = true;
      state.live -= 1;
      if (!critical) state.liveNormal -= 1;
      child.emit('close', 0);
    };
    child.kill = () => { state.kills += 1; return false; };  // the kill request never takes effect
    children.push(closeIt);
    return child;
  };
  return {
    spawnHelper,
    state,
    closeChild(index) { children[index]?.(); },
    closeAll() { for (const closeIt of children) closeIt(); }
  };
}

test('helper lane: a never-closing helper keeps the PHYSICAL lease after the PUBLIC call times out', async (t) => {
  const dataDir = makeTempDir(t, 'helper-never-close');
  const scriptPath = path.join(dataDir, 'process-control.ps1');
  fs.writeFileSync(scriptPath, '# fake');
  seedStoredProcess(dataDir, 'overleaf-mcp');
  const { spawnHelper, state, closeChild, closeAll } = neverClosingSpawnHelper();

  // Audit timers: every deadline/grace/queue timer this controller+budget create
  // is tracked, so a leaked timer after the queue terminates is observable.
  const liveTimers = new Set();
  const trackedSetTimeout = (fn, ms) => {
    const handle = setTimeout(() => { liveTimers.delete(handle); fn(); }, ms);
    liveTimers.add(handle);
    return handle;
  };
  const trackedClearTimeout = handle => { liveTimers.delete(handle); return clearTimeout(handle); };

  const budget = createHelperBudget({
    maxTotal: 2, maxNormal: 1, waitTimeoutMs: 120,
    setTimeoutFn: trackedSetTimeout, clearTimeoutFn: trackedClearTimeout
  });
  const controller = createDefaultProcessController({
    dataDir, scriptPath, psWorkerPool: deadPool(PS_FAULT_CODES.UNAVAILABLE), spawnHelper,
    helperBudget: budget, helperExecutionTimeoutMs: 25, helperKillGraceMs: 40,
    setTimeoutFn: trackedSetTimeout, clearTimeoutFn: trackedClearTimeout
  });
  t.after(() => { closeAll(); budget.close(); });

  // 1. The PUBLIC call gives up on time with an explicit error...
  const firstOutcome = await controller.verify(VERIFY_IDENTITY)
    .then(() => 'ok', error => `${error.code}${error.exitUnconfirmed ? ':unconfirmed' : ''}`);
  assert.equal(firstOutcome, 'PS_HELPER_TIMEOUT:unconfirmed', 'the caller gets an explicit exitUnconfirmed code');
  assert.equal(state.kills, 1, 'the hung helper was asked to terminate, and kill() failed');
  assert.equal(state.spawns, 1);
  assert.equal(state.live, 1);
  // ...but the PHYSICAL lease still belongs to that live process.
  assert.equal(budget.getStats().active, 1, 'the physical slot is NOT returned when the public promise rejects');

  // 2. Further normal batches cannot turn the timed-out caller into a new helper.
  const normalBatch = await Promise.all(Array.from({ length: 3 }, () =>
    controller.verify(VERIFY_IDENTITY).then(() => 'ok', error => error.code)));
  assert.deepEqual(normalBatch, Array(3).fill('PROCESS_CONTROL_CONGESTED'),
    'waiting normal calls are refused (bounded), never respawned');
  assert.equal(state.spawns, 1, 'no replacement normal helper is spawned while the first one is alive');
  assert.ok(state.peakNormal <= 1, `peak live normal helpers ${state.peakNormal} must stay <= 1`);

  // 3. The reserved critical slot is still usable, and its own lease is held too.
  const criticalOutcome = await controller.verify({
    ...VERIFY_IDENTITY, pid: CRITICAL_HELPER_PID, service: 'antigravity-mcp'
  }).then(() => 'ok', error => `${error.code}${error.exitUnconfirmed ? ':unconfirmed' : ''}`);
  assert.equal(criticalOutcome, 'PS_HELPER_TIMEOUT:unconfirmed', 'the reserved critical slot still admits one helper');
  assert.equal(state.spawns, 2);
  assert.equal(state.live, 2);
  assert.ok(state.peak <= 2, `peak helpers ${state.peak} must stay <= 2`);
  assert.equal(budget.getStats().active, 2, 'both live helpers keep their leases');

  const extraCritical = await controller.verify({
    ...VERIFY_IDENTITY, pid: CRITICAL_HELPER_PID + 1, service: 'antigravity-mcp'
  }).then(() => 'ok', error => error.code);
  assert.equal(extraCritical, 'PROCESS_CONTROL_CONGESTED', 'with both slots live, critical work waits and is refused');
  assert.equal(state.spawns, 2, 'still no extra process');

  // 4. Queue termination leaves no timer behind.
  assert.equal(budget.getStats().waiting, 0, 'every queued caller was terminated');
  assert.equal(liveTimers.size, 0, `no timer may outlive the terminated queue (${liveTimers.size} left)`);

  // 5. The manual 'close' proves the slot was only ever held for the real child.
  closeChild(0);
  assert.equal(budget.getStats().active, 1, 'only the closed helper returns its lease');
  const afterClose = await controller.verify(VERIFY_IDENTITY)
    .then(() => 'ok', error => `${error.code}${error.exitUnconfirmed ? ':unconfirmed' : ''}`);
  assert.equal(state.spawns, 3, 'the freed normal slot admits exactly one new helper');
  assert.equal(afterClose, 'PS_HELPER_TIMEOUT:unconfirmed');
  assert.ok(state.peak <= 2, `peak helpers ${state.peak} must stay <= 2`);
  assert.equal(budget.getStats().active, 2, 'the new helper took the freed slot and is now tracked');
});

// ---------------------------------------------------------------------------
// 3c. Malformed / unobservable helper children: missing pipes are NOT "no process"
//
// These cases are deliberately PURE IN-MEMORY. On this path the controller reads
// exactly two filesystem facts (the process-control script exists, and the stored
// runtime record). Both are served by the exact-path stand-in below, so running
// these tests writes NOTHING to disk - not even a temporary fixture.
// ---------------------------------------------------------------------------

/** Exact-path in-memory stand-in for the two file reads this controller performs. */
function memoryFiles(t, entries) {
  const realExists = fs.existsSync;
  const realRead = fs.readFileSync;
  const known = file => Object.prototype.hasOwnProperty.call(entries, String(file));
  fs.existsSync = file => (known(file) ? true : realExists.call(fs, file));
  fs.readFileSync = (file, ...rest) => (known(file) ? entries[String(file)] : realRead.call(fs, file, ...rest));
  t.after(() => {
    fs.existsSync = realExists;
    fs.readFileSync = realRead;
  });
}

/**
 * A controller whose storage is answered from memory: zero fixture writes.
 *
 * `scriptPath` is the REAL `scripts/process-control.ps1`: executeHelper only checks
 * `existsSync(scriptPath)`, and the child is a fake `spawnHelper`, so the script is
 * never executed or modified. Only the virtual runtime record is mocked, by exact
 * path; every other fs call is delegated to the real implementation. `dataDir` is a
 * synthetic path that is never created.
 */
function memoryController(t, {
  spawnHelper,
  budget,
  service = 'overleaf-mcp',
  helperExecutionTimeoutMs = 25,
  helperKillGraceMs = 40,
  setTimeoutFn,
  clearTimeoutFn
} = {}) {
  const dataDir = path.join(projectRoot, 'artifacts', 'resource-architecture-20261113', 'tmp', 'rev6-in-memory-never-written');
  const scriptPath = path.join(projectRoot, 'scripts', 'process-control.ps1');
  assert.ok(fs.existsSync(scriptPath), 'the real process-control.ps1 exists (it is never executed here)');
  const processPath = path.join(dataDir, 'runtime', `${service}-process.json`);
  memoryFiles(t, {
    [processPath]: JSON.stringify({
      pid: 4242,
      startedAt: '2026-11-13T00:00:00.000Z',
      executablePath: 'C:\\fake\\tunnel-client.exe',
      service
    })
  });
  const controller = createDefaultProcessController({
    dataDir, scriptPath, psWorkerPool: deadPool(PS_FAULT_CODES.UNAVAILABLE), spawnHelper,
    helperBudget: budget, helperExecutionTimeoutMs, helperKillGraceMs,
    ...(setTimeoutFn ? { setTimeoutFn } : {}),
    ...(clearTimeoutFn ? { clearTimeoutFn } : {})
  });
  return { controller, dataDir, scriptPath, processPath };
}

/** Timer audit: every controller/budget timer is tracked so a leak is observable. */
function timerAudit() {
  const live = new Set();
  return {
    setTimeout(fn, ms) {
      const handle = setTimeout(() => { live.delete(handle); fn(); }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout(handle) { live.delete(handle); return clearTimeout(handle); },
    size: () => live.size
  };
}

/**
 * A LIVE helper (it carries a pid) whose stdout or stderr was never exposed and
 * that never answers. Under the old guard this hit the "no usable pipe" branch,
 * which returned the physical lease while the process was still alive.
 */
function pipeLessSpawnHelper({ omit = 'stdout', pid = NORMAL_HELPER_PID } = {}) {
  const children = [];
  const state = { spawns: 0, kills: 0, live: 0, peak: 0 };
  const spawnHelper = () => {
    state.spawns += 1;
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = omit === 'stdout' ? null : new EventEmitter();
    child.stderr = omit === 'stderr' ? null : new EventEmitter();
    let closed = false;
    const closeIt = () => {
      if (closed) return;
      closed = true;
      state.live -= 1;
      child.emit('close', 0);
    };
    child.kill = () => { state.kills += 1; return false; };
    children.push(closeIt);
    return child;
  };
  return { spawnHelper, state, closeAll() { for (const closeIt of children) closeIt(); } };
}

test('helper lane: a pid-bearing helper without stdout/stderr keeps its lease until the real close', async (t) => {
  for (const omit of ['stdout', 'stderr']) {
    const audit = timerAudit();
    const { spawnHelper, state, closeAll } = pipeLessSpawnHelper({ omit });
    const budget = createHelperBudget({
      maxTotal: 2, maxNormal: 1, waitTimeoutMs: 100,
      setTimeoutFn: audit.setTimeout, clearTimeoutFn: audit.clearTimeout
    });
    const { controller } = memoryController(t, {
      spawnHelper, budget, setTimeoutFn: audit.setTimeout, clearTimeoutFn: audit.clearTimeout
    });
    t.after(() => { closeAll(); budget.close(); });

    const startedAt = Date.now();
    const outcomeShape = error => `${error.code}:${error.helperCode}:${error.exitUnconfirmed ? 'unconfirmed' : 'confirmed'}`;
    const outcome = await controller.verify(VERIFY_IDENTITY).then(() => 'ok', outcomeShape);
    const elapsed = Date.now() - startedAt;
    assert.equal(outcome, 'PROCESS_CONTROL_UNCONFIRMED:PS_HELPER_OUTPUT_UNAVAILABLE:unconfirmed',
      `${omit}: the public call fails bounded with a control fault instead of throwing on the missing pipe`);
    assert.ok(elapsed >= 40, `${omit}: the bounded failure really waited for the grace (${elapsed}ms)`);
    assert.equal(state.kills, 1, `${omit}: the live helper was asked to terminate`);
    assert.equal(budget.getStats().active, 1,
      `${omit}: a missing pipe is NOT proof that no process exists - the lease stays held`);

    // Normal work cannot spawn a replacement underneath the live process.
    const congested = await controller.verify(VERIFY_IDENTITY).then(() => 'ok', error => error.code);
    assert.equal(congested, 'PROCESS_CONTROL_CONGESTED', `${omit}: waiting work is refused, not respawned`);
    assert.equal(state.spawns, 1, `${omit}: no second helper while the pid-bearing child is alive`);

    // Only the real close returns the lease, and admission recovers afterwards.
    closeAll();
    assert.equal(budget.getStats().active, 0, `${omit}: the observed close returns the lease`);
    const afterClose = await controller.verify(VERIFY_IDENTITY).then(() => 'ok', outcomeShape);
    assert.equal(state.spawns, 2, `${omit}: the freed slot admits exactly one new helper`);
    assert.equal(afterClose, 'PROCESS_CONTROL_UNCONFIRMED:PS_HELPER_OUTPUT_UNAVAILABLE:unconfirmed',
      `${omit}: the replacement also fails bounded`);
    closeAll();
    assert.equal(budget.getStats().active, 0, `${omit}: both leases returned after their real closes`);

    // A missing pipe that closes EARLY still reports a control fault (never a
    // fabricated success) and returns the lease.
    const early = controller.verify(VERIFY_IDENTITY)
      .then(() => 'ok', error => `${error.code}:${error.helperCode}:${error.exitUnconfirmed ? 'unconfirmed' : 'confirmed'}`);
    await sleep(5);
    assert.equal(state.spawns, 3, `${omit}: the third helper was admitted after the slot was freed`);
    closeAll();
    assert.equal(await early, 'PROCESS_CONTROL_UNCONFIRMED:PS_HELPER_OUTPUT_UNAVAILABLE:confirmed',
      `${omit}: a close without the output pipe is a control fault, not a success`);
    assert.equal(budget.getStats().active, 0, `${omit}: the early close returned the lease`);
    assert.equal(audit.size(), 0, `${omit}: no deadline/grace/queue timer was left behind`);
  }
});

/** A child object whose exit can never be observed: no `on`, or `on` throws. */
function unobservableSpawnHelper({ mode = 'no-event-interface', pid = 5151 } = {}) {
  const state = { spawns: 0, kills: 0 };
  const spawnHelper = () => {
    state.spawns += 1;
    if (mode === 'no-event-interface') {
      return {
        pid,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => { state.kills += 1; return false; }
      };
    }
    if (mode === 'throwing-on-getter') {
      // Reading `child.on` itself throws: the observation attempt must still become a
      // control fault, not a bare TypeError that inspect() would swallow.
      return {
        pid,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => { state.kills += 1; return false; },
        get on() { throw new TypeError('boom'); }
      };
    }
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { state.kills += 1; return false; };
    child.on = () => { throw new Error('cannot register listener'); };
    return child;
  };
  return { spawnHelper, state };
}

test('helper lane: an unobservable child isolates its lease instead of returning it', async (t) => {
  for (const mode of ['no-event-interface', 'listener-registration-fails', 'throwing-on-getter']) {
    const { spawnHelper, state } = unobservableSpawnHelper({ mode });
    const budget = createHelperBudget({ maxTotal: 2, maxNormal: 1, waitTimeoutMs: 80 });
    const { controller } = memoryController(t, { spawnHelper, budget });
    t.after(() => budget.close());

    const outcome = await controller.verify(VERIFY_IDENTITY)
      .then(() => 'ok', error => `${error.code}:${error.helperCode}:${error.hasPid}`);
    assert.equal(outcome, 'PROCESS_CONTROL_UNCONFIRMED:PS_HELPER_UNOBSERVABLE:true',
      `${mode}: a pid-bearing child without an observable exit fails with its own SwitchFault`);

    const congested = await controller.verify(VERIFY_IDENTITY).then(() => 'ok', error => error.code);
    assert.equal(congested, 'PROCESS_CONTROL_CONGESTED', `${mode}: later work waits and is refused`);
    assert.equal(state.spawns, 1, `${mode}: nothing new is spawned underneath the unobservable child`);
    await sleep(30);
    assert.equal(budget.getStats().active, 1,
      `${mode}: the lease stays isolated - it is never returned on a guess`);
    assert.equal(budget.getStats().waiting, 0, `${mode}: no waiter is left behind`);
  }
});

test('helper lane: a missing-pipe control fault is never published as verified absence', async (t) => {
  const { spawnHelper, closeAll } = pipeLessSpawnHelper({ omit: 'stdout' });
  const budget = createHelperBudget({ maxTotal: 2, maxNormal: 1, waitTimeoutMs: 80 });
  const { controller } = memoryController(t, {
    spawnHelper, budget, helperExecutionTimeoutMs: 20, helperKillGraceMs: 30
  });
  t.after(() => { closeAll(); budget.close(); });

  // inspect() only rethrows control-channel faults; a bare Error would be swallowed
  // into { running: false, absenceVerified: true } - a positive absence proof that a
  // stop/removal would consume while the helper is still running.
  await assert.rejects(() => controller.inspect('overleaf-mcp', { allowExternalScan: false }),
    error => error.code === 'PROCESS_CONTROL_UNCONFIRMED'
      && error.helperCode === 'PS_HELPER_OUTPUT_UNAVAILABLE');
  assert.equal(budget.getStats().active, 1, 'the still-running helper keeps its lease');
});

test('helper lane: a helper timeout is never published as verified absence', async (t) => {
  // A well-formed child (both pipes present) that simply never answers: direct
  // verify() keeps the raw PS_HELPER_TIMEOUT code, but inspect() must propagate it
  // instead of degrading to "absence verified". Deliberately a FRESH budget and a
  // direct inspect() call: no never-close verify may occupy the normal slot first,
  // otherwise the only thing observed would be CONGESTED.
  const child = new EventEmitter();
  child.pid = NORMAL_HELPER_PID;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const state = { spawns: 0, kills: 0 };
  child.kill = () => { state.kills += 1; return false; };
  const spawnHelper = () => { state.spawns += 1; return child; };
  const budget = createHelperBudget({ maxTotal: 2, maxNormal: 1, waitTimeoutMs: 80 });
  const { controller } = memoryController(t, {
    spawnHelper, budget, helperExecutionTimeoutMs: 20, helperKillGraceMs: 30
  });
  t.after(() => budget.close());

  await assert.rejects(() => controller.inspect('overleaf-mcp', { allowExternalScan: false }),
    error => error.code === 'PS_HELPER_TIMEOUT' && error.absenceVerified === undefined);
  assert.equal(state.kills, 1, 'the execution deadline fired: this really is the TIMEOUT path (kill requested)');
  assert.equal(budget.getStats().active, 1, 'the timed-out helper keeps its lease until it really closes');
  assert.equal(state.spawns, 1, 'inspect never spawns a replacement under a live helper');

  child.emit('close', 0);
  assert.equal(budget.getStats().active, 0, 'the real close returns the lease');
});

test('helper lane: a throwing on-getter is a control fault, never a verified absence', async (t) => {
  // `typeof child.on` itself can throw when `on` is a getter. That read happens
  // INSIDE the observation try, so it must become an isolated-lease control fault
  // (SwitchFault) instead of a bare TypeError that inspect() would swallow into
  // { running: false, absenceVerified: true }.
  const { spawnHelper } = unobservableSpawnHelper({ mode: 'throwing-on-getter' });
  const budget = createHelperBudget({ maxTotal: 2, maxNormal: 1, waitTimeoutMs: 60 });
  const { controller } = memoryController(t, { spawnHelper, budget });
  t.after(() => budget.close());

  await assert.rejects(() => controller.inspect('overleaf-mcp', { allowExternalScan: false }),
    error => error.code === 'PROCESS_CONTROL_UNCONFIRMED'
      && error.helperCode === 'PS_HELPER_UNOBSERVABLE'
      && error.hasPid === true
      && error.absenceVerified === undefined);
  assert.equal(budget.getStats().active, 1, 'the unobservable pid keeps its lease isolated');
});

test('helper lane: only proven non-creation returns the lease early', async (t) => {
  const budget = createHelperBudget({ maxTotal: 2, maxNormal: 1, waitTimeoutMs: 100 });
  t.after(() => budget.close());
  let mode = 'throw-sync';
  const keepAlive = [];
  t.after(() => { for (const timer of keepAlive) clearTimeout(timer); });
  const spawnHelper = () => {
    if (mode === 'throw-sync') throw new Error('spawn ENOENT');
    if (mode === 'error-without-pid') {
      // The spawn never produced a process: no pid, no 'spawn', only 'error'.
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => false;
      keepAlive.push(setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 5));
      return child;
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    keepAlive.push(setTimeout(() => {
      child.stdout.emit('data', JSON.stringify({ valid: true, success: true }));
      child.emit('close', 0);
    }, 5));
    return child;
  };
  const { controller } = memoryController(t, {
    spawnHelper, budget, helperExecutionTimeoutMs: 500, helperKillGraceMs: 200
  });

  // (a) spawn() throws synchronously: nothing was created, the lease returns at once.
  await assert.rejects(() => controller.verify(VERIFY_IDENTITY), error => /spawn ENOENT/.test(error.message));
  assert.equal(budget.getStats().active, 0, 'a synchronous spawn failure returns the lease immediately');

  // (b) an 'error' without pid and without 'spawn' proves no process exists.
  mode = 'error-without-pid';
  await assert.rejects(() => controller.verify(VERIFY_IDENTITY), error => /spawn ENOENT/.test(error.message));
  assert.equal(budget.getStats().active, 0, 'a provably-never-created spawn error returns the lease');

  // (c) the same budget still admits a real run and releases it on close.
  mode = 'answer';
  const verdict = await controller.verify(VERIFY_IDENTITY);
  assert.equal(verdict.valid, true, 'the budget was not leaked by the two failures above');
  assert.equal(budget.getStats().active, 0, 'the successful run returns its lease on close');
  assert.equal(budget.getStats().waiting, 0);
});

test('helper lane: normal AND timed-out helpers never exceed the peak (1 normal / 2 total)', async (t) => {
  const dataDir = makeTempDir(t, 'helper-peak-mixed');
  const scriptPath = path.join(dataDir, 'process-control.ps1');
  fs.writeFileSync(scriptPath, '# fake');
  seedStoredProcess(dataDir, 'overleaf-mcp');
  const { spawnHelper, state } = lateCloseSpawnHelper({ closeDelayMs: 30 });
  const budget = createHelperBudget({ maxTotal: 2, maxNormal: 1, waitTimeoutMs: 3000 });
  const controller = createDefaultProcessController({
    dataDir, scriptPath, psWorkerPool: deadPool(PS_FAULT_CODES.UNAVAILABLE), spawnHelper,
    helperBudget: budget, helperExecutionTimeoutMs: 15, helperKillGraceMs: 2000
  });

  const calls = [];
  for (let i = 0; i < 6; i += 1) {
    calls.push(controller.verify(VERIFY_IDENTITY).catch(() => null));
    await sleep(5);
  }
  await Promise.all(calls);
  assert.ok(state.peak <= 1, `peak live normal helpers ${state.peak} must stay <= 1 even with timeouts`);
  assert.equal(budget.getStats().active, 0);
  assert.ok(state.kills >= 1, 'at least one hung helper was killed');
});

// ---------------------------------------------------------------------------
// 4. Admission is checked BEFORE any old instance is stopped (production entries)
// ---------------------------------------------------------------------------

function fakeLifecycleRepo({ serviceId = 'overleaf-mcp', kind = 'restart', controlCarrier = false } = {}) {
  const action = { id: 'act-1', operationId: 'act-1', serviceId, kind, action: kind, state: 'QUEUED', profileId: 'p1' };
  const state = { transitions: [] };
  const repo = {
    state,
    async loadAction(id) {
      if (id !== action.id) throw new Error(`unknown action ${id}`);
      return { ...action };
    },
    async publicAction() {
      return { ...action };
    },
    async transitionAction(id, patch) {
      Object.assign(action, patch);
      if (patch.state) action.status = patch.state;
      state.transitions.push(patch.state);
    },
    async phase(id, next, code) {
      action.status = next;
      if (code) action.errorCode = code;
      state.transitions.push(next);
    },
    async markActionAttention(id, code) {
      action.state = 'NEEDS_ATTENTION';
      action.errorCode = code;
    },
    async getActiveActionForService() { return null; },
    async listProfiles() { return [{ id: 'p1' }]; },
    async hasServiceCredential() { return true; },
    async getProfileCredentials() { return { tunnelId: 't', apiKey: 'k' }; },
    getObserver() { return null; },
    registry: {
      async getDefinition() {
        return { id: serviceId, enabled: true, controlCarrier, revision: 1 };
      },
      async getActiveActionForService() { return null; }
    }
  };
  return { repo, action, state };
}

function fakeRestartAdapter(t, { pid = 4242 } = {}) {
  const dataDir = makeTempDir(t, 'restart-adapter');
  const processPath = path.join(dataDir, 'process.json');
  fs.writeFileSync(processPath, JSON.stringify({ pid, startedAt: '2026-11-13T00:00:00.000Z', executablePath: 'C:\\fake\\tunnel-client.exe' }));
  const counts = { stops: 0, prepares: 0, applies: 0, verifies: 0 };
  const adapter = {
    processPath,
    paths: {},
    processController: {
      async inspect() {
        return { running: true, pid, startedAt: '2026-11-13T00:00:00.000Z', executablePath: 'C:\\fake\\tunnel-client.exe' };
      },
      async verify() { return { valid: true }; },
      async stop() { counts.stops += 1; return { stopped: true }; }
    },
    async prepare() { counts.prepares += 1; return { desiredFingerprint: 'a'.repeat(64) }; },
    async applyIfUnchanged() { counts.applies += 1; },
    async verifyDesired({ operationId }) {
      counts.verifies += 1;
      return {
        verified: true, operationId, service: 'overleaf-mcp',
        configFingerprint: 'a'.repeat(64),
        identity: { pid: 999, startedAt: '2026-11-13T01:00:00.000Z', executable: 'tunnel-client.exe' },
        proof: { kind: 'authenticated-control-plane' }
      };
    },
    async stopConnection() { counts.stops += 1; return { stopped: true, proof: { kind: 'verified-owned-process-exit' } }; }
  };
  return { adapter, counts };
}

test('restart admission: a refused restart never stops the running instance', async (t) => {
  const { repo, action } = fakeLifecycleRepo({ kind: 'restart' });
  const { adapter, counts } = fakeRestartAdapter(t);
  const policy = createResourcePolicy({
    maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => 512 * 1024 ** 2
  });
  t.after(() => policy.close());

  const settled = await runMcpLifecycleAction({
    repo, adapterProvider: () => adapter, actionId: action.id, vault: null, resourcePolicy: policy
  });

  assert.equal(settled.state, 'REJECTED');
  assert.equal(settled.errorCode, 'INSUFFICIENT_MEMORY');
  assert.equal(counts.stops, 0, 'no old client may be stopped when the new start is refused');
  assert.equal(counts.prepares, 0);
  assert.equal(counts.applies, 0);
  assert.equal(policy.getStats().activeStarts, 0, 'a refused admission reserves nothing');
});

test('restart admission: an admitted restart releases its reservation in the finally', async (t) => {
  const { repo, action } = fakeLifecycleRepo({ kind: 'restart' });
  const { adapter, counts } = fakeRestartAdapter(t);
  const policy = createResourcePolicy({ maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => 16 * 1024 ** 3 });
  t.after(() => policy.close());

  const settled = await runMcpLifecycleAction({
    repo, adapterProvider: () => adapter, actionId: action.id, vault: null, resourcePolicy: policy
  });
  assert.equal(settled.state, 'SUCCEEDED');
  assert.equal(counts.stops, 1, 'the verified old process is stopped only after admission');
  assert.equal(counts.verifies, 1);
  assert.equal(policy.getStats().activeStarts, 0, 'the reservation must not leak');
});

test('restart admission: a FAILING restart still releases its reservation', async (t) => {
  const { repo, action } = fakeLifecycleRepo({ kind: 'restart' });
  const { adapter } = fakeRestartAdapter(t);
  adapter.verifyDesired = async () => { throw new Error('verification failed'); };
  const policy = createResourcePolicy({ maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => 16 * 1024 ** 3 });
  t.after(() => policy.close());

  await runMcpLifecycleAction({
    repo, adapterProvider: () => adapter, actionId: action.id, vault: null, resourcePolicy: policy
  });
  assert.equal(policy.getStats().activeStarts, 0, 'a failed action must not leak the start budget');
});

test('restart admission: a refused restart leaves the LIVE instance state untouched', async (t) => {
  const { repo, action } = fakeLifecycleRepo({ kind: 'restart' });
  const { adapter, counts } = fakeRestartAdapter(t);
  // The observer cache and the persisted runtime row are the two places the
  // console reads "this account is running" from. A refused restart must not
  // blank either -- zero stop() calls alone would not prove that.
  const observerWrites = [];
  repo.getObserver = () => ({
    invalidate(id) { observerWrites.push({ kind: 'invalidate', id }); },
    setTunnelClient(id, status) { observerWrites.push({ kind: 'set', id, state: status.state, pid: status.pid }); }
  });
  const transitions = [];
  const baseTransition = repo.transitionAction;
  repo.transitionAction = async (id, patch) => {
    transitions.push(patch.state);
    return baseTransition(id, patch);
  };
  // Any write to the runtime record file is a state mutation and is recorded.
  const recordPath = adapter.processPath;
  const recordWrites = [];
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function (file, ...rest) {
    if (String(file) === recordPath) recordWrites.push(String(file));
    return originalWriteFileSync.call(this, file, ...rest);
  };
  t.after(() => { fs.writeFileSync = originalWriteFileSync; });
  const recordBefore = fs.readFileSync(recordPath, 'utf8');

  const policy = createResourcePolicy({
    maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => 512 * 1024 ** 2
  });
  t.after(() => policy.close());

  const settled = await runMcpLifecycleAction({
    repo, adapterProvider: () => adapter, actionId: action.id, vault: null, resourcePolicy: policy
  });

  assert.equal(settled.state, 'REJECTED');
  assert.equal(counts.stops, 0, 'no old instance may be stopped');
  assert.equal(counts.prepares, 0, 'no config may be staged');
  assert.equal(counts.applies, 0);
  assert.deepEqual(observerWrites, [], 'a refused restart must not publish a stopped/running observation');
  assert.deepEqual(recordWrites, [], 'the runtime record file must not be rewritten');
  assert.equal(fs.readFileSync(recordPath, 'utf8'), recordBefore,
    'the persisted runtime row keeps its live PID and identity');
  assert.deepEqual(transitions, ['REJECTED'], 'no APPLYING transition before the refusal');
});

function fakeSwitchFixture({ policy, targets = ['overleaf-mcp', 'antigravity-mcp'] }) {
  const effects = [];
  const op = {
    status: 'QUEUED',
    targets: [...targets],
    // Registered snapshot: without it, orderedTargets only knows the legacy pair
    // and any extra service is rejected as INVALID_TARGETS.
    registrySnapshot: {
      revision: 1,
      services: targets.map(id => ({ id, enabled: true, controlCarrier: id === 'antigravity-mcp' }))
    }
  };
  const snapshot = { desiredFingerprint: 'a'.repeat(64), originalFingerprint: 'b'.repeat(64) };
  const steps = new Map();
  const repo = {
    async load() { return { ...op }; },
    async publicOperation() { return { ...op }; },
    async begin() { op.status = 'PREPARING'; },
    async pinnedCredential() { return {}; },
    async prepared(_id, service) { steps.set(service, {}); },
    async phase(_id, next) { op.status = next; },
    async markMayMutate(_id, service) { effects.push(`may-mutate:${service}`); steps.get(service).mayHaveMutated = true; },
    async unsealSnapshot() { return snapshot; },
    async applied(_id, service) { effects.push(`applied:${service}`); },
    async commitSuccess() { op.status = 'SUCCEEDED'; },
    async step(_id, service) { return steps.get(service); },
    async restored() {},
    async restoreFailed() {},
    async finishRollback(_id, status) { op.status = status; }
  };
  const adapters = Object.fromEntries(targets.map(service => [service, {
    async prepare() { effects.push(`prepare:${service}`); return snapshot; },
    async applyIfUnchanged() { effects.push(`apply:${service}`); },
    async verifyDesired({ operationId }) {
      return {
        verified: true, operationId, service, configFingerprint: snapshot.desiredFingerprint,
        identity: { pid: 42, startedAt: '2026-11-04T00:00:00Z', executable: 'fake-tunnel.exe' },
        proof: { kind: 'authenticated-control-plane' }
      };
    },
    async restoreIfOwned({ operationId }) {
      return { restored: true, runtimeRestored: true, operationId, service, configFingerprint: snapshot.originalFingerprint };
    }
  }]));
  return {
    effects,
    get status() { return op.status; },
    deps: { repo, adapters, withExclusiveLock: fn => fn(), resourcePolicy: policy }
  };
}

test('switch admission: a 3-service serial batch is NOT挤满 by its own preflight', async (t) => {
  // The failure this pins: with maxConcurrentStarts=2, one reservation per target
  // filled the whole budget before the operation ran and the third target was
  // refused (RESOURCE_ADMISSION_FAILED) -- a legitimate switch of three normal
  // services that must simply run serially.
  const three = ['overleaf-mcp', 'mcp_speed_a', 'mcp_speed_b'];
  const policy = createResourcePolicy({
    maxConcurrentStarts: 2, waitTimeoutMs: 0, availableMemoryBytes: () => 16 * 1024 ** 3
  });
  t.after(() => policy.close());
  const fixture = fakeSwitchFixture({ policy, targets: three });

  const operation = await executeOperation('op-batch-3', fixture.deps);
  assert.equal(operation.status, 'SUCCEEDED', 'three normal services must switch normally');
  const prepared = fixture.effects.filter(e => e.startsWith('prepare:')).sort();
  const applied = fixture.effects.filter(e => e.startsWith('apply:')).sort();
  assert.deepEqual(prepared, three.map(s => `prepare:${s}`).sort(), 'every target is prepared');
  assert.deepEqual(applied, three.map(s => `apply:${s}`).sort(), 'every target is applied');
  // The batch consumed exactly ONE slot and gave it back.
  assert.equal(policy.getStats().activeStarts, 0);
});

test('switch admission: batch priority stays critical but memory follows the weakest role', async (t) => {
  const targets = ['overleaf-mcp', 'mcp_speed_c', 'antigravity-mcp'];
  // Under the old rule one carrier made the whole batch "critical", so 3 GiB free
  // (which cannot hold two 2 GiB normal starts + the critical reserve) admitted it.
  // The batch is still scheduled as critical, but its MEMORY headroom follows the
  // ordinary services it contains: 2 GiB + 2 GiB + 512 MiB reserved, plus the
  // untouched 512 MiB critical reserve = 5 GiB required.
  const tight = createResourcePolicy({
    maxConcurrentStarts: 2, waitTimeoutMs: 0, availableMemoryBytes: () => 3 * 1024 ** 3
  });
  t.after(() => tight.close());
  const tightFixture = fakeSwitchFixture({ policy: tight, targets });
  const refused = await executeOperation('op-batch-mixed-tight', tightFixture.deps);
  assert.equal(refused.status, 'ROLLED_BACK', '3 GiB is not enough for a carrier + ordinary services batch');
  assert.deepEqual(tightFixture.effects, [], 'the refusal happens before any prepare/apply');

  // With memory actually available the same serial batch runs normally.
  const ample = createResourcePolicy({
    maxConcurrentStarts: 1, waitTimeoutMs: 0, availableMemoryBytes: () => 16 * 1024 ** 3
  });
  t.after(() => ample.close());
  const fixture = fakeSwitchFixture({ policy: ample, targets });
  const operation = await executeOperation('op-batch-critical', fixture.deps);
  assert.equal(operation.status, 'SUCCEEDED', 'one critical target still makes the serial batch critical');
  assert.equal(ample.getStats().activeStarts, 0);
});

test('switch admission: a carrier + ordinary service batch cannot borrow the critical reserve', async (t) => {
  const targets = ['overleaf-mcp', 'antigravity-mcp'];
  const policy = createResourcePolicy({
    maxConcurrentStarts: 2, waitTimeoutMs: 0, availableMemoryBytes: () => 1 * 1024 ** 3
  });
  t.after(() => policy.close());
  const fixture = fakeSwitchFixture({ policy, targets });

  const operation = await executeOperation('op-batch-mixed-1gib', fixture.deps);
  assert.equal(operation.status, 'ROLLED_BACK');
  assert.deepEqual(fixture.effects, [],
    'effects=[]: the ordinary service in the batch cannot pass on the 512 MiB critical estimate');
  assert.equal(policy.getStats().activeStarts, 0);
});

test('switch admission: an all-critical batch may still use the critical reserve', async (t) => {
  const targets = ['antigravity-mcp', 'mcp_dsh_chatgpt_bridge'];
  const policy = createResourcePolicy({
    maxConcurrentStarts: 1, waitTimeoutMs: 0, availableMemoryBytes: () => 1 * 1024 ** 3
  });
  t.after(() => policy.close());
  const fixture = fakeSwitchFixture({ policy, targets });

  const operation = await executeOperation('op-batch-all-critical', fixture.deps);
  assert.equal(operation.status, 'SUCCEEDED', 'two critical starts fit the 1 GiB critical reserve');
  assert.deepEqual(fixture.effects.filter(e => e.startsWith('apply:')).length, 2);
  assert.equal(policy.getStats().activeStarts, 0);
});

test('switch admission: a refused batch performs zero mutations', async (t) => {
  const targets = ['overleaf-mcp', 'mcp_speed_d', 'mcp_speed_e'];
  const policy = createResourcePolicy({ maxConcurrentStarts: 2, waitTimeoutMs: 0, availableMemoryBytes: () => 256 * 1024 ** 2 });
  t.after(() => policy.close());
  const fixture = fakeSwitchFixture({ policy, targets });
  const operation = await executeOperation('op-batch-refused', fixture.deps);
  assert.equal(operation.status, 'ROLLED_BACK');
  assert.deepEqual(fixture.effects, [], 'a refused batch must not prepare/apply/stop anything');
  assert.equal(policy.getStats().activeStarts, 0);
});

test('switch admission: a refused preflight performs zero mutations', async (t) => {
  const policy = createResourcePolicy({ maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => 256 * 1024 ** 2 });
  t.after(() => policy.close());
  const fixture = fakeSwitchFixture({ policy });

  const operation = await executeOperation('op-1', fixture.deps);
  assert.equal(operation.status, 'ROLLED_BACK');
  assert.deepEqual(fixture.effects, [], 'prepare/apply must not run when the resource preflight refuses');
  assert.equal(policy.getStats().activeStarts, 0);
});

test('switch admission: a successful preflight releases every reservation', async (t) => {
  const policy = createResourcePolicy({ maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => 16 * 1024 ** 3 });
  t.after(() => policy.close());
  const fixture = fakeSwitchFixture({ policy });

  const operation = await executeOperation('op-2', fixture.deps);
  assert.equal(operation.status, 'SUCCEEDED');
  // Canonical order: every prepare, then the write-ahead intent, then apply.
  const prepares = fixture.effects.filter(e => e.startsWith('prepare:'));
  const applies = fixture.effects.filter(e => e.startsWith('apply:'));
  assert.deepEqual(prepares, ['prepare:overleaf-mcp', 'prepare:antigravity-mcp']);
  assert.deepEqual(applies, ['apply:overleaf-mcp', 'apply:antigravity-mcp']);
  assert.ok(fixture.effects.indexOf('prepare:antigravity-mcp') < fixture.effects.indexOf('apply:overleaf-mcp'),
    'every prepare finishes before the first apply');
  assert.equal(policy.getStats().activeStarts, 0);
});

test('runner: ONE policy is shared by the legacy, registry and instance entry points', async (t) => {
  const dataDir = makeTempDir(t, 'runner-policy');
  const policy = createResourcePolicy({ maxConcurrentStarts: 4, waitTimeoutMs: 0, availableMemoryBytes: () => 16 * 1024 ** 3 });
  t.after(() => policy.close());
  const repo = {
    async isActionId() { return false; },
    async isOperationId() { return false; },
    async pendingOperationIds() { return []; },
    async getWorkQueue() { return []; }
  };
  const runner = createRunner({
    repo, adapters: {}, adapterProvider: async () => null, dataDir, resourcePolicy: policy
  });
  assert.equal(runner.deps.resourcePolicy, policy, 'the runner must not build a second, private budget');
  assert.equal(runner.getStatus().resourcePolicy.activeStarts, 0);
});

// ---------------------------------------------------------------------------
// 5. Observer: global gate, single-flight, bounded cache, failure backoff
// ---------------------------------------------------------------------------

test('observer: at most 2 probes are in flight globally across observers', async (t) => {
  const limiter = createObservationLimiter({ maxConcurrent: 2, maxWaiting: 16 });
  t.after(() => limiter.cancel?.());
  const probe = async () => {
    await sleep(15);
    return { state: 'available', reasonCode: 'mcp_initialize_verified', source: 'http_mcp',
      observedAt: Date.now(), evidence: { mcpVerified: true } };
  };
  let active = 0, peak = 0;
  const observer = createRuntimeObserver({
    limiter, probeHttpMcp: async () => { active += 1; peak = Math.max(peak, active); try { return await probe(); } finally { active -= 1; } }
  });
  const other = createRuntimeObserver({
    limiter, probeHttpMcp: async () => { active += 1; peak = Math.max(peak, active); try { return await probe(); } finally { active -= 1; } }
  });
  const cycles = [];
  for (let i = 0; i < 5; i += 1) {
    cycles.push(observer.observe({ id: `svc-${i}`, revision: 1, enabled: true, transport: 'http', url: `http://127.0.0.1:1/${i}` }));
    cycles.push(other.observe({ id: `svc-${i}`, revision: 1, enabled: true, transport: 'http', url: `http://127.0.0.1:1/${i}` }));
  }
  await Promise.all(cycles);
  assert.ok(peak <= 2, `peak concurrent probes ${peak} must stay <= 2`);
});

test('observer: concurrent calls for the same service share ONE cycle (single-flight)', async (t) => {
  let probes = 0;
  const observer = createRuntimeObserver({
    probeHttpMcp: async () => {
      probes += 1;
      await sleep(20);
      return { state: 'available', reasonCode: 'mcp_initialize_verified', source: 'http_mcp',
        observedAt: Date.now(), evidence: { mcpVerified: true } };
    }
  });
  t.after(() => observer.close());
  const target = { id: 'svc-sf', revision: 1, enabled: true, transport: 'http', url: 'http://127.0.0.1:1/x' };
  const results = await Promise.all(Array.from({ length: 5 }, () => observer.observe({ ...target })));
  assert.equal(probes, 1, 'five concurrent observes must not become five probes');
  for (const result of results) assert.equal(result.state, 'available');
});

test('observer: failures back off 30 -> 60 -> 120 -> 240 -> 300 seconds', async (t) => {
  let clock = 1_000_000;
  let probes = 0;
  const observer = createRuntimeObserver({
    now: () => clock,
    minIntervalMs: 30000,
    ttlMs: 90000,
    probeHttpMcp: async () => {
      probes += 1;
      return { state: 'unreachable', reasonCode: 'connection_refused', source: 'http_mcp',
        observedAt: clock, evidence: { mcpVerified: false } };
    }
  });
  t.after(() => observer.close());
  const target = { id: 'svc-backoff', revision: 1, enabled: true, transport: 'http', url: 'http://127.0.0.1:1/x' };

  const expectedDelays = [30000, 60000, 120000, 240000, 300000];
  await observer.observe({ ...target });            // 1st failure
  for (const delay of expectedDelays) {
    const probesBefore = probes;
    clock += delay - 1;
    await observer.observe({ ...target });
    assert.equal(probes, probesBefore, `no probe ${delay - 1}ms after a failure`);
    clock += 1;
    await observer.observe({ ...target });
    assert.equal(probes, probesBefore + 1, `a probe is allowed after ${delay}ms`);
  }
});

test('observer: the tunnel-client cache is bounded and never drops a FRESH row', async (t) => {
  const observer = createRuntimeObserver({ maxEntries: 8, probeHttpMcp: async () => {
    throw new Error('must not probe');
  } });
  t.after(() => observer.close());
  const now = Date.now();

  // Expired rows are evicted down to the bound.
  for (let i = 0; i < 40; i += 1) {
    observer.setTunnelClient(`old-${i}`, {
      state: 'stopped', managed: true, pid: null,
      observedAt: new Date(now - 200000).toISOString(),
      expiresAt: new Date(now - 100000).toISOString(),
      reasonCode: 'process_stopped'
    });
  }
  assert.ok(observer.getStats().tunnelClientRows <= 8,
    `expired rows are evicted down to the bound: ${observer.getStats().tunnelClientRows} <= 8`);
  assert.equal(observer.getStats().maxEntries, 8);

  // A FRESH running row is never evicted: dropping it would turn a known running
  // client into an unknown one, which is not a memory win.
  for (let i = 0; i < 20; i += 1) {
    observer.setTunnelClient(`fresh-${i}`, {
      state: 'running', managed: true, pid: 1000 + i,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 90000).toISOString(),
      reasonCode: 'process_verified_running'
    });
  }
  assert.equal(observer.peekTunnelClient('fresh-19').state, 'running');
  assert.equal(observer.peekTunnelClient('fresh-0').state, 'running',
    'a fresh observation survives even when the cache is over its bound');
});

test('observer: close() cancels pending cycles instead of leaking them', async (t) => {
  const observer = createRuntimeObserver({
    probeHttpMcp: async ({ signal }) => new Promise(resolve => {
      const timer = setTimeout(() => resolve({ state: 'unreachable', observedAt: Date.now() }), 500);
      signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve({ state: 'unobserved', reasonCode: 'probe_failed', observedAt: Date.now() }); });
    })
  });
  const target = { id: 'svc-close', revision: 1, enabled: true, transport: 'http', url: 'http://127.0.0.1:1/x' };
  const cycle = observer.observe({ ...target });
  observer.close();
  const result = await cycle;
  assert.equal(result.state, 'unobserved');
  assert.equal(observer.getStats().closed, true);
});

// ---------------------------------------------------------------------------
// 6. HTTP cold start: listen first, writes gated, readiness exposed, fail-closed
// ---------------------------------------------------------------------------

function startServer(t, options) {
  const server = createHttpServer({
    security: {
      guard: async () => true,
      state: async () => ({ authenticated: true }),
      setup: async () => ({}), login: async () => ({}), logout: async () => ({}), close: async () => {}
    },
    ...options
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      t.after(() => new Promise(done => {
        try { server.closeAllConnections?.(); } catch (_) {}
        server.close(() => done());
      }));
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function fakeGateRunner(gate) {
  return {
    getRecoveryState: () => gate.state,
    notify() {},
    async stop() {}
  };
}

test('cold start: the console listens while recovery runs, and every write is answered 503', async (t) => {
  const gate = { state: { status: 'pending', pending: true, failed: false, gated: true, ready: false, total: 1, done: 0 } };
  const writes = [];
  const repo = {
    async getRevision() { return 1; },
    async listProfiles() { return []; },
    async listServices() { return []; },
    getRecoveryState: () => ({ gated: false }),
    getCodexBridgeEnabled: () => true,
    setCodexBridgeEnabled(value) { writes.push(value); return value; }
  };
  const { baseUrl } = await startServer(t, { repo, runner: fakeGateRunner(gate), adapters: {} });

  // Readiness is readable immediately -- this is why recovery is deferred.
  const stateResponse = await fetch(`${baseUrl}/api/state`);
  assert.equal(stateResponse.status, 200, 'state reads must work during recovery');
  const stateBody = await stateResponse.json();
  assert.equal(stateBody.runnerRecovery.gated, true);
  assert.equal(stateBody.runnerRecovery.ready, false, 'readiness is reported separately from the gate');

  // Every mutating route is gated.
  const blocked = await fetch(`${baseUrl}/api/settings/codex-bridge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false })
  });
  assert.equal(blocked.status, 503);
  const blockedBody = await blocked.json();
  assert.equal((blockedBody.error || blockedBody).code, 'RECOVERY_IN_PROGRESS');
  assert.deepEqual(writes, [], 'no mutation may happen behind the gate');

  // Recovery settles -> the same write now succeeds without a restart.
  gate.state = { status: 'ready', pending: false, failed: false, gated: false, ready: true, total: 1, done: 1 };
  const allowed = await fetch(`${baseUrl}/api/settings/codex-bridge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false })
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(writes, [false]);
});

test('cold start: a FAILED recovery fails closed and never re-opens writes', async (t) => {
  const gate = { state: { status: 'failed', pending: false, failed: true, gated: true, ready: false, total: 1, done: 0 } };
  const repo = {
    async getRevision() { return 1; },
    async listProfiles() { return []; },
    async listServices() { return []; },
    getRecoveryState: () => ({ gated: false }),
    getCodexBridgeEnabled: () => true,
    setCodexBridgeEnabled: () => { throw new Error('must not be called'); }
  };
  const { baseUrl } = await startServer(t, { repo, runner: fakeGateRunner(gate), adapters: {} });

  const stateResponse = await fetch(`${baseUrl}/api/state`);
  assert.equal(stateResponse.status, 200, 'reads stay available so the console can explain the failure');
  const body = await stateResponse.json();
  assert.equal(body.runnerRecovery.failed, true);
  assert.equal(body.runnerRecovery.ready, false);

  for (let i = 0; i < 2; i += 1) {
    const blocked = await fetch(`${baseUrl}/api/settings/codex-bridge`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true })
    });
    assert.equal(blocked.status, 503);
    const body = await blocked.json();
    assert.equal((body.error || body).code, 'RECOVERY_FAILED');
  }
});

// ---------------------------------------------------------------------------
// 7. Frontend: no overlapping dashboard refresh, one trailing update per mutation
// ---------------------------------------------------------------------------

function installFakeFetch(t, { delayMs = 25 } = {}) {
  const originalFetch = globalThis.fetch;
  const inFlight = { current: 0, peak: 0 };
  const served = [];
  globalThis.fetch = async (url) => {
    inFlight.current += 1;
    inFlight.peak = Math.max(inFlight.peak, inFlight.current);
    try {
      await sleep(delayMs);
      const pathname = String(url);
      served.push(pathname);
      if (pathname.includes('/api/state')) {
        return {
          ok: true, status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ revision: served.length, profiles: [], services: [], mcps: [], recovery: null })
        };
      }
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => (pathname.includes('/api/mcps') ? { mcps: [], revision: served.length } : [])
      };
    } finally {
      inFlight.current -= 1;
    }
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { inFlight, served };
}

test('frontend: a slow poll never stacks a second dashboard refresh, and a mutation adds one trailing reload', async (t) => {
  const { inFlight, served } = installFakeFetch(t, { delayMs: 30 });

  // Two overlapping callers (a poll tick and a mutation completion) share one load.
  const first = loadDashboardData();
  const second = loadDashboardData();
  await Promise.all([first, second]);

  const stateCalls = served.filter(p => p.includes('/api/state')).length;
  assert.equal(stateCalls, 2, 'the second caller joins the in-flight load and marks exactly one trailing reload');
  assert.equal(inFlight.peak, 3, 'one refresh is three parallel reads (/api/state, /api/profiles, /api/mcps)');

  // A request that arrives mid-flight is not dropped: it produces exactly one more cycle.
  const before = served.length;
  const running = loadDashboardData();
  const queued = loadDashboardData();
  await Promise.all([running, queued]);
  assert.equal(served.length - before, 6, 'the mid-flight caller triggers exactly one extra cycle');
});

// ---------------------------------------------------------------------------
// 8. Registry provider: bounded cache, release by ACTION id
// ---------------------------------------------------------------------------

test('registry provider: adapters are cached by action id and released by it in a finally', async (t) => {
  const dataDir = makeTempDir(t, 'provider-cache');
  const provider = createRegisteredAdapterProvider({
    dataDir,
    processController: {
      async inspect() { return { running: false }; },
      async verify() { return { valid: false }; }
    }
  });
  const op = id => ({ id, operationId: id, registrySnapshot: { revision: 1, services: [
    { id: 'overleaf-mcp', enabled: true, binding: { type: 'stdio', executable: 'node', args: [] } }
  ] } });

  const first = await provider(op('act-1'), 'overleaf-mcp');
  const again = await provider(op('act-1'), 'overleaf-mcp');
  assert.equal(first, again, 'the same action id reuses one adapter bundle');
  assert.equal(provider.has('act-1'), true);

  provider.release('act-1');
  assert.equal(provider.has('act-1'), false, 'release takes the ACTION id');
  assert.equal(provider.size, 0);

  // The runner releases with the action id in a finally, so a long sequence of
  // actions must not accumulate entries (that is what keeps the map bounded).
  const runner = createRunner({
    repo: {
      async isActionId() { return false; },
      async isOperationId() { return false; },
      async pendingOperationIds() { return []; },
      async getWorkQueue() { return []; }
    },
    adapters: {},
    adapterProvider: provider,
    dataDir,
    resourcePolicy: createResourcePolicy({ availableMemoryBytes: () => 16 * 1024 ** 3 })
  });
  assert.equal(runner.deps.adapterProvider, provider);
  for (let i = 0; i < 12; i += 1) await provider(op(`act-${i}`), 'overleaf-mcp');
  assert.equal(provider.size, 12, 'entries accumulate only until the runner releases them');
  for (let i = 0; i < 12; i += 1) provider.release(`act-${i}`);
  assert.equal(provider.size, 0, 'release(ACTION id) drops every entry');
});

// ---------------------------------------------------------------------------
// 9. Fake N-matrix benchmark (never claims to be real client memory)
// ---------------------------------------------------------------------------

test('benchmark: fake N matrix for the start budget and the PS queue', async (t) => {
  const rows = [];
  for (const n of [1, 4, 8, 32]) {
    const policy = createResourcePolicy({
      maxConcurrentStarts: 4, maxWaitingStarts: 64, waitTimeoutMs: 5000,
      availableMemoryBytes: () => 16 * 1024 ** 3
    });
    const startedAt = process.hrtime.bigint();
    let peak = 0;
    const tasks = Array.from({ length: n }, (_, i) => (async () => {
      const reservation = await policy.admitStart({ serviceId: `fake-${n}-${i}`, kind: 'start' });
      peak = Math.max(peak, policy.getStats().activeStarts);
      await sleep(2);                                   // stand-in for a start effect
      policy.release(reservation);
    })());
    await Promise.all(tasks);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    rows.push({
      n,
      fakeTasks: n,
      peakConcurrentStarts: peak,
      limit: 4,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      waitingAfter: policy.getStats().waitingStarts,
      rssMiB: Math.round(process.memoryUsage().rss / 1048576 * 10) / 10
    });
    policy.close();
  }

  // The PS queue depth is bounded independently of N.
  const child = fakeWorker();
  const pool = createPsWorkerPool({
    spawnWorker: () => child, maxNormalQueue: 8, maxCriticalQueue: 4,
    queueWaitTimeoutMs: 60, executionTimeoutMs: 2000
  });
  t.after(() => pool.close());
  const attempts = [];
  const head = pool.send('x.ps1', { n: 'head' });
  for (let i = 0; i < 29; i += 1) attempts.push(pool.send('x.ps1', { n: i }).catch(error => error.code));
  // Answer the in-flight request so the queue can drain; then every accepted
  // queued request is answered too (the pool holds only one on the pipe).
  const drain = (async () => {
    for (let i = 0; i < 40; i += 1) {
      const ids = writtenIds(child);
      const pendingId = ids[ids.length - 1];
      if (!pendingId) { await sleep(2); continue; }
      respond(child, pendingId, { ok: i });
      await sleep(2);
      if (pool.getStats().queuedNormal === 0 && pool.getStats().completed >= 8) break;
    }
  })();
  const outcomes = await Promise.all(attempts);
  await head.catch(() => null);
  await drain;
  const refusedQueueFull = outcomes.filter(code => code === PS_FAULT_CODES.QUEUE_FULL).length;
  const accepted = outcomes.length - refusedQueueFull;
  const queueRow = { attempts: 29, accepted, refusedQueueFull, maxNormalQueue: 8, headDispatched: writtenIds(child).length };

  fs.writeFileSync(path.join(ARTIFACT_ROOT, 'benchmark-n-matrix.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), kind: 'fake', rows, queueRow, note: 'Synthetic tasks only; rssMiB is this test process, not a client measurement.' }, null, 2));

  assert.equal(rows.length, 4);
  for (const row of rows) assert.ok(row.peakConcurrentStarts <= 4);
  assert.ok(refusedQueueFull > 0, 'the PS queue refuses work beyond its bound');
  assert.ok(accepted <= 8, `at most 8 normal requests may be queued (accepted ${accepted})`);
  assert.equal(queueRow.maxNormalQueue, 8);
});
