/**
 * Per-instance recovery isolation.
 *
 * The recovery gate used to be ONE global boolean in `metadata`. When any action
 * ended NEEDS_ATTENTION it was set, and `assertIdle()` consulted it before any
 * per-instance filtering — so a single failing account refused work for every
 * sibling account of the same service with RECOVERY_GATED. With concurrent
 * instances that is the wrong blast radius: account B being healthy is not
 * evidence that account A's side effects are known.
 *
 * These tests pin the new scope rules:
 *   - an instance gate blocks THAT instance only;
 *   - a legacy whole-service gate (instance_id IS NULL) still blocks everything,
 *     because a legacy action touches every account;
 *   - acknowledging an instance action clears only its own gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';
import { buildInstanceId } from '../src/core/concurrent-instances.mjs';

const SERVICE = 'mcp_gatesvc';

function freshStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });
  return { store, dataDir };
}

async function seed(store) {
  await store.registry.create({ id: SERVICE, label: 'gate', enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });
  for (const id of ['acctA', 'acctB', 'acctC']) {
    await store.createProfile({ id, label: id,
      services: { [SERVICE]: { tunnelId: `t_${id}`, apiKey: `k_${id}` } } });
  }
}

function startAction(store, profileId) {
  return store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId,
    instanceId: buildInstanceId(SERVICE, profileId)
  });
}

test('an instance gate blocks that instance but not its siblings', async (t) => {
  const { store } = freshStore(t);
  await seed(store);

  const a = await startAction(store, 'acctA');
  await store.registry.markActionAttention(a.id, 'INTERRUPTED');

  // Same instance: still gated.
  await assert.rejects(
    () => startAction(store, 'acctA'),
    (err) => err.code === 'RECOVERY_GATED',
    'A must stay gated'
  );

  // Siblings: unaffected. This is the regression — it used to throw RECOVERY_GATED.
  const b = await startAction(store, 'acctB');
  assert.ok(b?.id, 'B must be able to queue while A needs attention');
  const c = await startAction(store, 'acctC');
  assert.ok(c?.id, 'C must be able to queue while A needs attention');
});

test('acknowledging an instance action clears only its own gate', async (t) => {
  const { store } = freshStore(t);
  await seed(store);

  const a = await startAction(store, 'acctA');
  const b = await startAction(store, 'acctB');
  await store.registry.markActionAttention(a.id, 'INTERRUPTED');
  await store.registry.markActionAttention(b.id, 'INTERRUPTED');

  assert.equal(store.getRecoveryState().gated, true);

  await store.acknowledgeRecoveryAction({ actionId: a.id, clearGate: true });

  // A is released...
  const a2 = await startAction(store, 'acctA');
  assert.ok(a2?.id, 'A must be runnable again once acknowledged');

  // ...while B stays gated.
  await assert.rejects(
    () => startAction(store, 'acctB'),
    (err) => err.code === 'RECOVERY_GATED',
    'B must remain gated until it is acknowledged too'
  );
});

test('a legacy whole-service gate still blocks every instance', async (t) => {
  const { store } = freshStore(t);
  await seed(store);

  // instance_id IS NULL => legacy semantics, covers the whole service.
  const legacy = await store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctA'
  });
  await store.registry.markActionAttention(legacy.id, 'PROCESS_KILL_FAILED');

  const state = store.getRecoveryState();
  assert.equal(state.gated, true);
  assert.equal(state.instances, undefined, 'a legacy gate is global, not per-instance');

  for (const p of ['acctA', 'acctB', 'acctC']) {
    await assert.rejects(
      () => startAction(store, p),
      (err) => err.code === 'RECOVERY_GATED',
      `legacy gate must still block ${p}`
    );
  }
});

test('getRecoveryState reports which instances are gated', async (t) => {
  const { store } = freshStore(t);
  await seed(store);

  const a = await startAction(store, 'acctA');
  await store.registry.markActionAttention(a.id, 'INTERRUPTED');

  const state = store.getRecoveryState();
  assert.equal(state.gated, true);
  assert.ok(Array.isArray(state.instances) && state.instances.length === 1);
  assert.equal(state.instances[0].instanceId, buildInstanceId(SERVICE, 'acctA'));
  assert.match(state.instances[0].reason, /INTERRUPTED/);
});

test('the ungated state shape is unchanged for existing consumers', async (t) => {
  const { store } = freshStore(t);
  await seed(store);
  // Several callers deepEqual against { gated: false }; keep that byte-identical.
  assert.deepEqual(store.getRecoveryState(), { gated: false });
});
