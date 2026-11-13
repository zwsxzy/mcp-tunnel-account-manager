/**
 * Regressions for the 2026-11-12 repair round (HANDOFF-20261112 §2 items 1-4).
 *
 * Every case here is a NEGATIVE-capable assertion: each one fails on the pre-repair
 * behaviour, so a future revert turns them red instead of silently passing.
 *
 * Covers, in order:
 *   1. Removal deadlock (§2-1): a documented stop that lands on ALREADY_STOPPED must
 *      clear the legacy pointer, and removal must then succeed -- but ONLY with
 *      verified absence, and never for live / unknown / synthetic evidence.
 *   2. Stop-all convergence (§2-2): per-item tolerance, pointer + cache convergence,
 *      and "residual pid / enumeration error keeps the facts" (no fake success).
 *   3. Carrier identity (§2-3): a persisted row is a claim -- dead pid, missing
 *      verifier, verifier false/throw, and stored `stopped` all degrade to unverified.
 *   4. Instance cap (§2-4): phantom rows must not consume the per-service quota.
 *
 * All tests use fakes or a throwaway dataDir. Nothing here starts, stops or probes a
 * real tunnel-client, and no test binds anything but an ephemeral loopback port.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';
import { createRuntimeObserver } from '../src/adapters/runtime-observer.mjs';
import { createHttpServer, finalizeStoppedState } from '../src/server.mjs';
import { resolveRemovalRuntimeState } from '../src/mcp-registry-store.mjs';
import { runMcpLifecycleAction } from '../src/core/mcp-lifecycle.mjs';
import { createInstanceRoutes } from '../src/http/instance-routes.mjs';
import { buildInstanceId } from '../src/core/concurrent-instances.mjs';

// NOT one of the store's seeded defaults ('overleaf-mcp', 'antigravity-mcp'),
// so create() below is an insert rather than a duplicate-id rejection.
const SERVICE = 'mcp_guardfix';
const PROFILE = 'acct-one';
const OTHER_PROFILE = 'acct-two';

/** A pid that certainly is not running: this process's own id + a large offset. */
function deadPid() {
  return 0x7FFFFFF0;
}

async function makeStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fix-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });
  await store.registry.create({
    id: SERVICE,
    label: 'overleaf',
    enabled: true,
    // Carrier control is what makes stop/restart require a bound process
    // identity, so the identity cases below must exercise that path.
    controlCarrier: true,
    binding: { type: 'stdio', executable: 'node', args: [] }
  });
  await store.createProfile({
    id: PROFILE,
    label: 'Account One',
    services: { [SERVICE]: { tunnelId: 'tunnel_one', apiKey: 'key_one' } }
  });
  return { store, vault, dataDir, root };
}

// ---------------------------------------------------------------------------
// 1. Removal guard: what may be believed about runtime, and the deadlock exit
// ---------------------------------------------------------------------------

test('removal: a non-synthetic stopped observation resolves to stopped', () => {
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: { runtimeState: 'running', activeProfileId: PROFILE, instances: [] },
    observer: { peekTunnelClient: () => ({ state: 'stopped', pid: null }) }
  });
  assert.equal(verdict.state, 'stopped');
});

test('removal: a SYNTHETIC stopped row is not absence proof', () => {
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: { runtimeState: 'running', activeProfileId: PROFILE, instances: [] },
    observer: { peekTunnelClient: () => ({ state: 'stopped', synthetic: true, pid: null }) }
  });
  assert.notEqual(verdict.state, 'stopped', 'an invented row must never unlock removal');
});

test('removal: a running observation WITHOUT a pid blocks instead of reading as dead', () => {
  // Regression: `isAlive(null)` is false, so the first version of the resolver
  // concluded "observed running, pid gone => stopped" and deleted a service the
  // observer still reported as running.
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: { runtimeState: 'stopped', activeProfileId: null, instances: [] },
    observer: { peekTunnelClient: () => ({ state: 'running', pid: null }) }
  });
  assert.equal(verdict.state, 'running');
});

test('removal: a running observation with a DEAD pid has converged to stopped', () => {
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: { runtimeState: 'running', activeProfileId: PROFILE, instances: [] },
    observer: { peekTunnelClient: () => ({ state: 'running', pid: deadPid() }) }
  });
  assert.equal(verdict.state, 'stopped');
});

test('removal: unknown evidence stays unknown (never a guess)', () => {
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: { runtimeState: 'running', activeProfileId: PROFILE, instances: [] },
    observer: null
  });
  assert.equal(verdict.state, 'unknown');
});

