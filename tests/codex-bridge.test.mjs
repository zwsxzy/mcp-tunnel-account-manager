import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openStore } from '../src/store.mjs';
import { createHttpServer } from '../src/server.mjs';
import { buildSafePinnedEnv } from '../src/adapters/index.mjs';

// The Codex bridge toggle is the one feature ported from D:\MCP. It must:
//   (1) persist to the metadata table (default ON),
//   (2) be served/updated through GET/POST /api/settings/codex-bridge,
//   (3) actually strip <Roaming>\npm from the *inherited* PATH when disabled.

function createFakeVault() {
  return {
    seal: (v, aad) => ({ c: JSON.stringify(v), aad }),
    unseal: (e, aad) => {
      let env = e;
      if (typeof env === 'string') {
        try { env = JSON.parse(env); } catch {}
      }
      if (aad !== undefined && env && env.aad !== undefined && env.aad !== aad) {
        throw new Error(`AAD mismatch: expected ${aad}, got ${env.aad}`);
      }
      return typeof env?.c === 'string' ? JSON.parse(env.c) : env?.c;
    },
    close: () => {}
  };
}

function createMockSecurity() {
  return {
    guard: async () => true,
    state: async () => ({ configured: true, authenticated: true, csrfToken: 'mock-csrf' }),
    setup: async () => ({ ok: true }),
    login: async () => ({ ok: true }),
    logout: async () => ({ ok: true }),
    close: async () => {}
  };
}

function request(baseUrl, p, { method = 'GET', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: p,
      method,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ statusCode: res.statusCode, body: parsed, rawBody: raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Codex bridge toggle', () => {
  test('store default is enabled and persists toggling', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-'));
    const store = openStore({ dataDir: tmp, vault: createFakeVault() });
    try {
      assert.equal(store.getCodexBridgeEnabled(), true, 'default must be enabled');
      assert.equal(store.setCodexBridgeEnabled(false), false, 'disable returns false');
      assert.equal(store.getCodexBridgeEnabled(), false, 'persisted disable');
      assert.equal(store.setCodexBridgeEnabled(true), true, 're-enable returns true');
      assert.equal(store.getCodexBridgeEnabled(), true, 'persisted enable');
    } finally {
      try { store.close?.(); } catch {}
    }
  });

  test('GET/POST /api/settings/codex-bridge round-trips through the HTTP route', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-http-'));
    const store = openStore({ dataDir: tmp, vault: createFakeVault() });
    const server = createHttpServer({ security: createMockSecurity(), repo: store, publicDir: tmp });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
      const g1 = await request(base, '/api/settings/codex-bridge');
      assert.equal(g1.statusCode, 200);
      assert.equal(g1.body.enabled, true, 'GET default enabled');

      const p1 = await request(base, '/api/settings/codex-bridge', { method: 'POST', body: JSON.stringify({ enabled: false }) });
      assert.equal(p1.statusCode, 200);
      assert.equal(p1.body.enabled, false, 'POST disable');
      assert.equal(p1.body.restartRequired, true);

      const g2 = await request(base, '/api/settings/codex-bridge');
      assert.equal(g2.body.enabled, false, 'GET reflects disabled');

      const bad = await request(base, '/api/settings/codex-bridge', { method: 'POST', body: JSON.stringify({ enabled: 'nope' }) });
      assert.equal(bad.statusCode, 400, 'non-boolean rejected');

      const wrongMethod = await request(base, '/api/settings/codex-bridge', { method: 'PUT' });
      assert.equal(wrongMethod.statusCode, 405, 'unexpected method rejected');
    } finally {
      await new Promise((res) => { server.closeAllConnections?.(); server.close(res); });
      try { store.close?.(); } catch {}
    }
  });

  test('buildSafePinnedEnv strips Roaming\\npm from inherited PATH only when disabled', () => {
    const hadPath = Object.prototype.hasOwnProperty.call(process.env, 'PATH');
    const original = process.env.PATH;
    const sample = ['C:\\Windows', 'C:\\Program Files\\nodejs', 'C:\\Users\\x\\AppData\\Roaming\\npm'].join(path.delimiter);
    process.env.PATH = sample;
    try {
      const on = buildSafePinnedEnv({});
      const off = buildSafePinnedEnv({}, { codexBridgeEnabled: false });
      const pathKey = Object.keys(on).find((k) => k.toUpperCase() === 'PATH');
      assert.ok(pathKey, 'PATH present in pinned env');
      assert.match(on[pathKey], /Roaming[\\/]npm/i, 'enabled keeps Roaming\\npm');
      assert.doesNotMatch(off[pathKey], /Roaming[\\/]npm/i, 'disabled strips Roaming\\npm');
      assert.match(off[pathKey], /nodejs/i, 'disabled keeps other segments');
    } finally {
      if (hadPath) process.env.PATH = original; else delete process.env.PATH;
    }
  });
});
