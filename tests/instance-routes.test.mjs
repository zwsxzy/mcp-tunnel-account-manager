/**
 * HTTP route contract tests for concurrent instances (docs/analysis/concurrent-instances-contract.md §4).
 *
 * The route layer had no dedicated test: the e2e suite drives store/adapter/lifecycle
 * directly, and the smoke run only exercises start/stop/list happy paths. These cases
 * pin the rules that protect the API surface:
 *   - unknown profile        -> 404 PROFILE_NOT_FOUND
 *   - body/path mismatch     -> 400 INVALID_PROFILE
 *   - unauthenticated        -> 401 UNAUTHORIZED
 *   - wrong method           -> 405 METHOD_NOT_ALLOWED
 *   - non-instance path      -> falls through (returns false)
 *   - listing never leaks raw tunnel ids / api keys / full YAML / production paths
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';
import { createInstanceRoutes } from '../src/http/instance-routes.mjs';
import { sanitizeMcpDto, publishMcpDto } from '../src/http/mcp-routes.mjs';
import { createRuntimeObserver } from '../src/adapters/runtime-observer.mjs';

const SERVICE = 'mcp_routesvc';
const PROFILE_A = 'userA';
const RAW_TUNNEL_ID = 'tunnel_secret_aaaa1111';
const RAW_API_KEY = 'key-super-secret';

/** Minimal Express-less response double that records status + JSON body. */
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

async function createHarness(t) {
  const root = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'routes-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  await store.registry.create({ id: SERVICE, label: 'routes', enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });
  await store.createProfile({ id: PROFILE_A, label: 'Account A',
    services: { [SERVICE]: { tunnelId: RAW_TUNNEL_ID, apiKey: RAW_API_KEY } } });

  const routes = createInstanceRoutes({
    repo: store,
    runner: { wake: async () => {} },
    vault,
    dataDir
  });

  async function call(method, urlPath, { body = {}, auth = { authenticated: true } } = {}) {
    const res = createRes();
    const req = { method, headers: {}, url: urlPath };
    const handled = await routes.handle({
      req, res, url: new URL(urlPath, 'http://localhost'), body, auth
    });
    return { handled, status: res.statusCode, body: res.body };
  }

  return { store, call };
}

test('unknown profile -> 404 PROFILE_NOT_FOUND', async (t) => {
  const { call } = await createHarness(t);
  const r = await call('POST', `/api/mcps/${SERVICE}/instances/nobody/start`);
  assert.equal(r.handled, true);
  assert.equal(r.status, 404);
  assert.equal(r.body?.error?.code, 'PROFILE_NOT_FOUND');
});

test('body profileId disagreeing with the path -> 400 INVALID_PROFILE', async (t) => {
  const { call, store } = await createHarness(t);
  await store.createProfile({ id: 'userB', label: 'B',
    services: { [SERVICE]: { tunnelId: 't_b', apiKey: 'k_b' } } });

  const r = await call('POST', `/api/mcps/${SERVICE}/instances/${PROFILE_A}/start`, {
    body: { profileId: 'userB' }
  });
  assert.equal(r.status, 400);
  assert.equal(r.body?.error?.code, 'INVALID_PROFILE');
});

test('unauthenticated request -> 401 UNAUTHORIZED', async (t) => {
  const { call } = await createHarness(t);
  const r = await call('POST', `/api/mcps/${SERVICE}/instances/${PROFILE_A}/start`,
    { auth: { authenticated: false } });
  assert.equal(r.status, 401);
  assert.equal(r.body?.error?.code, 'UNAUTHORIZED');
});

test('wrong method on an instance path -> 405 METHOD_NOT_ALLOWED', async (t) => {
  const { call } = await createHarness(t);
  const r = await call('DELETE', `/api/mcps/${SERVICE}/instances/${PROFILE_A}/start`);
  assert.equal(r.status, 405);
  assert.equal(r.body?.error?.code, 'METHOD_NOT_ALLOWED');
});

test('a non-instance path falls through instead of being captured', async (t) => {
  const { call } = await createHarness(t);
  const r = await call('GET', `/api/mcps/${SERVICE}`);
  assert.equal(r.handled, false, 'legacy MCP routes must keep receiving this path');
});