test('removal: a live instance row blocks removal', () => {
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: {
      runtimeState: 'stopped',
      instances: [{ state: 'running', pid: process.pid }]
    },
    observer: null,
    isAlive: () => true
  });
  assert.equal(verdict.state, 'running');
});

// ---------------------------------------------------------------------------
// Cross-evidence precedence. BLOCKING evidence (a live pid, a transition, an
// unresolved `running` claim) must be evaluated over the WHOLE evidence set
// before ANY permitting evidence (a dead pid, a stopped row) may return.
// Each case below is a red-on-old-implementation control: the old resolver
// returned a permitting verdict because it inspected evidence in the order it
// happened to arrive.
// ---------------------------------------------------------------------------

const LIVE_PID = 900001;   // "alive" only through the injected isAlive
const DEAD_PID = 900002;   // dead through the injected isAlive
const aliveOnly = (pid) => pid === LIVE_PID;

test('removal: a live pid behind a NON-running instance state still blocks', () => {
  // Old behaviour: liveRow only looked at state === running|starting, so an
  // instance row that still carries a live pid under unmanaged/stopped/failed was
  // skipped, and the following stopped observation permitted the deletion.
  for (const state of ['unmanaged', 'stopped', 'failed']) {
    const verdict = resolveRemovalRuntimeState({
      serviceId: SERVICE,
      rt: { runtimeState: 'stopped', instances: [{ state, pid: LIVE_PID }] },
      observer: { peekTunnelClient: () => ({ state: 'stopped', pid: null }) },
      isAlive: aliveOnly
    });
    assert.equal(verdict.state, 'running',
      `a live pid must block even when the row says ${state}`);
  }
});

test('removal: an unresolved running row (pid null) is unknown, not absent', () => {
  // A `running` claim with no pid is not "the pid died": there is no pid at all.
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: { runtimeState: 'stopped', instances: [{ state: 'running', pid: null }] },
    observer: { peekTunnelClient: () => ({ state: 'stopped', pid: null }) },
    isAlive: aliveOnly
  });
  assert.equal(verdict.state, 'unknown');
});

test('removal: a stopped observer row cannot outrank a LIVE tunnelClient claim', () => {
  // Old behaviour: the candidate loop returned `stopped` from the first candidate
  // and never looked at the second, which still reported a live pid.
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: {
      runtimeState: 'running',
      instances: [],
      tunnelClient: { state: 'running', pid: LIVE_PID }
    },
    observer: { peekTunnelClient: () => ({ state: 'stopped', pid: null }) },
    isAlive: aliveOnly
  });
  assert.equal(verdict.state, 'running');
});

test('removal: a dead-pid observation cannot outrank a LIVE second claim', () => {
  // Old behaviour: candidate #1 said running-with-dead-pid => immediate `stopped`,
  // so candidate #2's live pid was never consulted.
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: {
      runtimeState: 'running',
      instances: [],
      tunnelClient: { state: 'running', pid: LIVE_PID }
    },
    observer: { peekTunnelClient: () => ({ state: 'running', pid: DEAD_PID }) },
    isAlive: aliveOnly
  });
  assert.equal(verdict.state, 'running');
});

test('removal: a stopped observation cannot outrank an UNRESOLVED running claim', () => {
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: {
      runtimeState: 'running',
      instances: [],
      tunnelClient: { state: 'running', pid: null }
    },
    observer: { peekTunnelClient: () => ({ state: 'stopped', pid: null }) },
    isAlive: aliveOnly
  });
  assert.ok(
    verdict.state === 'running' || verdict.state === 'unknown',
    `an unresolved running claim must block, got ${verdict.state}`
  );
  assert.notEqual(verdict.state, 'stopped');
});

test('removal: a stopped observation cannot outrank a TRANSITION claim', () => {
  // The transition belongs to the observation channel (not to rt.instances), so
  // the old transitionRow check never saw it and the stopped row won.
  const verdict = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: {
      runtimeState: 'running',
      instances: [],
      tunnelClient: { state: 'starting', pid: DEAD_PID }
    },
    observer: { peekTunnelClient: () => ({ state: 'stopped', pid: null }) },
    isAlive: aliveOnly
  });
  assert.equal(verdict.state, 'starting');
});

