/**
 * Regression: a genuinely running, verified instance MUST be stoppable/restartable.
 *
 * Before the fix, `instance_runtime` never persisted `owned` / `identity_verified`,
 * so `publicInstanceDTO()` returned `owned:false` for every row and
 * `getInstanceActionGating()` (which requires `owned === true`) left the stop and
 * restart buttons permanently disabled — a user could start instance after instance
 * but never stop one from the console.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';
import { publicInstanceDTO } from '../src/core/concurrent-instances.mjs';
import { getInstanceActionGating } from '../public/app.js';

const __filename = fileURLToPath(import.meta.url);
const SERVICE = 'mcp_ownershipsvc';
const PROFILE = 'userA';
const INSTANCE = `${SERVICE}__${PROFILE}`;

/** Fresh isolated store; never touches production paths. */
function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ownership-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });
  return { dataDir, store, vault };
}

test('instance_runtime persists owned/identityVerified and the DTO exposes them', async (t) => {
  const { store } = createWorkspace(t);

  const created = store.upsertInstanceRuntime(INSTANCE, {
    serviceId: SERVICE,
    profileId: PROFILE,
    state: 'running',
    pid: 4321,
    startedAt: '2026-11-10T00:00:00.000Z',
    executablePath: 'C:\\fake\\tunnel-client.exe',
    owned: true,
    identityVerified: true,
    observedAt: '2026-11-10T00:00:01.000Z'
  });

  assert.equal(created.owned, true, 'owned must round-trip as a boolean');
  assert.equal(created.identityVerified, true, 'identityVerified must round-trip');

  const dto = publicInstanceDTO({ ...created, serviceId: SERVICE, instanceId: INSTANCE });
  assert.equal(dto.state, 'running');
  assert.equal(dto.owned, true);
  assert.equal(dto.identityVerified, true);
});

test('absence of ownership evidence must never be read as owned', async (t) => {
  const { store } = createWorkspace(t);

  // A row written WITHOUT ownership evidence (e.g. legacy DB, or a crash between
  // launch and verification) must read back as explicitly not owned.
  const created = store.upsertInstanceRuntime(INSTANCE, {
    serviceId: SERVICE,
    profileId: PROFILE,
    state: 'running',
    pid: 4322,
    startedAt: '2026-11-10T00:00:00.000Z',
    executablePath: 'C:\\fake\\tunnel-client.exe',
    observedAt: '2026-11-10T00:00:01.000Z'
  });

  assert.equal(created.owned, false, 'missing evidence => not owned');
  assert.equal(created.identityVerified, false);

  const dto = publicInstanceDTO({ ...created, serviceId: SERVICE, instanceId: INSTANCE });
  assert.equal(dto.owned, false);
});

test('clearInstanceRuntime drops ownership when the process stops', async (t) => {
  const { store } = createWorkspace(t);

  store.upsertInstanceRuntime(INSTANCE, {
    serviceId: SERVICE, profileId: PROFILE, state: 'running', pid: 4323,
    startedAt: '2026-11-10T00:00:00.000Z', executablePath: 'C:\\fake\\tunnel-client.exe',
    owned: true, identityVerified: true, observedAt: '2026-11-10T00:00:01.000Z'
  });
  assert.equal(store.getInstanceRuntime(INSTANCE).owned, true);

  const cleared = store.clearInstanceRuntime(INSTANCE);
  assert.equal(cleared.state, 'stopped');
  assert.equal(cleared.pid, null);
  assert.equal(cleared.owned, false, 'a stopped instance is no longer owned');
  assert.equal(cleared.identityVerified, false);
});

test('a running, owned instance is stoppable AND restartable in the UI gating', () => {
  const mcp = { id: SERVICE, enabled: true };
  const owned = {
    instanceId: INSTANCE, serviceId: SERVICE, profileId: PROFILE,
    state: 'running', managed: true, owned: true, identityVerified: true, pid: 4324
  };

  const gating = getInstanceActionGating(mcp, owned, [PROFILE]);
  assert.equal(gating.stop.disabled, false, 'stop must be enabled for an owned running instance');
  assert.equal(gating.restart.disabled, false, 'restart must be enabled for an owned running instance');
  assert.equal(gating.start.disabled, true, 'start must stay disabled while running');
});

test('a running instance WITHOUT ownership evidence keeps stop/restart disabled', () => {
  const mcp = { id: SERVICE, enabled: true };
  const unowned = {
    instanceId: INSTANCE, serviceId: SERVICE, profileId: PROFILE,
    state: 'running', managed: true, owned: false, identityVerified: false, pid: 4325
  };

  const gating = getInstanceActionGating(mcp, unowned);
  assert.equal(gating.stop.disabled, true, 'an unverified process must not be stoppable from the UI');
  assert.equal(gating.restart.disabled, true);
});

