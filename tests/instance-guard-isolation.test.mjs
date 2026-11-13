/**
 * Regression tests for the production guard `assertIsolatedInstanceDataDir()`.
 *
 * The guard used to normalise with `path.resolve()` only, which is LEXICAL: it
 * knowss nothing about the filesystem. Three real bypasses were reproduced
 * against that version, and each one had a material consequence — instance
 * profiles, `*-process.json`, `*-intent.json` and `*-health.url` files would
 * have been written INSIDE the production data directory (or inside
 * `%APPDATA%\tunnel-client`):
 *
 *   1. a SUBDIRECTORY of the production data dir was accepted, because that
 *      branch compared with `===` and had no descendant test (the sibling
 *      `%APPDATA%` branch did have one — the asymmetry was the bug);
 *   2. an 8.3 short name (`MCPTUN~1`) resolved to production but compared as a
 *      different string;
 *   3. a directory junction pointing at production compared as its own path.
 *
 * These tests are HERMETIC: they point LOCALAPPDATA/APPDATA at a temporary
 * sandbox and build the "production" directories there, so the real production
 * paths are never involved, never inspected and never written through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { assertIsolatedInstanceDataDir, realResolve } from '../src/adapters/instance-adapter.mjs';

/** Builds a throwaway LOCALAPPDATA/APPDATA pair containing fake production dirs. */
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardisolationtest-'));
  const local = path.join(root, 'Local');
  const roaming = path.join(root, 'Roaming');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(roaming, { recursive: true });

  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA };
  process.env.LOCALAPPDATA = local;
  process.env.APPDATA = roaming;

  const prodData = path.join(local, 'McpTunnelAccountManager');
  const prodProfiles = path.join(roaming, 'tunnel-client');
  fs.mkdirSync(prodData, { recursive: true });
  fs.mkdirSync(prodProfiles, { recursive: true });

  t.after(() => {
    if (saved.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
    if (saved.APPDATA === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = saved.APPDATA;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  return { root, local, roaming, prodData, prodProfiles };
}

function rejects(candidate) {
  try {
    assertIsolatedInstanceDataDir(candidate);
    return null;
  } catch (err) {
    return err;
  }
}

function assertRejected(candidate, label) {
  const err = rejects(candidate);
  assert.ok(err, `${label}: expected INVALID_INSTANCE, but the path was ACCEPTED (${candidate})`);
  assert.equal(err.code, 'INVALID_INSTANCE', `${label}: wrong failure code`);
}

function assertAccepted(candidate, label) {
  const err = rejects(candidate);
  assert.equal(err, null, `${label}: must be accepted, but was rejected with ${err && err.code}`);
}

/**
 * Windows 8.3 short path for a directory, or null when the volume does not
 * generate one. `dir /x` lists the alias next to the long name, which is the
 * only portable way to obtain it without P/Invoke.
 */
function shortPathOf(dir) {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  let out;
  try {
    out = execFileSync('cmd.exe', ['/c', 'dir', '/x', parent], { encoding: 'utf8', windowsHide: true });
  } catch {
    return null;
  }
  for (const line of out.split(/\r?\n/)) {
    // Date order depends on the OS locale (YYYY/MM/DD or DD/MM/YYYY), so accept
    // either shape rather than pinning one format.
    const m = line.match(/^\s*\d{2,4}[/-]\d{2}[/-]\d{2,4}\s+\d{2}:\d{2}\s+(?:<DIR>|[\d,]+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const short = m[1];
    const long = m[2];
    if (long.toLowerCase() !== base.toLowerCase()) continue;
    // No `~` means Windows did not create an alias for this entry.
    return short.includes('~') ? path.join(parent, short) : null;
  }
  return null;
}

test('rejects the exact production data directory', (t) => {
  const { prodData } = sandbox(t);
  assertRejected(prodData, 'exact production data dir');
});

// The original defect: this branch compared with `===` and accepted children.
test('rejects a SUBDIRECTORY of the production data directory', (t) => {
  const { prodData } = sandbox(t);
  assertRejected(path.join(prodData, 'sub'), 'direct child of production data dir');
  assertRejected(path.join(prodData, 'a', 'b', 'c'), 'deep child of production data dir');
  assertRejected(path.join(prodData, 'instances', 'profiles'), 'instances/profiles under production');
});

test('rejects the production tunnel-client profile directory and its children', (t) => {
  const { prodProfiles } = sandbox(t);
  assertRejected(prodProfiles, 'exact %APPDATA%\\tunnel-client');
  assertRejected(path.join(prodProfiles, 'nested'), 'child of %APPDATA%\\tunnel-client');
  assertRejected(path.join(prodProfiles, 'a', 'b'), 'deep child of %APPDATA%\\tunnel-client');
});

test('rejects the production paths however they are spelled (case, separators, dotdot)', (t) => {
  const { prodData, prodProfiles } = sandbox(t);
  assertRejected(path.join(prodData, 'sub').toUpperCase(), 'uppercased child path');
  assertRejected(`${prodData}\\sub${path.sep}`, 'trailing separator');
  assertRejected(path.join(prodData, 'sub', '..', 'other'), 'dotdot that stays inside production');
  assertRejected(`${prodProfiles}/nested`, 'forward slashes');
});

test('does NOT over-block look-alike dev directories', (t) => {
  const { local, roaming } = sandbox(t);
  // The `-dev` sibling shares a long common prefix; a naive `startsWith` would
  // reject it, which would make the documented dev layout unusable.
  assertAccepted(path.join(local, 'McpTunnelAccountManager-dev', 'smoke-123', 'data'), '-dev sibling');
  assertAccepted(path.join(roaming, 'tunnel-client-dev', 'x'), 'tunnel-client-dev sibling');
  assertAccepted(path.join(local, 'Other', 'data'), 'unrelated directory');
});

test('rejects an 8.3 short name that resolves into the production data directory', (t) => {
  const { prodData } = sandbox(t);
  const short = shortPathOf(prodData);
  if (!short) {
    t.skip('8.3 short names are not generated on this volume');
    return;
  }
  // Sanity: the alias really does name production, so this is a genuine bypass.
  assert.equal(realResolve(short).toLowerCase(), realResolve(prodData).toLowerCase(),
    'precondition: the short name must resolve to the production data dir');
  assertRejected(short, '8.3 short name of production data dir');
  assertRejected(path.join(short, 'sub'), 'child under the 8.3 short name');
});

test('rejects a directory junction pointing at production, and accepts one pointing elsewhere', (t) => {
  const { root, prodData, local } = sandbox(t);
  const link = path.join(root, 'junction-to-prod');

  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, prodData], { windowsHide: true, stdio: 'pipe' });
  } catch {
    t.skip('directory junctions are not available in this environment');
    return;
  }
  t.after(() => { try { fs.rmdirSync(link); } catch (_) {} });

  assert.equal(realResolve(link).toLowerCase(), realResolve(prodData).toLowerCase(),
    'precondition: the junction must resolve to the production data dir');
  assertRejected(link, 'junction -> production data dir');
  assertRejected(path.join(link, 'instances'), 'child under junction -> production');

  // Control: a junction that does NOT point at production must stay usable.
  const devTarget = path.join(local, 'McpTunnelAccountManager-dev');
  fs.mkdirSync(devTarget, { recursive: true });
  const devLink = path.join(root, 'junction-to-dev');
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', devLink, devTarget], { windowsHide: true, stdio: 'pipe' });
  } catch {
    return; // control is best-effort; the rejection assertions above already ran
  }
  t.after(() => { try { fs.rmdirSync(devLink); } catch (_) {} });
  assertAccepted(devLink, 'junction -> dev directory');
});

test('still rejects empty / missing / NUL-bearing input', (t) => {
  sandbox(t);
  for (const bad of ['', '   ', null, undefined, 'C:\\tmp\\a\0b']) {
    const err = rejects(bad);
    assert.ok(err, `expected rejection for ${JSON.stringify(bad)}`);
    assert.equal(err.code, 'INVALID_INSTANCE');
  }
});

test('returns the caller-supplied resolved path, not the real path', (t) => {
  const { local } = sandbox(t);
  const candidate = path.join(local, 'McpTunnelAccountManager-dev', 'x', 'data');
  assert.equal(assertIsolatedInstanceDataDir(candidate), path.resolve(candidate));
});