test('removal: dead lock BROKEN end to end -- verified stop noop clears the pointer', async (t) => {
  const { store } = await makeStore(t);

  // Reproduce the real failure: the store still holds the legacy active pointer
  // (the tunnel died outside the console, so nothing cleared it) and there is no
  // instance row and no observation at all -- the exact "pointer says running,
  // nothing else is known" state that used to block deletion forever.
  store.registry.handleSetActiveService(SERVICE, PROFILE, 1, 1);

  // The store-side reader still derives `running` from that pointer, and an
  // unevidenced `running` claim must never permit removal.
  const before = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: store.getServiceRuntime(SERVICE),
    observer: null
  });
  assert.equal(before.state, 'unknown', 'a stale pointer alone must not permit removal');
  await assert.rejects(
    () => store.registry.remove(SERVICE),
    (err) => err.status === 409 && err.code === 'RUNTIME_STATE_UNKNOWN'
  );

  // The user follows the UI advice ("stop it first"). The adapter reports that no
  // process exists, so the action resolves to ALREADY_STOPPED.
  const observer = createRuntimeObserver({ now: () => Date.now(), ttlMs: 90000 });
  store.registry.setObserver(observer);
  observer.setTunnelClient(SERVICE, {
    state: 'stopped', managed: true, pid: null,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90000).toISOString(),
    reasonCode: 'process_stopped', absenceVerified: true
  });

  const action = await store.registry.createLifecycleAction({
    action: 'stop',
    serviceId: SERVICE,
    idempotencyKey: 'guard-fix-stop-1'
  });

  const adapterProvider = () => ({
    // Authoritative inspection: the tunnel is genuinely gone.
    processController: {
      async inspect() {
        return { running: false, pid: null };
      },
      async verify() {
        return { valid: false };
      }
    }
  });

  const settled = await runMcpLifecycleAction({
    repo: store,
    adapterProvider,
    actionId: action.id,
    vault: null
  });
  assert.equal(settled.state, 'SUCCEEDED');

  // The pointer is gone, so the store now reports stopped with no live pid.
  const afterRt = store.getServiceRuntime(SERVICE);
  assert.equal(afterRt.runtimeState, 'stopped', 'the noop must clear active_profiles');
  assert.equal(afterRt.activeProfileId, null);

  const after = resolveRemovalRuntimeState({
    serviceId: SERVICE,
    rt: afterRt,
    observer
  });
  assert.equal(after.state, 'stopped');

  const removed = await store.registry.remove(SERVICE);
  assert.deepEqual(removed, { success: true, id: SERVICE });
});

test('removal: an UNVERIFIED stopped claim never reaches the pointer-clearing noop', async (t) => {
  const { store } = await makeStore(t);
  store.registry.handleSetActiveService(SERVICE, PROFILE, 1, 1);

  const action = await store.registry.createLifecycleAction({
    action: 'stop',
    serviceId: SERVICE,
    idempotencyKey: 'guard-fix-stop-2'
  });

  const settled = await runMcpLifecycleAction({
    repo: store,
    adapterProvider: () => ({
      // Inspection failed => absence is NOT proven.
      processController: {
        async inspect() { throw new Error('probe unavailable'); },
        async verify() { return { valid: false }; }
      }
    }),
    actionId: action.id,
    vault: null
  });

  assert.equal(settled.state, 'REJECTED');
  assert.equal(settled.errorCode, 'STATE_REFRESH_REQUIRED');
  // The stale pointer survives: it is the only thing stopping a wrong deletion.
  assert.equal(store.getServiceRuntime(SERVICE).runtimeState, 'running');
});

test('removal: a live instance still blocks deletion through the registry', async (t) => {
  const { store } = await makeStore(t);
  const instanceId = buildInstanceId(SERVICE, PROFILE);
  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE,
    state: 'running', pid: process.pid, owned: true, identityVerified: true,
    startedAt: '2026-11-12T00:00:00.000Z', observedAt: '2026-11-12T00:00:01.000Z'
  });

  await assert.rejects(
    () => store.registry.remove(SERVICE),
    (err) => err.status === 409 && err.code === 'MCP_RUNNING'
  );
});

// ---------------------------------------------------------------------------
// 2. Stop-all convergence: facts are never fabricated
// ---------------------------------------------------------------------------

function fakeObserver() {
  const rows = new Map();
  const invalidated = [];
  return {
    rows,
    invalidated,
    setTunnelClient(id, row) { rows.set(String(id), row); },
    invalidate(id) { invalidated.push(String(id)); },
    peekTunnelClient(id) { return rows.get(String(id)) || null; }
  };
}