test('listing never leaks raw tunnel ids, api keys, full YAML or production paths', async (t) => {
  const { call, store } = await createHarness(t);
  const instanceId = `${SERVICE}__${PROFILE_A}`;
  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE_A, state: 'running', pid: 4321,
    startedAt: '2026-11-10T00:00:00.000Z',
    executablePath: 'C:\\Users\\zws\\AppData\\Roaming\\tunnel-client\\secret.yaml',
    healthURL: 'http://127.0.0.1:5555', localPort: 5555,
    profileYamlPath: 'C:\\Users\\zws\\AppData\\Roaming\\tunnel-client\\secret.yaml',
    owned: true, identityVerified: true, observedAt: '2026-11-10T00:00:01.000Z'
  });

  const r = await call('GET', `/api/mcps/${SERVICE}/instances`);
  assert.equal(r.status, 200);
  assert.equal(r.body?.serviceId, SERVICE);
  assert.ok(Array.isArray(r.body?.instances) && r.body.instances.length === 1);

  const serialized = JSON.stringify(r.body);
  assert.ok(!serialized.includes(RAW_TUNNEL_ID), 'raw tunnel id must never be returned');
  assert.ok(!serialized.includes(RAW_API_KEY), 'raw api key must never be returned');
  assert.ok(!/profileYamlPath/.test(serialized), 'full YAML path must not be exposed by the list DTO');
  assert.ok(!serialized.includes('tunnel-client\\secret.yaml'), 'production profile path must not leak');
});

test('a listed row still exposes usable state + ownership for the UI', async (t) => {
  const { call, store } = await createHarness(t);
  const instanceId = `${SERVICE}__${PROFILE_A}`;
  // A LIVE pid: the liveness reconciliation only preserves a `running` claim whose
  // process exists, so seeding a made-up number would make this contract test
  // depend on the host pid table (and fail whenever that pid happened to be free).
  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE_A, state: 'running', pid: process.pid,
    startedAt: new Date().toISOString(), executablePath: 'C:\\fake\\tunnel-client.exe',
    healthURL: 'http://127.0.0.1:5556', localPort: 5556,
    owned: true, identityVerified: true, observedAt: new Date().toISOString()
  });

  const r = await call('GET', `/api/mcps/${SERVICE}/instances`);
  const row = r.body.instances[0];
  assert.equal(row.instanceId, instanceId);
  assert.equal(row.state, 'running');
  assert.equal(row.pid, process.pid);
  assert.equal(row.owned, true, 'route must not strip the ownership evidence');
  assert.equal(row.identityVerified, true);
});

test('a listed row whose process is gone is published as stopped, not running', async (t) => {
  const { call, store } = await createHarness(t);
  const instanceId = `${SERVICE}__${PROFILE_A}`;
  // Regression: a `running` row outlives its process after a crash or an external
  // kill. Publishing it verbatim made the console render a phantom running
  // instance and made "parallel start" skip an account that was actually down.
  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE_A, state: 'running', pid: 999999,
    startedAt: '2026-11-10T00:00:00.000Z', executablePath: 'C:\\fake\\tunnel-client.exe',
    owned: true, identityVerified: true, observedAt: '2026-11-10T00:00:01.000Z'
  });

  const r = await call('GET', `/api/mcps/${SERVICE}/instances`);
  const row = r.body.instances[0];
  assert.equal(row.state, 'stopped');
  assert.equal(row.pid, null);
  assert.equal(row.owned, false);
  assert.equal(row.managed, false, 'a downgraded row must not still claim management');
  assert.equal(row.identityVerified, false);
  assert.equal(row.reasonCode, 'process_not_found');
});
// ---------------------------------------------------------------------------
// Contract §4: "each MCP DTO in repo.registry.listServices() gains
// runtime.instances". The console renders rows from `mcp.runtime.instances`
// (public/app.js getMcpInstances), so this additive field is the ONLY way the UI
// can ever show a row. It used to be dropped by formatRuntime(), leaving the
// instance panel permanently empty while instance_runtime held the data.
// ---------------------------------------------------------------------------