// ---------------------------------------------------------------------------
// The tests above cover the DATA path. These cover the two places that WRITE it
// and the isolation guard that protects production — verified by mutation
// testing (removing any of them previously left every test green).
// ---------------------------------------------------------------------------

import { createInstanceAdapterProvider } from '../src/adapters/instance-adapter.mjs';
import { runInstanceLifecycleAction } from '../src/core/instance-lifecycle.mjs';

const PROBE = {
  isDefault: false,
  async checkReady() { return true; },
  async verify(a) { return { ok: true, verified: true, identity: a.identity, proof: { kind: 'authenticated-control-plane' } }; },
  async probe() { return { live: true, ready: true }; }
};

/** Fake OS boundary: deterministic identities, no real tunnel binary, temp dir only. */
function createFakeRuntime() {
  const alive = new Map();
  let seq = 0;
  return async function runtimeCommand(action, params = {}) {
    if (action === 'Launch') {
      seq += 1;
      const pid = 960000 + seq;
      const args = [...(Array.isArray(params.Arguments) ? params.Arguments : []),
                    ...(Array.isArray(params.args) ? params.args : [])].map(String);
      const i = args.indexOf('--health.url-file');
      if (i >= 0) {
        fs.mkdirSync(path.dirname(args[i + 1]), { recursive: true });
        fs.writeFileSync(args[i + 1], `http://127.0.0.1:${66000 + seq}\n`, 'utf8');
      }
      const id = { pid, exe: process.execPath, ft: String(133000000000000000n + BigInt(pid)), port: 66000 + seq };
      alive.set(pid, id);
      return { code: 0, success: true, processId: pid, executablePath: id.exe,
        creationDate: new Date().toISOString(), creationTimeFileTime: id.ft };
    }
    if (action === 'Inspect') {
      const id = alive.get(Number(params.ProcessId));
      return id
        ? { code: 0, running: true, processId: id.pid, executablePath: id.exe, creationTimeFileTime: id.ft,
            creationDate: new Date().toISOString(), localPort: id.port }
        : { code: 0, running: false };
    }
    if (action === 'Verify') {
      const id = alive.get(Number(params.ProcessId));
      const valid = Boolean(id) && String(params.ExpectedExecutablePath) === String(id.exe)
        && String(params.ExpectedCreationTimeFileTime) === String(id.ft);
      return { code: 0, valid };
    }
    if (action === 'Stop') {
      const id = alive.get(Number(params.ProcessId));
      if (!id) return { code: 0, stopped: true };
      alive.delete(id.pid);
      return { code: 0, stopped: true };
    }
    if (action === 'FindOwned') return { code: 0, running: false };
    return { code: 0 };
  };
}

/** Isolated service + profile + provider + workspace. */
function createLifecycleWorkspace(t) {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'ownlc-'));
  const dataDir = path.join(root, 'data');
  const tunnelHome = path.join(root, 'th');
  const appData = path.join(root, 'ad');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tunnelHome, { recursive: true });
  fs.mkdirSync(path.join(appData, 'tunnel-client'), { recursive: true });
  const bin = path.join(tunnelHome, 'tunnel-client.exe');
  fs.writeFileSync(bin, 'fake', 'utf8');
  const paths = { userProfile: root, appData, tunnelHome, tunnelClientBin: bin };

  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });
  return { dataDir, paths, vault, store };
}

test('a verified instance START persists owned+identityVerified (UI stop/restart depend on it)', async (t) => {
  const { dataDir, paths, vault, store } = createLifecycleWorkspace(t);
  const SERVICE_ID = 'mcp_ownerlcs';

  await store.registry.create({ id: SERVICE_ID, label: 'lc', enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });
  await store.createProfile({ id: PROFILE, label: 'A',
    services: { [SERVICE_ID]: { tunnelId: 't_lc', apiKey: 'k_lc' } } });

  const provider = createInstanceAdapterProvider({
    dataDir, vault, probe: PROBE, paths, runtimeCommand: createFakeRuntime()
  });
  const instanceId = `${SERVICE_ID}__${PROFILE}`;
  const action = await store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE_ID, profileId: PROFILE, instanceId
  });
  await runInstanceLifecycleAction({ repo: store, adapterProvider: provider, actionId: action.id, vault });

  const loaded = await store.loadAction(action.id);
  assert.equal(loaded.state, 'SUCCEEDED', `start must succeed (got ${loaded.state}/${loaded.errorCode})`);

  const record = store.getInstanceRuntime(instanceId);
  assert.equal(record.state, 'running');
  assert.equal(record.owned, true, 'a started+verified instance MUST be recorded as owned');
  assert.equal(record.identityVerified, true, 'a started+verified instance MUST be recorded as identity-verified');

  // …and that is exactly what makes the UI buttons usable.
  const dto = publicInstanceDTO({ ...record, serviceId: SERVICE_ID, instanceId });
  const gating = getInstanceActionGating({ id: SERVICE_ID, enabled: true }, dto, [PROFILE]);
  assert.equal(gating.stop.disabled, false, 'stop must be enabled end-to-end after a real start');
  assert.equal(gating.restart.disabled, false);
});

