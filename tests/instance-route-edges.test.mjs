/**
 * Route-matching and path-traversal boundaries for /api/mcps/:id/instances (contract §4).
 *
 * Matching looks right on inspection; these cases pin the security-relevant edges so a
 * later refactor cannot silently widen them:
 *   - legacy MCP / state paths must NOT be captured by the instance routes
 *   - malformed percent-encoding -> invalidTarget (never a throw)
 *   - stray /instances/... shapes are answered HERE (client error), never leaked onward
 *   - traversal attempts cannot become filesystem paths
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../src/store.mjs';
import { createVault } from '../src/vault.mjs';
import { createInstanceRoutes, matchInstanceRoute } from '../src/http/instance-routes.mjs';
import { sanitizeProfileSegment, profileYamlFileName, buildInstanceId } from '../src/core/concurrent-instances.mjs';

const SERVICE = 'mcp_edgesvc';
const TRAVERSALS = ['../../etc', '..\\..\\windows', 'a/../../b', 'C:\\Windows\\temp', '....//....'];

function createRes() {
  return {
    statusCode: 200, headers: {}, body: null, writableEnded: false,
    writeHead(s, h = {}) { this.statusCode = s; Object.assign(this.headers, h); return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end(p) {
      this.writableEnded = true;
      if (typeof p === 'string' && p) { try { this.body = JSON.parse(p); } catch { this.body = p; } }
      return this;
    }
  };
}

// ---------------------------------------------------------------------------
// Matcher boundaries
// ---------------------------------------------------------------------------

test('legacy MCP and state paths are not captured by the instance routes', () => {
  const legacy = [
    ['/api/mcps/mcp_a/start', 'POST'],
    ['/api/mcps/mcp_a/stop', 'POST'],
    ['/api/mcps/mcp_a', 'GET'],
    ['/api/mcps', 'GET'],
    ['/api/state', 'GET']
  ];
  for (const [p, m] of legacy) {
    assert.equal(matchInstanceRoute(p, m), null, `${m} ${p} must fall through to the legacy handlers`);
  }
});

test('malformed percent-encoding yields invalidTarget instead of throwing', () => {
  const r = matchInstanceRoute('/api/mcps/mcp_a/instances/%E0%A4%A/start', 'POST');
  assert.equal(r?.route, 'invalidTarget');
});

test('a service id containing a slash does not match', () => {
  assert.equal(matchInstanceRoute('/api/mcps/a/b/instances', 'GET'), null);
});

test('trailing slash normalizes to the same list route', () => {
  assert.equal(matchInstanceRoute('/api/mcps/mcp_a/instances/', 'GET')?.route, 'listInstances');
  assert.equal(matchInstanceRoute('/api/mcps/mcp_a/instances', 'GET')?.route, 'listInstances');
});

test('stray /instances/... shapes are answered locally, never leaked to legacy handlers', () => {
  // Deliberate: a bogus sub-action must produce a client error here rather than
  // falling through to the legacy MCP handler with an unexpected path.
  const r = matchInstanceRoute('/api/mcps/mcp_a/instances/userA/delete', 'POST');
  assert.ok(r !== null, 'must not fall through');
  assert.equal(r.route, 'methodNotAllowed');
});

test('wrong methods map to methodNotAllowed rather than a silent fall-through', () => {
  assert.equal(matchInstanceRoute('/api/mcps/mcp_a/instances', 'DELETE')?.route, 'methodNotAllowed');
  assert.equal(matchInstanceRoute('/api/mcps/mcp_a/instances/userA/start', 'PUT')?.route, 'methodNotAllowed');
});

test('empty and root paths are ignored', () => {
  for (const p of ['/', '', null]) {
    assert.equal(matchInstanceRoute(p, 'GET'), null);
  }
});

// ---------------------------------------------------------------------------
// Traversal cannot become a filesystem path
// ---------------------------------------------------------------------------

test('sanitizer removes every path separator from traversal attempts', () => {
  for (const v of TRAVERSALS) {
    const seg = sanitizeProfileSegment(v);
    assert.ok(!seg.includes('/'), `${v} -> ${seg} must not contain /`);
    assert.ok(!seg.includes('\\'), `${v} -> ${seg} must not contain \\`);
  }
});

test('every resolved profile path stays inside the profile directory', () => {
  const profileDir = path.resolve('C:\\fake\\data', 'instances', 'profiles');
  for (const v of TRAVERSALS) {
    let name;
    try {
      name = profileYamlFileName(SERVICE, v);
    } catch (err) {
      assert.equal(err.code, 'INVALID_PROFILE', 'rejection must be a typed fault');
      continue;
    }
    const full = path.resolve(profileDir, name);
    assert.ok(
      full.toLowerCase().startsWith(profileDir.toLowerCase() + path.sep),
      `${v} -> ${full} escaped ${profileDir}`
    );
  }
});

test('instanceIds derived from traversal input contain no path separators', () => {
  for (const v of TRAVERSALS) {
    let id;
    try { id = buildInstanceId(SERVICE, v); } catch { continue; }
    assert.ok(!id.includes('/') && !id.includes('\\'), `${v} -> ${id}`);
  }
});

// ---------------------------------------------------------------------------
// Handler rejects traversal profile ids and writes nothing outside dataDir
// ---------------------------------------------------------------------------

test('handler rejects traversal profile ids and writes nothing outside the data directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trav-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const vault = createVault({ dataDir });
  const store = openStore({ dataDir, vault });
  t.after(() => {
    try { store.close(); } catch (_) {}
    try { vault.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  await store.registry.create({ id: SERVICE, label: 'edge', enabled: true,
    binding: { type: 'stdio', executable: 'node', args: [] } });

  const routes = createInstanceRoutes({ repo: store, runner: { wake: async () => {} }, vault, dataDir });

  for (const evil of TRAVERSALS) {
    const res = createRes();
    const urlPath = `/api/mcps/${SERVICE}/instances/${encodeURIComponent(evil)}/start`;
    const handled = await routes.handle({
      req: { method: 'POST', headers: {}, url: urlPath },
      res,
      url: new URL(urlPath, 'http://localhost'),
      body: {},
      auth: { authenticated: true }
    });
    assert.equal(handled, true, 'must be handled (never fall through)');
    assert.ok(res.statusCode >= 400 && res.statusCode < 500,
      `${evil} must be a client error, got ${res.statusCode}`);
  }

  // Nothing may be written outside the data directory.
  const outside = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (!f.toLowerCase().startsWith(dataDir.toLowerCase())) outside.push(f);
    }
  })(root);
  assert.deepEqual(outside, [], 'no file may be created outside the data directory');
});