test('registry DTO carries runtime.instances so the console can render rows', async (t) => {
  const { store } = await createHarness(t);
  const instanceId = `${SERVICE}__${PROFILE_A}`;

  // Before any instance exists the field must still be an array (never undefined),
  // so the UI can iterate unconditionally.
  const emptySvc = store.registry.listServices().find(s => s.id === SERVICE);
  assert.ok(Array.isArray(emptySvc.runtime.instances), 'runtime.instances must always be an array');
  assert.equal(emptySvc.runtime.instances.length, 0);

  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE_A, state: 'running', pid: process.pid,
    startedAt: new Date().toISOString(), executablePath: 'C:\fake\tunnel-client.exe',
    healthURL: 'http://127.0.0.1:5900', localPort: 5900,
    owned: true, identityVerified: true, observedAt: new Date().toISOString()
  });

  const svc = store.registry.listServices().find(s => s.id === SERVICE);
  assert.ok(Array.isArray(svc.runtime.instances), 'runtime.instances must be an array');
  assert.equal(svc.runtime.instances.length, 1, 'the instance row must reach the registry DTO');

  const row = svc.runtime.instances[0];
  assert.equal(row.instanceId, instanceId);
  assert.equal(row.state, 'running');
  assert.equal(row.pid, process.pid);
  assert.equal(row.owned, true, 'ownership must survive the DTO hop');
  assert.equal(row.identityVerified, true);

  // The console's own reader must see it too.
  const uiRows = svc.runtime.instances;
  assert.equal(uiRows.length, 1, 'getMcpInstances() equivalent must yield a row');
});

// ---------------------------------------------------------------------------
// GET /api/mcps is the response the console PREFERS (public/app.js reads
// mcpsData.mcps before stateData.mcps). Every service passes through
// sanitizeMcpDto(), which REBUILDS result.runtime field by field — so forwarding
// `instances` in the store was not enough; the HTTP sanitizer dropped it again and
// the panel stayed empty.
// ---------------------------------------------------------------------------

test('sanitizeMcpDto forwards runtime.instances (GET /api/mcps is what the console reads)', async (t) => {
  const { store } = await createHarness(t);
  const instanceId = `${SERVICE}__${PROFILE_A}`;

  const rawNoRows = store.registry.listServices().find(s => s.id === SERVICE);
  const safeNoRows = sanitizeMcpDto(rawNoRows);
  assert.ok(Array.isArray(safeNoRows.runtime.instances), 'instances must always be an array');
  assert.equal(safeNoRows.runtime.instances.length, 0);

  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE_A, state: 'running', pid: 4500,
    startedAt: '2026-11-10T00:00:00.000Z', executablePath: 'C:\fake\tunnel-client.exe',
    healthURL: 'http://127.0.0.1:5950', localPort: 5950,
    owned: true, identityVerified: true, observedAt: '2026-11-10T00:00:01.000Z'
  });

  const raw = store.registry.listServices().find(s => s.id === SERVICE);
  const safe = sanitizeMcpDto(raw);
  assert.equal(safe.runtime.instances.length, 1, 'the row must survive the HTTP sanitizer');
  const row = safe.runtime.instances[0];
  assert.equal(row.instanceId, instanceId);
  assert.equal(row.state, 'running');
  assert.equal(row.pid, 4500);
  assert.equal(row.owned, true);
  assert.equal(row.identityVerified, true);
});

test('sanitizeMcpDto redacts secrets that a row might carry', async (t) => {
  const { store } = await createHarness(t);
  const instanceId = `${SERVICE}__${PROFILE_A}`;
  const PROD_YAML = 'C:\Users\zws\AppData\Roaming\tunnel-client\secret.yaml';

  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE_A, state: 'running', pid: 4501,
    startedAt: '2026-11-10T00:00:00.000Z', executablePath: PROD_YAML,
    healthURL: 'http://127.0.0.1:5951', localPort: 5951,
    profileYamlPath: PROD_YAML,
    owned: true, identityVerified: true, observedAt: '2026-11-10T00:00:01.000Z'
  });

  const raw = store.registry.listServices().find(s => s.id === SERVICE);
  // Simulate an over-sharing store: secrets bolted straight onto the row.
  raw.runtime.instances = [{
    ...raw.runtime.instances[0],
    yaml: 'control_plane:\n  api_key: "LEAK_ME"\n',
    tunnelId: RAW_TUNNEL_ID,
    apiKey: RAW_API_KEY,
    credential: { tunnelId: RAW_TUNNEL_ID, apiKey: RAW_API_KEY }
  }];

  const safe = sanitizeMcpDto(raw);
  const serialized = JSON.stringify(safe);
  assert.ok(!serialized.includes(RAW_TUNNEL_ID), 'raw tunnel id must not cross the boundary');
  assert.ok(!serialized.includes(RAW_API_KEY), 'raw api key must not cross the boundary');
  assert.ok(!serialized.includes('control_plane:'), 'YAML must not cross the boundary');
  assert.ok(!serialized.includes('Roaming'), 'production absolute path must not cross the boundary');

  const row = safe.runtime.instances[0];
  for (const forbidden of ['profileYamlPath', 'executablePath', 'yaml', 'tunnelId', 'apiKey', 'credential']) {
    assert.ok(!(forbidden in row), `${forbidden} must not be exposed by the instance DTO`);
  }
});

