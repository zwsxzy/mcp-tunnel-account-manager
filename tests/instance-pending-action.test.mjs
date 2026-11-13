/**
 * Contract §2.3 names `getActiveActionForService(serviceId, excludeActionId)` with
 * "instance awareness". That symbol is never defined in this codebase — the instance
 * path implements the rule in `findPendingOperationId()`. So the clause is judged by
 * BEHAVIOUR, which is what these tests pin:
 *
 *   - a pending action for a DIFFERENT instance must NOT hold this instance back;
 *   - a pending action for the SAME instance must block (BUSY at enqueue, or
 *     OPERATION_IN_PROGRESS at execution);
 *   - a pending LEGACY whole-service action still blocks everything for the service.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';
import { createInstanceAdapterProvider } from '../src/adapters/instance-adapter.mjs';
import { runInstanceLifecycleAction } from '../src/core/instance-lifecycle.mjs';
import { buildInstanceId } from '../src/core/concurrent-instances.mjs';

const SERVICE = 'mcp_pendingsvc';

const PROBE = {
  isDefault: false,
  async checkReady() { return true; },
  async verify(a) { return { ok: true, verified: true, identity: a.identity, proof: { kind: 'authenticated-control-plane' } }; },
  async probe() { return { live: true, ready: true }; }
};

/** Workspace with real fake-daemons so ownership/identity checks behave for real. */
function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
  const dataDir = path.join(root, 'data');
  const tunnelHome = path.join(root, 'th');
  const appData = path.join(root, 'ad');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tunnelHome, { recursive: true });
  fs.mkdirSync(path.join(appData, 'tunnel-client'), { recursive: true });
  const bin = path.join(tunnelHome, 'tunnel-client.exe');
  fs.writeFileSync(bin, 'fake', 'utf8');
  const paths = { userProfile: root, appData, tunnelHome, tunnelClientBin: bin };

  const daemonPath = path.join(root, 'd.mjs');
  fs.writeFileSync(daemonPath, `
import http from 'node:http'; import fs from 'node:fs';
const a = process.argv.slice(2); const pf = a[a.indexOf('--port-file') + 1];
const s = http.createServer((q, r) => { r.writeHead(200); r.end('ok'); });
s.listen(0, '127.0.0.1', () => fs.writeFileSync(pf, String(s.address().port)));
setInterval(() => {}, 1 << 30);
`, 'utf8');

  const alive = new Map();
  const children = new Set();
  let seq = 0;

  const runtimeCommand = async (action, params = {}) => {
    if (action === 'Launch') {
      seq += 1;
      const pf = path.join(root, `p${seq}.port`);
      const child = spawn(process.execPath, [daemonPath, '--port-file', pf], { stdio: 'ignore', windowsHide: true });
      children.add(child);
      child.on('exit', () => children.delete(child));
      let port = null;
      const dl = Date.now() + 25000;
      while (Date.now() < dl) {
        try { const n = parseInt(fs.readFileSync(pf, 'utf8'), 10); if (n > 0) { port = n; break; } } catch {}
        await new Promise(r => setTimeout(r, 20));
      }
      const args = [...(params.Arguments || []), ...(params.args || [])].map(String);
      const i = args.indexOf('--health.url-file');
      if (i >= 0) {
        fs.mkdirSync(path.dirname(args[i + 1]), { recursive: true });
        fs.writeFileSync(args[i + 1], `http://127.0.0.1:${port}\n`, 'utf8');
      }
      const ft = String(BigInt(Date.now()) * 10n + BigInt(seq));
      alive.set(child.pid, { pid: child.pid, exe: process.execPath, ft, port });
      return { code: 0, success: true, processId: child.pid, executablePath: process.execPath,
        creationDate: new Date().toISOString(), creationTimeFileTime: ft, localPort: port };
    }
    const rec = alive.get(Number(params.ProcessId));
    if (action === 'Inspect') {
      return rec
        ? { code: 0, running: true, processId: rec.pid, executablePath: rec.exe,
            creationTimeFileTime: rec.ft, creationDate: new Date().toISOString(), localPort: rec.port }
        : { code: 0, running: false };
    }
    if (action === 'Verify') {
      return { code: 0, valid: Boolean(rec)
        && String(params.ExpectedExecutablePath) === String(rec.exe)
        && String(params.ExpectedCreationTimeFileTime) === String(rec.ft) };
    }
    if (action === 'Stop') { if (rec) alive.delete(rec.pid); return { code: 0, stopped: true }; }
    if (action === 'FindOwned') return { code: 0, running: false };
    return { code: 0 };
  };

  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });

  t.after(() => {
    for (const c of children) { try { c.kill(); } catch (_) {} }
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  return { store, vault, dataDir, paths, runtimeCommand };
}

async function seed(store) {
  await store.registry.create({ id: SERVICE, label: 'pending', enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });
  for (const p of ['acctA', 'acctB', 'acctC']) {
    await store.createProfile({ id: p, label: p,
      services: { [SERVICE]: { tunnelId: `t_${p}`, apiKey: `k_${p}` } } });
  }
}

/**
 * Queueing the same instance twice is a DESIGNED 409 BUSY. Capture it as a value so a
 * legitimate refusal never masquerades as a test crash.
 */
async function queueTolerant(store, action, profileId) {
  try {
    const a = await store.registry.createLifecycleAction({
      action, serviceId: SERVICE, profileId, instanceId: buildInstanceId(SERVICE, profileId)
    });
    return { queued: true, id: a?.id ?? null };
  } catch (err) {
    return { queued: false, code: err?.code ?? 'ERROR', status: err?.statusCode ?? null };
  }
}

test('a pending action for a DIFFERENT instance does not hold this instance back', async (t) => {
  const ws = createWorkspace(t);
  await seed(ws.store);

  // Leave acctA queued but NOT executed.
  const a = await queueTolerant(ws.store, 'start', 'acctA');
  assert.equal(a.queued, true, 'acctA should queue');
  assert.equal((await ws.store.loadAction(a.id))?.state, 'QUEUED');

  const provider = createInstanceAdapterProvider({
    dataDir: ws.dataDir, vault: ws.vault, probe: PROBE, paths: ws.paths, runtimeCommand: ws.runtimeCommand
  });

  const bAction = await ws.store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctB', instanceId: buildInstanceId(SERVICE, 'acctB')
  });
  await runInstanceLifecycleAction({ repo: ws.store, adapterProvider: provider, actionId: bAction.id, vault: ws.vault });

  const bAfter = await ws.store.loadAction(bAction.id);
  assert.equal(bAfter?.state, 'SUCCEEDED',
    `acctB must proceed while acctA is merely queued (got ${bAfter?.state}/${bAfter?.errorCode})`);

  // The unrelated queued action must be untouched.
  assert.equal((await ws.store.loadAction(a.id))?.state, 'QUEUED');
});

