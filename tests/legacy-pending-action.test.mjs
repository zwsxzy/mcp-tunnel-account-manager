/**
 * Contract §2.3 refers to `getActiveActionForService(serviceId, excludeActionId)`.
 * That function is never defined anywhere in this codebase — the legacy lifecycle falls
 * back to `listPendingActionIds()` + `loadAction()` and treats only APPLYING as a
 * conflict.
 *
 * SCOPE, STATED HONESTLY: the selection rule below is REPLICATED in this file rather
 * than imported from `mcp-lifecycle.mjs` (the helper is not exported). So these cases
 * verify the REAL store primitives (listPendingActionIds / loadAction /
 * transitionAction) and act as a SPECIFICATION of the intended rule — but they cannot
 * catch a regression in the lifecycle's own copy of that rule. Mutation M16 proves this:
 * it changes mcp-lifecycle.mjs and survives, because nothing here loads that file.
 *
 * Closing that hole properly means exporting the helper (a production change) or driving
 * runMcpLifecycleAction end-to-end with a full fake adapter; both are out of scope for
 * this verification pass and are recorded as a known gap rather than papered over.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';

const SERVICE = 'mcp_lifecyclesvc';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
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

async function seed(store, serviceId, profiles = ['userA']) {
  await store.registry.create({ id: serviceId, label: serviceId, enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });
  for (const p of profiles) {
    await store.createProfile({ id: p, label: p,
      services: { [serviceId]: { tunnelId: `t_${p}`, apiKey: `k_${p}` } } });
  }
}

/**
 * Replicates the legacy lifecycle's fallback chain verbatim, so the test tracks the
 * real code path rather than an idealised one.
 */
async function resolvePending(store, serviceId, opId, actionId) {
  const reg = store.registry;
  if (typeof reg.getActiveActionForService === 'function') {
    return { via: 'named', id: await reg.getActiveActionForService(serviceId, opId) };
  }
  if (typeof reg.listPendingActionIds === 'function' && typeof reg.loadAction === 'function') {
    for (const pid of reg.listPendingActionIds()) {
      if (pid === opId || pid === actionId) continue;
      const a = await reg.loadAction(pid);
      if (a && a.serviceId === serviceId && (a.state === 'APPLYING' || a.status === 'APPLYING')) {
        return { via: 'fallback', id: pid };
      }
    }
    return { via: 'fallback', id: null };
  }
  return { via: 'none', id: null };
}

test('a merely QUEUED action is not treated as an executing conflict', async (t) => {
  const store = workspace(t);
  await seed(store, SERVICE);

  const queued = await store.registry.createLifecycleAction({ action: 'start', serviceId: SERVICE, profileId: 'userA' });
  assert.equal((await store.loadAction(queued.id))?.state, 'QUEUED');

  const r = await resolvePending(store, SERVICE, 'op-other', 'act-other');
  assert.equal(r.id, null, 'queued work must not block later work');
});

test('an APPLYING action IS reported as a conflict', async (t) => {
  const store = workspace(t);
  await seed(store, SERVICE);

  const act = await store.registry.createLifecycleAction({ action: 'start', serviceId: SERVICE, profileId: 'userA' });
  await store.registry.transitionAction(act.id, { state: 'APPLYING' });

  const r = await resolvePending(store, SERVICE, 'op-other', 'act-other');
  assert.equal(r.id, act.id, 'an executing action must be reported');
});

test('an action never conflicts with itself', async (t) => {
  const store = workspace(t);
  await seed(store, SERVICE);

  const act = await store.registry.createLifecycleAction({ action: 'start', serviceId: SERVICE, profileId: 'userA' });
  await store.registry.transitionAction(act.id, { state: 'APPLYING' });

  assert.equal((await resolvePending(store, SERVICE, act.id, act.id)).id, null);
});

test('an APPLYING action for ANOTHER service does not conflict here', async (t) => {
  const store = workspace(t);
  const other = 'mcp_lifecyclesvc2';
  await seed(store, SERVICE);
  await seed(store, other, ['userB']);

  const act = await store.registry.createLifecycleAction({ action: 'start', serviceId: SERVICE, profileId: 'userA' });
  await store.registry.transitionAction(act.id, { state: 'APPLYING' });

  assert.equal((await resolvePending(store, other, 'op-x', 'act-x')).id, null);
});

test('getActiveActionForService is absent on both surfaces (recorded deviation)', async (t) => {
  const store = workspace(t);
  // Documents the contract/doc mismatch: this test exists so the absence is deliberate
  // and visible, not an unnoticed gap. Behaviour above still meets the intent.
  assert.equal(typeof store.registry?.getActiveActionForService, 'undefined');
  assert.equal(typeof store.getActiveActionForService, 'undefined');
  assert.equal(typeof store.registry.listPendingActionIds, 'function', 'the fallback must remain available');
});
