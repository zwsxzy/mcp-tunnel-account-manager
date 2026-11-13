/**
 * The smoke script is an acceptance command in contract §7, but it used to hard-code
 * port 17643 — on a machine where another console holds that port the command could not
 * be run at all. It now accepts `--port`, and these cases make sure that new knob can
 * never be used to reach the production console port or to smuggle in a bad value.
 *
 * Only the fail-fast paths are exercised here (they exit before any manager starts), so
 * these run in milliseconds; the full demo run stays a manual/heavy acceptance step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/smoke-concurrent-instances.mjs', import.meta.url));

function runWith(args, timeoutMs = 60000) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('--port 17642 (production console) is refused before anything starts', () => {
  const r = runWith(['--port', '17642']);
  assert.notEqual(r.status, 0, 'must exit non-zero');
  assert.match(r.out, /production console port/i,
    `expected a production-port refusal, got:\n${r.out.slice(0, 400)}`);
});

test('an invalid --port value is refused with a clear message', () => {
  const r = runWith(['--port', 'abc']);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /must be a valid TCP port/i, `got:\n${r.out.slice(0, 300)}`);
});

test('an out-of-range --port is refused', () => {
  for (const bad of ['0', '70000', '-1']) {
    const r = runWith(['--port', bad]);
    assert.notEqual(r.status, 0, `--port ${bad} must be refused`);
    assert.match(r.out, /must be a valid TCP port/i, `--port ${bad} got:\n${r.out.slice(0, 300)}`);
  }
});

test('an occupied --port is refused and the message points at recovery', async () => {
  // Occupy a free ephemeral port ourselves, so this is deterministic and never depends
  // on whether 17643 happens to be free on the machine (which would otherwise let the
  // script start a full demo run inside a unit test).
  const net = await import('node:net');
  const srv = net.createServer();
  const port = await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
  try {
    const r = runWith(['--port', String(port)]);
    assert.notEqual(r.status, 0, 'must exit non-zero when the port is taken');
    assert.match(r.out, /already in use/i, `got:\n${r.out.slice(0, 300)}`);
    assert.match(r.out, /--port/, 'the in-use message must tell the operator about --port');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