test('a second action on the SAME instance is refused at enqueue (409 BUSY)', async (t) => {
  const ws = createWorkspace(t);
  await seed(ws.store);

  const first = await queueTolerant(ws.store, 'start', 'acctA');
  assert.equal(first.queued, true);

  const second = await queueTolerant(ws.store, 'stop', 'acctA');
  assert.equal(second.queued, false, 'the same instance must not have two concurrent actions');
  assert.ok(second.code === 'BUSY' || second.status === 409, `expected BUSY/409, got ${second.code}/${second.status}`);
});

test('a pending LEGACY whole-service action still conflicts with instance actions', async (t) => {
  const ws = createWorkspace(t);
  await seed(ws.store);

  await ws.store.registry.createLifecycleAction({ action: 'stop', serviceId: SERVICE, profileId: null });

  const blocked = await queueTolerant(ws.store, 'start', 'acctA');
  assert.equal(blocked.queued, false, 'legacy whole-service actions retain global conflict semantics');
  assert.ok(blocked.code === 'BUSY' || blocked.status === 409);
});

test('two different instances can each hold a pending action simultaneously', async (t) => {
  const ws = createWorkspace(t);
  await seed(ws.store);

  const a = await queueTolerant(ws.store, 'start', 'acctA');
  const b = await queueTolerant(ws.store, 'start', 'acctB');
  const c = await queueTolerant(ws.store, 'start', 'acctC');

  assert.equal(a.queued, true);
  assert.equal(b.queued, true);
  assert.equal(c.queued, true);
  assert.equal(new Set([a.id, b.id, c.id]).size, 3, 'three distinct pending actions');
});