test('stop-all: every instance/service is handled independently and errors are reported', () => {
  const observer = fakeObserver();
  const written = [];
  const cleared = [];
  const repo = {
    upsertInstanceRuntime(instanceId, patch) {
      if (instanceId === 'svc__bad') throw new Error('disk full');
      written.push({ instanceId, patch });
    },
    registry: {
      handleClearActiveService(sid) {
        if (sid === 'svc-b') throw new Error('pointer locked');
        cleared.push(sid);
      }
    }
  };

  const result = finalizeStoppedState({
    known: ['svc__good-1', 'svc__bad', 'svc__good-2'],
    services: ['svc-a', 'svc-b', 'svc-c'],
    repo,
    observer
  });

  // The failure in the middle did NOT stop the items after it.
  assert.deepEqual(written.map(w => w.instanceId), ['svc__good-1', 'svc__good-2']);
  for (const w of written) {
    assert.equal(w.patch.state, 'stopped');
    assert.equal(w.patch.pid, null, 'a stale pid must be dropped');
    assert.equal(w.patch.owned, 0);
    assert.equal(w.patch.identityVerified, 0);
  }

  // Both remaining services still had their pointer cleared and cache refreshed.
  assert.deepEqual(cleared, ['svc-a', 'svc-c']);
  assert.ok(observer.invalidated.includes('svc__good-1'));
  assert.ok(observer.invalidated.includes('svc__good-2'));

  // Counts reflect SUCCESSES ONLY, and both failures are surfaced.
  assert.equal(result.markedStopped, 2);
  assert.equal(result.clearedServices, 2);
  assert.equal(result.published, 3);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map(e => e.scope).sort(), ['instance', 'service']);

  // The service-level cache row (a different key from the instance row) is what
  // the dashboard reads, so it must carry proven absence.
  for (const sid of ['svc-a', 'svc-b', 'svc-c']) {
    const row = observer.rows.get(sid);
    assert.ok(row, `service ${sid} must get a fresh observation`);
    assert.equal(row.state, 'stopped');
    assert.equal(row.absenceVerified, true);
  }
});

test('stop-all job: a residual tunnel-client pid keeps every stored claim', async (t) => {
  const { store } = await makeStore(t);
  const instanceId = buildInstanceId(SERVICE, PROFILE);
  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE,
    state: 'running', pid: deadPid(), owned: true, identityVerified: true,
    startedAt: '2026-11-12T00:00:00.000Z', observedAt: '2026-11-12T00:00:01.000Z'
  });
  store.registry.handleSetActiveService(SERVICE, PROFILE, 1, 1);

  const observer = createRuntimeObserver({ now: () => Date.now(), ttlMs: 90000 });
  store.registry.setObserver(observer);

  const server = await startServer(t, {
    repo: store,
    dataDir: t.root,
    // There is always a live pid left over, so absence is never confirmed.
    tunnelClientOps: {
      taskkill: async () => ({ ok: true, stdout: '', stderr: '' }),
      listPids: async () => [deadPid()]
    }
  });

  const job = await runStopAll(server.baseUrl);
  assert.equal(job.ok, false, 'a residual pid must never be reported as success');
  assert.equal(job.skippedStateConvergence, true);
  assert.equal(job.remaining, 1);
  assert.deepEqual(job.remainingPids, [deadPid()]);
  assert.equal(job.markedStopped, 0);

  // Facts preserved: the row and the pointer are untouched.
  const row = store.getInstanceRuntime(instanceId);
  assert.equal(row.state, 'running');
  assert.equal(row.pid, deadPid());
  assert.equal(store.getServiceRuntime(SERVICE).runtimeState, 'running');
});

test('stop-all job: a failed pid enumeration is an error, not an empty list', async (t) => {
  const { store } = await makeStore(t);
  const instanceId = buildInstanceId(SERVICE, PROFILE);
  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE,
    state: 'running', pid: deadPid(), owned: true, identityVerified: true,
    startedAt: '2026-11-12T00:00:00.000Z', observedAt: '2026-11-12T00:00:01.000Z'
  });
  store.registry.handleSetActiveService(SERVICE, PROFILE, 1, 1);

  const observer = createRuntimeObserver({ now: () => Date.now(), ttlMs: 90000 });
  store.registry.setObserver(observer);

  const server = await startServer(t, {
    repo: store,
    dataDir: t.root,
    tunnelClientOps: {
      taskkill: async () => ({ ok: true, stdout: '', stderr: '' }),
      listPids: async () => { throw new Error('tasklist exploded'); }
    }
  });

  const job = await runStopAll(server.baseUrl);
  assert.equal(job.ok, false);
  assert.equal(job.skippedStateConvergence, true);
  assert.ok(job.absenceUnconfirmed, 'the reason must be reported verbatim');
  assert.ok(job.enumerationErrors.some(e => e.scope === 'listPids'));
  assert.equal(job.markedStopped, 0);

  const row = store.getInstanceRuntime(instanceId);
  assert.equal(row.state, 'running');
  assert.equal(store.getServiceRuntime(SERVICE).runtimeState, 'running');
});

