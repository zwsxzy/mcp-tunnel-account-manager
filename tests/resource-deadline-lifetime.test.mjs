import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const policyUrl = new URL('../src/core/resource-policy.mjs', import.meta.url).href;
const poolUrl = new URL('../src/adapters/ps-worker-pool.mjs', import.meta.url).href;
const adaptersUrl = new URL('../src/adapters/index.mjs', import.meta.url).href;
const observerUrl = new URL('../src/adapters/runtime-observer.mjs', import.meta.url).href;
const helperScriptPath = fileURLToPath(new URL('../scripts/process-control.ps1', import.meta.url));
const dataDir = fileURLToPath(new URL('../artifacts/mac-port-20261113/resource-deadlines', import.meta.url));

// Each scenario has its own real Node event loop, without a test-runner socket,
// keepalive interval, or real PowerShell worker masking an unreferenced timer.
// The outer limit bounds a regression that leaves a settled timer referenced;
// it does not extend any production deadline or suite budget.
function runBareNode(body) {
  const source = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { createResourcePolicy } from ${JSON.stringify(policyUrl)};
    import { createPsWorkerPool, createHelperBudget, PsWorkerFault, PS_FAULT_CODES } from ${JSON.stringify(poolUrl)};
    import { createDefaultProcessController } from ${JSON.stringify(adaptersUrl)};
    import { createRuntimeObserver, createObservationLimiter } from ${JSON.stringify(observerUrl)};
    function worker() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.writes = [];
      child.stdin = { write: line => { child.writes.push(JSON.parse(line)); return true; } };
      return child;
    }
    function respond(child, id) {
      child.stdout.emit('data', '__MCP_PS_RESP__' + JSON.stringify({ id, code: 0, stdout: '{"ok":true}' }) + '\\n');
    }
    const identity = { pid: 4242, service: 'overleaf-mcp',
      executablePath: 'C:/fake/tunnel-client.exe', startedAt: '2026-11-13T00:00:00.000Z' };
    function helper(options = {}) {
      const child = new EventEmitter();
      child.pid = identity.pid;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kills = 0;
      child.kill = () => { child.kills += 1; return false; };
      let notifySpawned;
      const spawned = new Promise(resolve => { notifySpawned = resolve; });
      const budget = createHelperBudget({ maxTotal: 1, maxNormal: 1 });
      const controller = createDefaultProcessController({
        platform: 'win32', dataDir: ${JSON.stringify(dataDir)}, scriptPath: ${JSON.stringify(helperScriptPath)},
        psWorkerPool: { send: () => Promise.reject(new PsWorkerFault(PS_FAULT_CODES.UNAVAILABLE,
          'synthetic unavailable worker', { dispatched: false })) },
        spawnHelper: () => { notifySpawned(); return child; }, helperBudget: budget,
        helperExecutionTimeoutMs: 40, helperKillGraceMs: 40, ...options
      });
      return { child, controller, budget, spawned };
    }
    ${body}
    console.log('PUBLIC_DEADLINE_SETTLED');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'PUBLIC_DEADLINE_SETTLED');
}

test('admission timeout settles with no unrelated event-loop handle', () => {
  runBareNode(`
    const policy = createResourcePolicy({ maxConcurrentStarts: 1, maxWaitingStarts: 1,
      waitTimeoutMs: 40, availableMemoryBytes: () => 16 * 1024 ** 3 });
    const held = await policy.admitStart({ serviceId: 'held' });
    await assert.rejects(policy.admitStart({ serviceId: 'queued' }), { code: 'START_QUEUE_TIMEOUT' });
    assert.equal(policy.getStats().waitingStarts, 0);
    policy.release(held); policy.close();
  `);
});

test('PS execution timeout settles while retaining the occupied pipe', () => {
  runBareNode(`
    const child = worker();
    const pool = createPsWorkerPool({ spawnWorker: () => child, executionTimeoutMs: 40 });
    await assert.rejects(pool.send('synthetic.ps1', { Action: 'Inspect' }), error =>
      error.code === PS_FAULT_CODES.EXECUTION_TIMEOUT && error.dispatched === true);
    assert.equal(pool.getStats().inflight.timedOut, true);
    assert.equal(child.writes.length, 1);
    pool.close();
  `);
});

test('PS queue timeout settles after the occupied request has already timed out', () => {
  runBareNode(`
    const child = worker();
    const pool = createPsWorkerPool({ spawnWorker: () => child, executionTimeoutMs: 40,
      queueWaitTimeoutMs: 40 });
    await assert.rejects(pool.send('synthetic.ps1', { Action: 'Inspect' }), { code: PS_FAULT_CODES.EXECUTION_TIMEOUT });
    await assert.rejects(pool.send('synthetic.ps1', { Action: 'Verify' }), error =>
      error.code === PS_FAULT_CODES.QUEUE_TIMEOUT && error.dispatched === false);
    assert.equal(pool.getStats().inflight.timedOut, true);
    assert.equal(pool.getStats().queuedNormal, 0);
    assert.equal(child.writes.length, 1);
    pool.close();
  `);
});