// ---------------------------------------------------------------------------
// Wiring: the reconciliation must be reachable through the real handlers, not
// only as a helper. Both cases below fail if the overlay lets a placeholder win
// (live process reported stopped) or if the funnel is dropped from a route.
// ---------------------------------------------------------------------------

test('a LIVE instance survives the observer overlay (no fabricated "stopped")', async (t) => {
  const { call, store } = await createHarness(t);
  const instanceId = `${SERVICE}__${PROFILE_A}`;

  // The store harness has no observer by default, and overlayObserver returns the
  // stored rows untouched without one — a test that skips this injection would pass
  // no matter what peekTunnelClient fabricates. Inject the real observer.
  const observer = createRuntimeObserver({ ttlMs: 90000 });
  const original = store.registry.getObserver;
  store.registry.getObserver = () => observer;
  t.after(() => { store.registry.getObserver = original; try { observer.close(); } catch (_) {} });

  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE_A, state: 'running', pid: process.pid,
    startedAt: new Date().toISOString(), executablePath: 'C:\\fake\\tunnel-client.exe',
    owned: true, identityVerified: true, observedAt: new Date().toISOString()
  });

  // The observer has never probed this instance. Its "nothing cached" placeholder
  // carries observedAt = now, so a naive overlay always outranks the stored row and
  // reports a genuinely running tunnel as stopped.
  const r = await call('GET', `/api/mcps/${SERVICE}/instances`);
  const row = r.body.instances[0];
  assert.equal(row.state, 'running', 'a cache miss must not fabricate a stopped observation');
  assert.equal(row.pid, process.pid);

  // An EXPIRED cached `running` is equally not evidence.
  observer.setTunnelClient(instanceId, {
    state: 'running', managed: true, pid: process.pid,
    startedAt: new Date().toISOString(), profileId: PROFILE_A, operationId: null,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    reasonCode: 'process_verified_running', lastExitCode: null
  });
  const expired = await call('GET', `/api/mcps/${SERVICE}/instances`);
  assert.notEqual(expired.body.instances[0].reasonCode, 'process_verified_running',
    'an expired observation must not be served as current evidence');
});

test('publishMcpDto is the funnel: dead pid downgraded, live pid preserved, input untouched', async (t) => {
  const { store } = await createHarness(t);
  const instanceId = `${SERVICE}__${PROFILE_A}`;
  store.upsertInstanceRuntime(instanceId, {
    serviceId: SERVICE, profileId: PROFILE_A, state: 'running', pid: 999999,
    startedAt: '2026-11-10T00:00:00.000Z', executablePath: 'C:\\fake\\tunnel-client.exe',
    owned: true, identityVerified: true, observedAt: '2026-11-10T00:00:01.000Z'
  });

  const raw = store.registry.listServices().find(s => s.id === SERVICE);
  const rawStateBefore = raw.runtime.instances[0].state;
  const published = publishMcpDto(raw);

  assert.equal(published.runtime.instances[0].state, 'stopped');
  assert.equal(published.runtime.instances[0].reasonCode, 'process_not_found');
  assert.equal(published.runtime.state, 'stopped', 'a payload must not claim running next to stopped rows');
  assert.equal(raw.runtime.instances[0].state, rawStateBefore, 'the provider record must not be mutated');

  // The same funnel preserves a live claim.
  store.upsertInstanceRuntime(instanceId, { state: 'running', pid: process.pid, startedAt: new Date().toISOString() });
  const liveRaw = store.registry.listServices().find(s => s.id === SERVICE);
  assert.equal(publishMcpDto(liveRaw).runtime.instances[0].state, 'running');
});
