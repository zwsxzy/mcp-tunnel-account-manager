/**
 * Contract §2.3: "request_fingerprint must incorporate instanceId so idempotency keys
 * cannot collide across instances."
 *
 * Without this, reusing one idempotency key for two accounts of the same service would
 * silently replay the FIRST account's action for the second — the wrong tunnel would be
 * started and the caller would never know.
 *
 * Each case uses its own isolated store: a pending legacy action and a pending instance
 * action legitimately conflict (see instance-queue-concurrency tests), so sharing one
 * store across cases would fail for unrelated reasons.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';

const SERVICE = 'mcp_idemsvc';

async function freshStore(t) {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'idem-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  await store.registry.create({ id: SERVICE, label: 'idem', enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });
  for (const [id, tail] of [['acctA', 'AAAA'], ['acctB', 'BBBB']]) {
    await store.createProfile({ id, label: tail,
      services: { [SERVICE]: { tunnelId: `t_${tail}`, apiKey: `k_${tail}` } } });
  }
  return { store, dataDir };
}

test('the same idempotency key for a DIFFERENT instance is refused, never silently replayed', async (t) => {
  const { store } = await freshStore(t);
  const KEY = 'idem-cross-001';

  const first = await store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctA',
    instanceId: `${SERVICE}__acctA`, idempotencyKey: KEY
  });
  assert.ok(first?.id);
  assert.equal(first.profileId, 'acctA');

  await assert.rejects(
    () => store.registry.createLifecycleAction({
      action: 'start', serviceId: SERVICE, profileId: 'acctB',
      instanceId: `${SERVICE}__acctB`, idempotencyKey: KEY
    }),
    (err) => err.code === 'IDEMPOTENCY_CONFLICT',
    'reusing a key across instances must be refused, not replayed as the first account'
  );
});

test('the same idempotency key for the SAME instance still replays idempotently', async (t) => {
  const { store } = await freshStore(t);
  const KEY = 'idem-same-002';

  const first = await store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctA',
    instanceId: `${SERVICE}__acctA`, idempotencyKey: KEY
  });
  const again = await store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctA',
    instanceId: `${SERVICE}__acctA`, idempotencyKey: KEY
  });

  assert.equal(again?.id, first?.id, 'a repeat must return the original action');
  assert.equal(again?.instanceId, `${SERVICE}__acctA`);
});

test('legacy actions keep the pre-instance fingerprint shape (old keys still replay)', async (t) => {
  const { store, dataDir } = await freshStore(t);
  const KEY = 'idem-legacy-003';

  const action = await store.registry.createLifecycleAction({
    action: 'stop', serviceId: SERVICE, profileId: null, idempotencyKey: KEY
  });

  const db = new DatabaseSync(path.join(dataDir, 'manager.db'));
  const row = db.prepare('SELECT request_fingerprint FROM mcp_actions WHERE id = ?').get(action.id);
  db.close();

  // The exact pre-feature shape: no instanceId member at all.
  const expected = crypto.createHash('sha256').update(JSON.stringify({
    action: 'stop',
    serviceId: SERVICE,
    profileId: null,
    expectedRevision: null
  })).digest('hex');

  assert.equal(row?.request_fingerprint, expected,
    'legacy fingerprints must stay byte-identical so in-flight keys from a previous release still replay');

  const again = await store.registry.createLifecycleAction({
    action: 'stop', serviceId: SERVICE, profileId: null, idempotencyKey: KEY
  });
  assert.equal(again?.id, action.id);
});

test('instance fingerprints differ per instance (the mechanism behind the rule)', async (t) => {
  const { store } = await freshStore(t);

  const a = await store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctA', instanceId: `${SERVICE}__acctA`
  });
  const b = await store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctB', instanceId: `${SERVICE}__acctB`
  });
  assert.ok(a?.id && b?.id);
  assert.notEqual(a.id, b.id, 'two instances must produce two distinct actions');
});