test('standalone helper admission settles its queue timeout without a real helper handle', () => {
  runBareNode(`
    const budget = createHelperBudget({ maxTotal: 1, maxNormal: 1, waitTimeoutMs: 40 });
    const release = await budget.acquire();
    await assert.rejects(budget.acquire(), error => error.code === PS_FAULT_CODES.QUEUE_TIMEOUT && error.dispatched === false);
    assert.equal(budget.getStats().active, 1);
    assert.equal(budget.getStats().waiting, 0);
    release(); budget.close();
  `);
});

test('standalone helper execution and grace deadlines settle while its physical lease stays held', () => {
  runBareNode(`
    const { child, controller, budget } = helper();
    await assert.rejects(controller.verify(identity), error =>
      error.code === 'PS_HELPER_TIMEOUT' && error.exitUnconfirmed === true);
    assert.equal(child.kills, 1);
    assert.equal(budget.getStats().active, 1);
    child.emit('close', 0);
    assert.equal(budget.getStats().active, 0);
    budget.close();
  `);
});

test('observation deadline settles and aborts a probe without an unrelated event-loop handle', () => {
  runBareNode(`
    let signal;
    const limiter = createObservationLimiter({ maxConcurrent: 1 });
    const observer = createRuntimeObserver({ limiter, timeoutMs: 40,
      inspectProcess: input => { signal = input.signal; return new Promise(() => {}); } });
    const result = await observer.observe({ id: 'synthetic', enabled: true, transport: 'stdio' });
    assert.equal(result.state, 'check_failed');
    assert.equal(result.reasonCode, 'timeout');
    assert.equal(signal.aborted, true);
    assert.equal(limiter.getStats().active, 0);
    observer.close();
  `);
});

test('helper completion and observation completion or close clear their referenced deadlines', () => {
  runBareNode(`
    const early = helper({ helperExecutionTimeoutMs: 60000, helperKillGraceMs: 60000 });
    const verified = early.controller.verify(identity);
    await early.spawned;
    early.child.stdout.emit('data', '{"valid":true}');
    early.child.emit('close', 0);
    assert.equal((await verified).valid, true);
    assert.equal(early.budget.getStats().active, 0);
    early.budget.close();

    const killed = helper({ helperKillGraceMs: 60000 });
    killed.child.kill = () => { queueMicrotask(() => killed.child.emit('close', 0)); return true; };
    await assert.rejects(killed.controller.verify(identity), { code: 'PS_HELPER_TIMEOUT' });
    assert.equal(killed.budget.getStats().active, 0);
    killed.budget.close();

    const ready = createRuntimeObserver({ timeoutMs: 60000,
      probeHttpMcp: () => ({ state: 'available', reasonCode: 'mcp_initialize_verified',
        source: 'http_mcp', observedAt: Date.now(), evidence: { mcpVerified: true } }) });
    assert.equal((await ready.observe({ id: 'ready', enabled: true, transport: 'http' })).state, 'available');
    ready.close();

    let notifyProbe;
    const entered = new Promise(resolve => { notifyProbe = resolve; });
    const pending = createRuntimeObserver({ timeoutMs: 60000,
      inspectProcess: () => { notifyProbe(); return new Promise(() => {}); } });
    const observed = pending.observe({ id: 'cancelled', enabled: true, transport: 'stdio' });
    await entered; pending.close();
    assert.equal((await observed).reasonCode, 'observer_unavailable');
    assert.equal(pending.getStats().limiter.active, 0);
  `);
});

test('admission, helper grant, response, and close clear their referenced deadlines', () => {
  runBareNode(`
    // A leaked timer here would keep this process alive for 60 seconds. Each
    // public operation below is completed immediately through its real API.
    const policy = createResourcePolicy({ maxConcurrentStarts: 1, maxWaitingStarts: 2,
      waitTimeoutMs: 60000, availableMemoryBytes: () => 16 * 1024 ** 3 });
    const held = await policy.admitStart({ serviceId: 'held' });
    const queued = policy.admitStart({ serviceId: 'next' });
    policy.release(held);
    const next = await queued;
    const cancelled = assert.rejects(policy.admitStart({ serviceId: 'closed' }), { code: 'POLICY_CLOSED' });
    policy.close(); await cancelled; policy.release(next);

    const budget = createHelperBudget({ maxTotal: 1, maxNormal: 1, waitTimeoutMs: 60000 });
    const release = await budget.acquire();
    const acquire = budget.acquire();
    release(); const releaseNext = await acquire;
    const cancelledAcquire = assert.rejects(budget.acquire(), { code: PS_FAULT_CODES.CLOSED });
    budget.close(); await cancelledAcquire; releaseNext();

    const child = worker();
    const pool = createPsWorkerPool({ spawnWorker: () => child, executionTimeoutMs: 60000,
      queueWaitTimeoutMs: 60000 });
    const a = pool.send('synthetic.ps1', { n: 1 });
    const b = pool.send('synthetic.ps1', { n: 2 });
    respond(child, child.writes[0].id); await a;
    respond(child, child.writes[1].id); await b;
    const c = assert.rejects(pool.send('synthetic.ps1', { n: 3 }), { code: PS_FAULT_CODES.CLOSED });
    const d = assert.rejects(pool.send('synthetic.ps1', { n: 4 }), { code: PS_FAULT_CODES.CLOSED });
    pool.close(); await Promise.all([c, d]);
  `);
});