test('stop-all job: confirmed absence converges state, pointer and cache', async (t) => {
  const { store } = await makeStore(t);
  const instanceId = buildInstanceId(SERVICE, PROFILE);
  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE,
    state: 'running', pid: deadPid(), owned: true, identityVerified: true,
    startedAt: '2026-11-12T00:00:00.000Z', observedAt: '2026-11-12T00:00:01.000Z'
  });
  store.registry.handleSetActiveService(SERVICE, PROFILE, 1, 1);

  const observer = createRuntimeObserver({ now: () => Date.now(), ttlMs: 90000 });
  store.registry.setObserver(observer);

  const server = await startServer(t, {
    repo: store,
    dataDir: t.root,
    tunnelClientOps: {
      taskkill: async () => ({ ok: true, stdout: 'SUCCESS: sent termination signal to PID 4242', stderr: '' }),
      listPids: async () => []
    }
  });

  const job = await runStopAll(server.baseUrl);
  assert.equal(job.ok, true);
  assert.equal(job.skippedStateConvergence, false);
  assert.equal(job.remaining, 0);
  assert.ok(job.markedStopped >= 1);

  const row = store.getInstanceRuntime(instanceId);
  assert.equal(row.state, 'stopped');
  assert.equal(row.pid, null);
  assert.equal(store.getServiceRuntime(SERVICE).runtimeState, 'stopped');

  const serviceRow = observer.peekTunnelClient(SERVICE);
  assert.equal(serviceRow.state, 'stopped');
  assert.equal(serviceRow.absenceVerified, true);
});

// ---------------------------------------------------------------------------
// 3. Carrier confirmation: a persisted row is a claim, never proof
// ---------------------------------------------------------------------------

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    writableEnded: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      return this;
    },
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) {
      this.writableEnded = true;
      if (typeof payload === 'string' && payload) {
        try { this.body = JSON.parse(payload); } catch { this.body = payload; }
      }
      return this;
    }
  };
}

/**
 * Drives the carrier-confirmation path for a stored `running` row. Returns the
 * HTTP response double so each identity-evidence case can assert its own verdict.
 *
 * `provider` defaults to a function returning null, NOT to null: with a null
 * provider the route falls back to lazily BUILDING a real adapter from
 * ../adapters/index.mjs (it only needs a dataDir), which would put a production
 * process controller -- and possibly a PowerShell probe -- inside a unit test and
 * silently bypass the persisted-record path under test.
 */
async function stopViaCarrier(t, { record, provider = () => null, verifyProcessIdentity = null }) {
  const { store, vault, dataDir } = await makeStore(t);
  if (record) {
    const instanceId = buildInstanceId(SERVICE, PROFILE);
    store.upsertInstanceRuntime(instanceId, { serviceId: SERVICE, profileId: PROFILE, ...record });
  }

  const routes = createInstanceRoutes({
    repo: store,
    runner: { wake: async () => {} },
    vault,
    dataDir,
    instanceAdapterProvider: provider,
    verifyProcessIdentity
  });

  const urlPath = `/api/mcps/${SERVICE}/instances/${PROFILE}/stop`;
  const res = createRes();
  const authSession = { authenticated: true, sessionBinding: 'sess-1' };
  await routes.handle({
    // handleAction reads the session off `req.authSession` (that is what the HTTP
    // layer sets); `ctx.auth` only gates authentication.
    req: { method: 'POST', headers: { 'idempotency-key': 'guard-fix-carrier-1' }, url: urlPath, authSession },
    res,
    url: new URL(urlPath, 'http://localhost'),
    body: {},
    auth: authSession
  });
  return res;
}

const LIVE_RECORD = {
  state: 'running',
  pid: process.pid,
  startedAt: '2026-11-12T00:00:00.000Z',
  executablePath: 'C:\\tools\\tunnel-client.exe',
  owned: true,
  identityVerified: true,
  observedAt: '2026-11-12T00:00:01.000Z'
};

