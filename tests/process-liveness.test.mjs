/**
 * Stale `running` claims must never be published as live.
 *
 * Regression target: a tunnel-client killed outside the lifecycle (console crash,
 * machine sleep, external kill) left `instance_runtime` saying `running`. The
 * console rendered that phantom row, and "parallel start selected accounts" then
 * skipped the account as "已在运行" even though nothing was running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isProcessAlive, reconcileStaleRunning } from '../src/core/process-liveness.mjs';
import { reconcilePublishedLiveness } from '../src/http/mcp-routes.mjs';

/** A pid that cannot be alive in practice (Windows tops out far below this). */
const DEAD_PID = 999999;

test('isProcessAlive: own process is alive, invalid and dead pids are not', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(DEAD_PID), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-5), false);
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive('4242'), false);
});

test('reconcileStaleRunning: a dead running claim is downgraded, not trusted', () => {
  const stale = {
    instanceId: 'mcp_dsh_chatgpt_bridge__p1',
    state: 'running',
    pid: DEAD_PID,
    owned: true,
    managed: true,
    identityVerified: true,
    reasonCode: 'process_verified_running',
    observedAt: '2026-11-11T14:39:58.813Z'
  };
  const fixed = reconcileStaleRunning(stale);
  assert.notEqual(fixed, stale);
  assert.equal(fixed.state, 'stopped');
  assert.equal(fixed.pid, null);
  assert.equal(fixed.owned, false);
  // store.mjs keeps `managed === owned`; leaving managed true published the
  // contradictory {state:'stopped', owned:false, managed:true}.
  assert.equal(fixed.managed, false);
  assert.equal(fixed.identityVerified, false);
  assert.equal(fixed.reasonCode, 'process_not_found');
  assert.equal(fixed.instanceId, stale.instanceId);
  // The caller's record must not be mutated.
  assert.equal(stale.state, 'running');
  assert.equal(stale.pid, DEAD_PID);
});

test('reconcileStaleRunning: live and non-running records are returned untouched', () => {
  const live = { instanceId: 'i', state: 'running', pid: process.pid, owned: true };
  assert.equal(reconcileStaleRunning(live), live);

  const stopped = { instanceId: 'i', state: 'stopped', pid: null };
  assert.equal(reconcileStaleRunning(stopped), stopped);

  // Transitional states belong to the lifecycle; never rewrite them from a read.
  for (const state of ['starting', 'stopping', 'restarting', 'failed', 'unmanaged', 'unobserved']) {
    const row = { instanceId: 'i', state, pid: DEAD_PID };
    assert.equal(reconcileStaleRunning(row), row);
  }
  assert.equal(reconcileStaleRunning(null), null);
});

test('reconcilePublishedLiveness: /api/mcps projection downgrades phantom rows', () => {
  const dto = {
    id: 'mcp_dsh_chatgpt_bridge',
    runtime: {
      instances: [
        { instanceId: 'a', state: 'running', pid: DEAD_PID, owned: true, managed: true, identityVerified: true },
        { instanceId: 'b', state: 'running', pid: process.pid, owned: true, identityVerified: true },
        { instanceId: 'c', state: 'stopped', pid: null }
      ],
      tunnelClient: { state: 'running', pid: DEAD_PID, reasonCode: 'process_verified_running' },
      state: 'running'
    }
  };
  const out = reconcilePublishedLiveness(dto);
  assert.equal(out.runtime.instances[0].state, 'stopped');
  assert.equal(out.runtime.instances[0].reasonCode, 'process_not_found');
  assert.equal(out.runtime.instances[1].state, 'running');
  assert.equal(out.runtime.instances[1].pid, process.pid);
  assert.equal(out.runtime.instances[2].state, 'stopped');
  assert.equal(out.runtime.tunnelClient.state, 'stopped');
  assert.equal(out.runtime.tunnelClient.pid, null);
  assert.equal(out.runtime.tunnelClient.reasonCode, 'process_not_found');
  // The service-level projection keeps its own shape: no ownership fields added.
  assert.equal('owned' in out.runtime.tunnelClient, false);
  assert.equal('identityVerified' in out.runtime.tunnelClient, false);
  // `runtime.state` came from the persisted active-profile pointer, so it must not
  // keep claiming running while every row underneath says stopped.
  assert.equal(out.runtime.state, 'stopped');

  // Pure: the input DTO must not be rewritten (formatRuntime forwards provider
  // arrays by reference).
  assert.equal(dto.runtime.instances[0].state, 'running');
  assert.equal(dto.runtime.tunnelClient.state, 'running');
  assert.equal(dto.runtime.state, 'running');
});

test('reconcilePublishedLiveness: a live instance keeps runtime.state running', () => {
  const dto = {
    id: 'svc',
    runtime: {
      instances: [{ instanceId: 'a', state: 'running', pid: process.pid, owned: true, identityVerified: true }],
      state: 'running'
    }
  };
  const out = reconcilePublishedLiveness(dto);
  assert.equal(out.runtime.instances[0].state, 'running');
  assert.equal(out.runtime.state, 'running');
});

test('reconcilePublishedLiveness: no instance rows means no affirmative evidence', () => {
  // Never declare a service stopped just because it has no per-instance rows: the
  // legacy whole-service tunnel path keeps its state elsewhere.
  const dto = { id: 'svc', runtime: { instances: [], state: 'running' } };
  assert.equal(reconcilePublishedLiveness(dto).runtime.state, 'running');
});

test('reconcilePublishedLiveness: services without runtime are passed through', () => {
  const bare = { id: 'x' };
  assert.equal(reconcilePublishedLiveness(bare), bare);
  assert.equal(reconcilePublishedLiveness(null), null);
});
