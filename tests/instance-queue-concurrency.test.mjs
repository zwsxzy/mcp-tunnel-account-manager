/**
 * Contract §2.3: "A pending action for instance A must NOT block instance B."
 *
 * The global one-action-at-a-time gate was still applied when QUEUEING instance
 * actions, so two accounts of one service could not even be queued together — they
 * collided with 409 BUSY before either one ran. Queuing must be per-instance; only
 * the legacy whole-service scope (and the same instance) may conflict.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'queue-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });
  return store;
}

async function seed(store, serviceId, profileIds) {
  await store.registry.create({ id: serviceId, label: serviceId, enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });
  for (const id of profileIds) {
    await store.createProfile({ id, label: id,
      services: { [serviceId]: { tunnelId: `t_${id}`, apiKey: `k_${id}` } } });
  }
}

test('a queued instance action does not block queueing another instance of the same service', async (t) => {
  const store = workspace(t);
  const S = 'mcp_queuea';
  await seed(store, S, ['acctA', 'acctB']);

  const first = await store.registry.createLifecycleAction({
    action: 'start', serviceId: S, profileId: 'acctA', instanceId: `${S}__acctA`
  });
  assert.ok(first?.id, 'first instance action queued');

  // This used to throw 409 BUSY, making concurrent instances impossible to queue.
  const second = await store.registry.createLifecycleAction({
    action: 'start', serviceId: S, profileId: 'acctB', instanceId: `${S}__acctB`
  });
  assert.ok(second?.id, 'a different instance must be able to queue alongside the first');
  assert.notEqual(first.id, second.id);
});

test('a queued instance action still blocks a SECOND action on the SAME instance', async (t) => {
  const store = workspace(t);
  const S = 'mcp_queueb';
  await seed(store, S, ['acctA']);
  const instanceId = `${S}__acctA`;

  await store.registry.createLifecycleAction({ action: 'start', serviceId: S, profileId: 'acctA', instanceId });

  await assert.rejects(
    () => store.registry.createLifecycleAction({ action: 'stop', serviceId: S, profileId: 'acctA', instanceId }),
    (err) => err.code === 'BUSY' || err.statusCode === 409,
    'one instance must not have two concurrent actions'
  );
});

test('a queued LEGACY whole-service action still blocks new instance actions', async (t) => {
  const store = workspace(t);
  const S = 'mcp_queuec';
  await seed(store, S, ['acctA']);

  // Legacy action: no instanceId => whole-service scope.
  await store.registry.createLifecycleAction({ action: 'stop', serviceId: S, profileId: null });

  await assert.rejects(
    () => store.registry.createLifecycleAction({
      action: 'start', serviceId: S, profileId: 'acctA', instanceId: `${S}__acctA`
    }),
    (err) => err.code === 'BUSY' || err.statusCode === 409,
    'legacy whole-service actions must still conflict with everything for that service'
  );
});

test('two DIFFERENT services can each queue an instance action simultaneously', async (t) => {
  const store = workspace(t);
  await seed(store, 'mcp_queued', ['acctA']);
  await seed(store, 'mcp_queuee', ['acctB']);

  await store.registry.createLifecycleAction({
    action: 'start', serviceId: 'mcp_queued', profileId: 'acctA', instanceId: 'mcp_queued__acctA'
  });

  // A second instance action on another service must queue too (per-instance scope).
  const other = await store.registry.createLifecycleAction({
    action: 'start', serviceId: 'mcp_queuee', profileId: 'acctB', instanceId: 'mcp_queuee__acctB'
  });
  assert.ok(other?.id, 'instance actions on different services are unaffected');
});

test('a legacy action (no instanceId) still conflicts globally, by design', async (t) => {
  const store = workspace(t);
  await seed(store, 'mcp_queuef', ['acctA']);
  await seed(store, 'mcp_queueg', ['acctB']);

  await store.registry.createLifecycleAction({
    action: 'start', serviceId: 'mcp_queuef', profileId: 'acctA', instanceId: 'mcp_queuef__acctA'
  });

  // Legacy whole-service actions carry no instance scope, so they keep the
  // pre-existing global one-action-at-a-time semantics (unchanged by this feature).
  await assert.rejects(
    () => store.registry.createLifecycleAction({ action: 'stop', serviceId: 'mcp_queueg', profileId: null }),
    (err) => err.code === 'BUSY' || err.statusCode === 409,
    'legacy actions retain the global single-action rule'
  );
});