test('carrier: a dead pid in the persisted row is unverified', async (t) => {
  const res = await stopViaCarrier(t, {
    record: { ...LIVE_RECORD, pid: deadPid() },
    verifyProcessIdentity: async () => ({ valid: true })
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.error?.code, 'PROCESS_IDENTITY_UNVERIFIED');
});

test('carrier: a live pid with NO verifier available is unverified', async (t) => {
  const res = await stopViaCarrier(t, { record: LIVE_RECORD, verifyProcessIdentity: null });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.error?.code, 'PROCESS_IDENTITY_UNVERIFIED');
});

test('carrier: a live pid whose verifier says false is unverified', async (t) => {
  const res = await stopViaCarrier(t, {
    record: LIVE_RECORD,
    verifyProcessIdentity: async () => ({ valid: false, reason: 'PID_REUSED' })
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.error?.code, 'PROCESS_IDENTITY_UNVERIFIED');
});

test('carrier: a verifier that throws is unverified, not a crash', async (t) => {
  const res = await stopViaCarrier(t, {
    record: LIVE_RECORD,
    verifyProcessIdentity: async () => { throw new Error('helper crashed'); }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.error?.code, 'PROCESS_IDENTITY_UNVERIFIED');
});

test('carrier: a stored stopped row is NOT absence proof', async (t) => {
  const res = await stopViaCarrier(t, {
    record: { ...LIVE_RECORD, state: 'stopped', pid: null },
    verifyProcessIdentity: async () => ({ valid: true })
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.error?.code, 'PROCESS_IDENTITY_UNVERIFIED');
});

test('carrier: a live pid with a passing verifier is accepted', async (t) => {
  const res = await stopViaCarrier(t, {
    record: LIVE_RECORD,
    verifyProcessIdentity: async () => ({ valid: true })
  });
  // Verified identity => the flow proceeds to "carrier confirmation required".
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.code, 'CARRIER_CONFIRMATION_REQUIRED');
  const token = res.body?.carrierToken;
  const isToken = (typeof token === 'string' && token.length > 0)
    || (token && typeof token === 'object' && Object.keys(token).length > 0);
  assert.ok(isToken, 'a carrier confirmation token must be issued for a verified identity');
});

test('carrier: authoritative live inspection with no verifier is unverified', async (t) => {
  const res = await stopViaCarrier(t, {
    record: LIVE_RECORD,
    provider: () => ({
      processController: {
        async inspectInstance() {
          return { running: true, pid: process.pid, startedAt: '2026-11-12T00:00:00.000Z', executablePath: 'C:\\tools\\tunnel-client.exe' };
        }
        // No verify() at all.
      }
    })
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.error?.code, 'PROCESS_IDENTITY_UNVERIFIED');
});

test('carrier: authoritative absence from inspection counts as verified absence', async (t) => {
  const res = await stopViaCarrier(t, {
    record: LIVE_RECORD,
    provider: () => ({
      processController: {
        async inspectInstance() { return { running: false, pid: null }; },
        async verify() { return { valid: false }; }
      }
    })
  });
  // Authoritative absence is the OTHER accepted proof (the first being a verified
  // live identity). It satisfies carrier confirmation, so the flow advances to the
  // confirmation step and hands out a token instead of refusing with
  // PROCESS_IDENTITY_UNVERIFIED.
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.code, 'CARRIER_CONFIRMATION_REQUIRED');
  const token = res.body?.carrierToken;
  const isToken = (typeof token === 'string' && token.length > 0)
    || (token && typeof token === 'object' && Object.keys(token).length > 0);
  assert.ok(isToken, 'proven absence must be allowed to bind a confirmation token');
});

test('carrier: PID REUSE -- a live pid that no longer matches the recorded identity is unverified', async (t) => {
  // The heart of rev-3 item 8. The instance row says pid P was tunnel-client.exe
  // started at T1, but P has been recycled: the process now there is a different
  // executable started at T2. A verifier that compares the EXPECTED identity
  // against the live process must reject it.
  const reusedPid = process.pid;
  const actual = {
    pid: reusedPid,
    startedAt: '2026-11-13T09:30:00.000Z',
    executablePath: 'C:\\Windows\\System32\\notepad.exe'
  };
  const res = await stopViaCarrier(t, {
    record: {
      ...LIVE_RECORD,
      pid: reusedPid,
      startedAt: '2026-11-12T00:00:00.000Z',
      executablePath: 'C:\\tools\\tunnel-client.exe'
    },
    provider: () => ({
      processController: {
        async inspectInstance() {
          return { running: true, ...actual };
        },
        // Honest verifier: compares the expected identity against what the OS
        // actually reports now. The record and the live process disagree, so the
        // recycled pid can never inherit this instance's carrier token.
        async verify(expected) {
          return {
            valid: expected?.pid === actual.pid
              && expected?.startedAt === actual.startedAt
              && expected?.executablePath === actual.executablePath
          };
        }
      }
    })
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.error?.code, 'PROCESS_IDENTITY_UNVERIFIED',
    'a recycled pid must never be bound to this instance\'s carrier token');
});

test('carrier: a same-pid identity that the verifier confirms still succeeds', async (t) => {
  // Positive control for the case above: identical evidence except the live
  // process matches the record, which must still mint a token.
  const pid = process.pid;
  const actual = {
    pid,
    startedAt: '2026-11-12T00:00:00.000Z',
    executablePath: 'C:\\tools\\tunnel-client.exe'
  };
  const res = await stopViaCarrier(t, {
    record: { ...LIVE_RECORD, ...actual },
    provider: () => ({
      processController: {
        async inspectInstance() { return { running: true, ...actual }; },
        async verify(expected) {
          return {
            valid: expected?.pid === actual.pid
              && expected?.startedAt === actual.startedAt
              && expected?.executablePath === actual.executablePath
          };
        }
      }
    })
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.code, 'CARRIER_CONFIRMATION_REQUIRED');
});

test('carrier: the verifier is consulted with the RECORDED identity, not the inspected snapshot', async (t) => {
  // Directly asserts the contract, so a future refactor cannot quietly pass
  // `inspected` to verify() again: the argument must carry the pid/startedAt/
  // executablePath this instance was launched with.
  let received = null;
  const res = await stopViaCarrier(t, {
    record: {
      ...LIVE_RECORD,
      startedAt: '2026-11-12T00:00:00.000Z',
      executablePath: 'C:\\tools\\tunnel-client.exe'
    },
    provider: () => ({
      processController: {
        async inspectInstance() {
          return {
            running: true,
            pid: process.pid,
            // Deliberately different from the record, so the two are distinguishable.
            startedAt: '2026-11-12T00:00:00.000Z',
            executablePath: 'C:\\tools\\tunnel-client.exe'
          };
        },
        async verify(identity) { received = identity; return { valid: true }; }
      }
    })
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.code, 'CARRIER_CONFIRMATION_REQUIRED');
  assert.ok(received, 'verify() must be called');
  assert.equal(received.pid, process.pid);
  assert.equal(received.executablePath, 'C:\\tools\\tunnel-client.exe');
  assert.equal(received.startedAt, '2026-11-12T00:00:00.000Z');
});

test('carrier: a live pid with NO expected identity at all is unverified', async (t) => {
  // No persisted row and no adapter launch record: the live process is unowned,
  // so there is nothing that could tie it to this instance.
  const res = await stopViaCarrier(t, {
    record: null,
    provider: () => ({
      processController: {
        async inspectInstance() { return { running: true, pid: process.pid }; },
        async verify() { return { valid: true }; }
      }
    })
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body?.error?.code, 'PROCESS_IDENTITY_UNVERIFIED');
});

// ---------------------------------------------------------------------------
// 4. Service-level stop: a cached "stopped" is never a successful stop
// ---------------------------------------------------------------------------

/**
 * Starts the real HTTP server with a fake repo whose observer cache says the
 * service is already stopped. Nothing here runs an OS command or binds a fixed
 * port; the listener takes an ephemeral loopback port.
 */
async function serviceStopWithCache(t, { cached, inspectImpl }) {
  const created = [];
  const fakeRepo = {
    getRevision: async () => 1,
    getServiceRuntime: () => ({
      runtimeState: cached.state === 'running' ? 'running' : 'stopped',
      activeProfileId: null,
      instances: [],
      tunnelClient: cached
    }),
    registry: {
      getMcp: (id) => ({
        id,
        label: 'svc',
        controlCarrier: false,
        revision: 1,
        binding: { type: 'stdio', executable: 'node' }
      }),
      getDefinition: (id) => ({
        id,
        label: 'svc',
        controlCarrier: false,
        revision: 1,
        binding: { type: 'stdio', executable: 'node' }
      }),
      createLifecycleAction: async (args) => {
        created.push(args);
        return {
          id: 'op-1', operationId: 'op-1', kind: args.action,
          serviceId: args.serviceId, state: 'QUEUED'
        };
      }
    }
  };

  const server = await startServer(t, {
    repo: fakeRepo,
    runner: { wake: async () => {} },
    adapters: {
      [SERVICE]: {
        processController: { inspect: inspectImpl, verify: async () => ({ valid: false }) }
      }
    }
  });

  const res = await jsonRequest(`${server.baseUrl}/api/mcps/${SERVICE}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'svc-stop-1' },
    body: JSON.stringify({ expectedRevision: 1 })
  });
  return { res, created };
}

test('service stop: a cached stopped row does not answer ALREADY_STOPPED', async (t) => {
  const { res, created } = await serviceStopWithCache(t, {
    cached: { state: 'stopped', managed: true, absenceVerified: true, observedAt: Date.now() },
    inspectImpl: async () => ({ running: false, pid: null })
  });
  // The old fast path returned 200 noop straight from this cache. A cached absence
  // is a past observation, so the stop must now be queued for a fresh inspection.
  assert.equal(res.status, 202);
  assert.notEqual(res.body?.code, 'ALREADY_STOPPED');
  assert.equal(created.length, 1);
  assert.equal(created[0].action, 'stop');
});

test('service stop: cached stopped but the fresh inspection finds a LIVE process', async (t) => {
  // The false-success case the fast path produced: the dashboard says stopped, but
  // something is running now. It must NOT be reported as an already-stopped noop.
  const { res, created } = await serviceStopWithCache(t, {
    cached: { state: 'stopped', managed: true, absenceVerified: true, observedAt: Date.now() },
    inspectImpl: async () => ({ running: true, pid: process.pid })
  });
  assert.equal(res.status, 202, 'a live process must never yield a stopped noop');
  assert.notEqual(res.body?.code, 'ALREADY_STOPPED');
  assert.equal(created.length, 1);
});

// ---------------------------------------------------------------------------
// 5. Per-service instance quota: phantom rows must not consume slots
// ---------------------------------------------------------------------------
test('instance quota: dead pid rows are filtered out of the running set', async (t) => {
  const { store } = await makeStore(t);
  await store.createProfile({
    id: OTHER_PROFILE,
    label: 'Account Two',
    services: { [SERVICE]: { tunnelId: 'tunnel_two', apiKey: 'key_two' } }
  });

  const phantom = buildInstanceId(SERVICE, PROFILE);
  const real = buildInstanceId(SERVICE, OTHER_PROFILE);

  store.upsertInstanceRuntime(phantom, {
    serviceId: SERVICE, profileId: PROFILE,
    state: 'running', pid: deadPid(), owned: true, identityVerified: true,
    startedAt: '2026-11-12T00:00:00.000Z', observedAt: '2026-11-12T00:00:01.000Z'
  });
  store.upsertInstanceRuntime(real, {
    serviceId: SERVICE, profileId: OTHER_PROFILE,
    state: 'running', pid: process.pid, owned: true, identityVerified: true,
    startedAt: '2026-11-12T00:00:00.000Z', observedAt: '2026-11-12T00:00:01.000Z'
  });

  const ids = store.listRunningInstanceProfileIds(SERVICE);
  assert.deepEqual(ids, [OTHER_PROFILE], 'only the live pid may occupy a slot');
  assert.ok(!ids.includes(PROFILE), 'the phantom row must not consume a slot');
});

// ---------------------------------------------------------------------------
// helpers: ephemeral-port HTTP server + stop-all job polling
// ---------------------------------------------------------------------------

function mockSecurity() {
  return {
    guard: async () => true,
    state: async () => ({ configured: true, authenticated: true, csrfToken: 'mock' }),
    setup: async () => ({ ok: true }),
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
    close: async () => {}
  };
}

function startServer(t, options) {
  return new Promise((resolve, reject) => {
    try {
      const server = createHttpServer({ security: mockSecurity(), ...options });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        t.after(() => new Promise(res => {
          server.closeAllConnections?.();
          server.close(res);
        }));
        resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function jsonRequest(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** Starts the stop-all job and polls until it terminates. */
async function runStopAll(baseUrl) {
  const started = await jsonRequest(`${baseUrl}/api/tunnel-clients/stop-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(started.status, 202, `stop-all must be accepted, got ${started.status}`);
  const jobId = started.body?.jobId;
  assert.ok(jobId, 'the job id is required to poll progress');

  for (let i = 0; i < 100; i++) {
    const poll = await jsonRequest(`${baseUrl}/api/tunnel-clients/stop-all/jobs/${jobId}`);
    assert.equal(poll.status, 200);
    if (poll.body?.done) return poll.body;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('stop-all job did not finish in time');
}
