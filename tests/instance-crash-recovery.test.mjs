/**
 * Crash recovery (contract §4 lifecycle).
 *
 * A manager restart can leave an action non-terminal but non-QUEUED (e.g. APPLYING)
 * with UNKNOWN side effects. The lifecycle must NOT resume it — re-running could launch
 * a second tunnel for the same account or stop the wrong process. It must mark the action
 * for human attention and stop.
 *
 * These cases pin that behaviour, plus the two ways it could go wrong: refusing to
 * recover a genuinely QUEUED action (paralyses normal work), or touching an already
 * terminal one (breaks immutability).
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

const SERVICE = 'mcp_crashsvc';

const PROBE = {
  isDefault: false,
  async checkReady() { return true; },
  async verify(a) { return { ok: true, verified: true, identity: a.identity, proof: { kind: 'authenticated-control-plane' } }; },
  async probe() { return { live: true, ready: true }; }
};

/** Real daemons so launches are countable and pids are genuine. */
function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-'));
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
  let launches = 0;

  const runtimeCommand = async (action, params = {}) => {
    if (action === 'Launch') {
      launches += 1;
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
  const provider = createInstanceAdapterProvider({
    dataDir, vault, probe: PROBE, paths, runtimeCommand
  });

  t.after(() => {
    for (const c of children) { try { c.kill(); } catch (_) {} }
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  return { store, vault, provider, launches: () => launches, root };
}

async function seed(store) {
  await store.registry.create({ id: SERVICE, label: 'crash', enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });
  for (const p of ['acctA', 'acctB']) {
    await store.createProfile({ id: p, label: p,
      services: { [SERVICE]: { tunnelId: `t_${p}`, apiKey: `k_${p}` } } });
  }
}

const stateOf = (a) => a?.state || a?.status;
const codeOf = (a) => a?.errorCode || a?.error_code || null;

test('a crashed mid-flight action is marked NEEDS_ATTENTION/INTERRUPTED and NOT resumed', async (t) => {
  const ws = createWorkspace(t);
  await seed(ws.store);

  const act = await ws.store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctA',
    instanceId: buildInstanceId(SERVICE, 'acctA')
  });
  await ws.store.registry.transitionAction(act.id, { state: 'APPLYING' });

  const before = ws.launches();
  await runInstanceLifecycleAction({ repo: ws.store, adapterProvider: ws.provider, actionId: act.id, vault: ws.vault });
  const after = await ws.store.loadAction(act.id);

  assert.equal(stateOf(after), 'NEEDS_ATTENTION', 'uncertain side effects must stop for a human');
  assert.equal(codeOf(after), 'INTERRUPTED');
  assert.equal(ws.launches(), before, 'recovery must not launch a duplicate process');
});

test('a terminal action is left untouched and never re-marked', async (t) => {
  const ws = createWorkspace(t);
  await seed(ws.store);

  const act = await ws.store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctA',
    instanceId: buildInstanceId(SERVICE, 'acctA')
  });
  await ws.store.registry.transitionAction(act.id, { state: 'SUCCEEDED' });

  const before = ws.launches();
  await runInstanceLifecycleAction({ repo: ws.store, adapterProvider: ws.provider, actionId: act.id, vault: ws.vault });
  const after = await ws.store.loadAction(act.id);

  assert.equal(stateOf(after), 'SUCCEEDED', 'terminal actions are immutable');
  assert.equal(ws.launches(), before);
});

test('a genuinely QUEUED action still executes (recovery must not over-trigger)', async (t) => {
  const ws = createWorkspace(t);
  await seed(ws.store);

  const act = await ws.store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctA',
    instanceId: buildInstanceId(SERVICE, 'acctA')
  });

  const before = ws.launches();
  await runInstanceLifecycleAction({ repo: ws.store, adapterProvider: ws.provider, actionId: act.id, vault: ws.vault });
  const after = await ws.store.loadAction(act.id);

  assert.equal(stateOf(after), 'SUCCEEDED', `queued work must run (got ${stateOf(after)}/${codeOf(after)})`);
  assert.equal(ws.launches(), before + 1, 'exactly one process');
});

test('after recovery the gate blocks ONLY the instance that failed, never its siblings', async (t) => {
  const ws = createWorkspace(t);
  await seed(ws.store);

  const act = await ws.store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctA',
    instanceId: buildInstanceId(SERVICE, 'acctA')
  });
  await ws.store.registry.transitionAction(act.id, { state: 'APPLYING' });
  await runInstanceLifecycleAction({ repo: ws.store, adapterProvider: ws.provider, actionId: act.id, vault: ws.vault });

  // The failed account stays blocked: its side effects are unknown, so re-running
  // it could launch a second tunnel or stop the wrong process.
  await assert.rejects(
    () => ws.store.registry.createLifecycleAction({
      action: 'start', serviceId: SERVICE, profileId: 'acctA',
      instanceId: buildInstanceId(SERVICE, 'acctA')
    }),
    (err) => err.code === 'RECOVERY_GATED',
    'the instance that failed must stay gated'
  );

  // A sibling account must remain runnable. This is the whole point of concurrent
  // instances: one account needing attention is not evidence that the others do.
  // It used to be refused with RECOVERY_GATED because the gate was one global flag.
  const sibling = await ws.store.registry.createLifecycleAction({
    action: 'start', serviceId: SERVICE, profileId: 'acctB',
    instanceId: buildInstanceId(SERVICE, 'acctB')
  });
  assert.ok(sibling?.id, 'a sibling instance must still be able to queue work');
  assert.notEqual(sibling.id, act.id);
});