test('colliding profile ids cannot rebind an existing instance row (would strand a live pid)', async (t) => {
  const { store } = createLifecycleWorkspace(t);
  const id = `${SERVICE}__Work_Account`;

  store.upsertInstanceRuntime(id, {
    serviceId: SERVICE, profileId: 'Work Account', state: 'running', pid: 41000,
    startedAt: '2026-01-01T00:00:00.000Z', executablePath: 'C:\fake\tunnel-client.exe'
  });

  assert.throws(
    () => store.upsertInstanceRuntime(id, { serviceId: SERVICE, profileId: 'Work_Account', state: 'running', pid: 99999 }),
    err => err.code === 'INVALID_INSTANCE',
    'a colliding profileId must be refused, not silently rebind the row'
  );

  const preserved = store.getInstanceRuntime(id);
  assert.equal(preserved.profileId, 'Work Account');
  assert.equal(preserved.pid, 41000, 'the original account must keep its pid');
});

test('the instance provider refuses production data directories', async (t) => {
  const { paths, vault } = createLifecycleWorkspace(t);
  const prodData = path.resolve(process.env.LOCALAPPDATA || 'C:\nonexistent', 'McpTunnelAccountManager');

  assert.throws(
    () => createInstanceAdapterProvider({ dataDir: prodData, vault, paths }),
    'instances must never be written next to the production database'
  );
});

// ---------------------------------------------------------------------------
// Truncation-collision behaviour (sanitizeProfileSegment caps at 64 chars while
// discovery identities are 71). Two distinct accounts can therefore fold onto one
// instanceId. The store refuses to rebind the row — that part is covered above.
// What must NOT happen is a silent false success: the second account must never
// report SUCCEEDED while nothing of its own was launched.
// ---------------------------------------------------------------------------

test('a truncation-colliding second account never reports a false success', async (t) => {
  const { dataDir, paths, vault, store } = createLifecycleWorkspace(t);
  const SERVICE_ID = 'mcp_truncsvc';
  // Both 71 chars; identical for the first 64, so they sanitize to one segment.
  const ACCOUNT_A = 'acct-' + 'x'.repeat(66);
  const ACCOUNT_B = 'acct-' + 'x'.repeat(61) + 'BRAVO';

  await store.registry.create({ id: SERVICE_ID, label: 'trunc', enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });
  for (const [id, tail] of [[ACCOUNT_A, 'AAAA'], [ACCOUNT_B, 'BBBB']]) {
    await store.createProfile({ id, label: tail,
      services: { [SERVICE_ID]: { tunnelId: `t_${tail}`, apiKey: `k_${tail}` } } });
  }

  const launches = [];
  const fake = createFakeRuntime();
  const countingRuntime = async (action, params) => {
    if (action === 'Launch') launches.push(params);
    return await fake(action, params);
  };

  const provider = createInstanceAdapterProvider({
    dataDir, vault, probe: PROBE, paths, runtimeCommand: countingRuntime
  });

  async function start(profileId) {
    const instanceId = `${SERVICE_ID}__${await import('../src/core/concurrent-instances.mjs')
      .then(m => m.sanitizeProfileSegment(profileId))}`;
    const act = await store.registry.createLifecycleAction({
      action: 'start', serviceId: SERVICE_ID, profileId, instanceId
    });
    await runInstanceLifecycleAction({ repo: store, adapterProvider: provider, actionId: act.id, vault });
    return await store.loadAction(act.id);
  }

  const first = await start(ACCOUNT_A);
  assert.equal(first.state, 'SUCCEEDED', 'the first account must start normally');
  assert.equal(launches.length, 1);

  const second = await start(ACCOUNT_B);

  // Either outcome is acceptable EXCEPT a silent false success:
  //  - REJECTED (colliding identity refused), or
  //  - SUCCEEDED *and* genuinely launched a process of its own.
  const launchedOwnProcess = launches.length === 2;
  const refused = second.state !== 'SUCCEEDED';

  assert.ok(
    refused || launchedOwnProcess,
    `colliding account reported ${second.state} without launching its own process ` +
    `(launches=${launches.length}) — that is a silent false success`
  );

  // Whatever happened, the surviving row must stay attributed to ONE account and
  // must match a genuinely live process.
  const rows = store.listInstanceRuntimes(SERVICE_ID);
  assert.equal(rows.length, 1, 'the colliding segment can only ever hold one row');
  assert.ok(rows[0].pid, 'the surviving row must reference a real pid');
});
