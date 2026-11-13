import test from 'node:test';
import assert from 'node:assert/strict';
import { stopManagedTunnels } from '../src/core/stop-managed-tunnels.mjs';
import { createHttpServer } from '../src/server.mjs';

function owned(pid, instanceId) {
  let running = true;
  let stops = 0;
  return {
    instanceId,
    processController: { inspect: async () => running
      ? { running: true, pid, owned: true }
      : { running: false, absenceVerified: true } },
    stopConnection: async () => {
      running = false; stops += 1;
      return { stopped: true, proof: { kind: 'verified-owned-process-exit' } };
    },
    get stops() { return stops; },
    restart() { running = true; }
  };
}

test('managed stop targets exact service and profile; unrelated processes are never enumerated', async () => {
  const service = owned(901);
  const instance = owned(902, 'overleaf-mcp__account-a');
  const calls = [];
  const result = await stopManagedTunnels({ services: ['overleaf-mcp'],
    adapters: { 'overleaf-mcp': service },
    instances: [{ serviceId: 'overleaf-mcp', profileId: 'account-a', instanceId: instance.instanceId }],
    instanceAdapterProvider: async (_op, sid, pid) => { calls.push([sid, pid]); return instance; }
  });
  assert.deepEqual(calls, [['overleaf-mcp', 'account-a']]);
  assert.deepEqual(result.killedPids, [901, 902]);
  assert.deepEqual(result.remainingPids, []);
  assert.equal(result.absenceUnconfirmed, null);
  assert.equal(service.stops, 1);
  assert.equal(instance.stops, 1);
});

test('uncertain inspection does not authorize stop and does not prevent stopping another owned target', async () => {
  const safe = owned(903);
  let forbiddenStops = 0;
  const result = await stopManagedTunnels({ services: ['unknown', 'safe'], adapters: {
    unknown: { processController: { inspect: async () => ({ running: false }) },
      stopConnection: async () => { forbiddenStops += 1; } }, safe
  } });
  assert.equal(forbiddenStops, 0);
  assert.equal(safe.stops, 1);
  assert.equal(result.errors[0].message, 'PROCESS_ABSENCE_UNCONFIRMED');
  assert.ok(result.absenceUnconfirmed);
});

test('an instance provider returning a sibling is rejected before inspection or stopping', async () => {
  const sibling = owned(904, 'overleaf-mcp__account-b');
  const result = await stopManagedTunnels({
    instances: [{ serviceId: 'overleaf-mcp', profileId: 'account-a', instanceId: 'overleaf-mcp__account-a' }],
    instanceAdapterProvider: async () => sibling
  });
  assert.equal(sibling.stops, 0);
  assert.equal(result.errors[0].message, 'INSTANCE_IDENTITY_MISMATCH');
});

test('a failed stop never produces an all-stopped result', async () => {
  const adapter = owned(905);
  adapter.stopConnection = async () => { throw Object.assign(new Error('private diagnostics'), { code: 'PROCESS_IDENTITY_MISMATCH' }); };
  const result = await stopManagedTunnels({ services: ['one'], adapters: { one: adapter } });
  assert.deepEqual(result.remainingPids, [905]);
  assert.deepEqual(result.killedPids, []);
  assert.ok(result.absenceUnconfirmed);
  assert.equal(result.errors[0].message, 'PROCESS_IDENTITY_MISMATCH');
});

test('a target restarted during the stop pass is caught by final reinspection', async () => {
  const first = owned(906);
  const second = owned(907);
  const originalStop = second.stopConnection;
  second.stopConnection = async () => { const result = await originalStop(); first.restart(); return result; };
  const result = await stopManagedTunnels({ services: ['first', 'second'], adapters: { first, second } });
  assert.deepEqual(result.remainingPids, [906]);
  assert.ok(result.errors.some(error => error.scope === 'managed-process-recheck'));
});

test('a missing adapter fails closed even with an empty process result set', async () => {
  const result = await stopManagedTunnels({ services: ['missing'] });
  assert.deepEqual(result.remainingPids, []);
  assert.ok(result.absenceUnconfirmed);
  assert.equal(result.errors[0].message, 'PROCESS_ADAPTER_UNAVAILABLE');
});

test('HTTP managed stop serializes enumeration through finalization with the existing runner lock', async t => {
  let allowPreviousAction;
  let chain = new Promise(resolve => { allowPreviousAction = resolve; });
  t.after(() => allowPreviousAction());
  let inLock = false;
  const order = [];
  const withExclusiveLock = fn => {
    const next = chain.then(async () => { inLock = true; try { return await fn(); } finally { inLock = false; } });
    chain = next.catch(() => {});
    return next;
  };
  const absent = () => ({
    processController: { inspect: async () => { assert.equal(inLock, true); return { running: false, absenceVerified: true }; } },
    stopConnection: async () => ({ stopped: true, proof: { kind: 'verified-already-stopped' } })
  });
  const server = createHttpServer({ platform: 'darwin',
    security: { guard: async () => true }, runner: { deps: { withExclusiveLock } },
    adapters: { 'overleaf-mcp': absent(), 'antigravity-mcp': absent() },
    repo: {
      listServices: () => { assert.equal(inLock, true); order.push('enumeration'); return []; },
      listInstanceRuntimes: () => [],
      clearActiveService: () => { assert.equal(inLock, true); order.push('finalization'); },
      clearRecoveryState: () => ({ clearedActions: 0, clearedOperations: 0 })
    }
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/tunnel-clients/stop-all`, { method: 'POST' });
  assert.equal(response.status, 202);
  const { jobId } = await response.json();
  assert.deepEqual(order, [], 'a previous lifecycle action still holds the lock');
  const laterLaunch = withExclusiveLock(() => order.push('later-launch'));
  allowPreviousAction();
  await laterLaunch;
  const job = await (await fetch(`${base}/api/tunnel-clients/stop-all/jobs/${jobId}`)).json();
  assert.equal(job.ok, true);
  assert.equal(job.scope, 'managed');
  assert.deepEqual(order, ['enumeration', 'finalization', 'finalization', 'later-launch']);
});
