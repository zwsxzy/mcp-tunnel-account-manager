import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHelperBudget } from '../src/adapters/ps-worker-pool.mjs';
import { createPosixCommandRunner } from '../src/adapters/posix-helper-runner.mjs';
import {
  createPosixProcessReader, parseDarwinPsRow, parseLinuxProcStat, parseLsofNames, parseLinuxTcpListeners
} from '../src/adapters/posix-process-reader.mjs';

const ok = stdout => ({ code: 0, stdout, stderr: '' });
const absent = { code: 1, stdout: '', stderr: '' };
const row = (pid = 4321, second = '56', state = 'Ss') =>
  ` ${pid} 4000 4321 501 ${state} Fri Nov 13 12:34:${second} 2026\n`;
const birth = '1794560000.123456';
const controlError = helperCode => error => error?.controlChannel === true && error?.helperCode === helperCode;

function darwinReader({ executable = '/Applications/Test App/bin/test-node', intercept = null } = {}) {
  const calls = [];
  const reader = createPosixProcessReader({
    platform: 'darwin',
    fsImpl: { realpath: async value => value },
    runCommand: async (command, args, options) => {
      const call = { command, args, options };
      calls.push(call);
      const override = intercept ? await intercept(call, calls) : undefined;
      if (override !== undefined) return override;
      if (command === '/usr/sbin/sysctl') return ok('{ sec = 1794560000, usec = 123456 } Fri Nov 13 00:00:00 2026\n');
      if (command === '/bin/ps') {
        const field = args.at(-1);
        if (field === 'comm=') return ok(`${executable}\n`);
        if (field === 'args=') return ok(`${executable} /workspace/synthetic-supervisor.mjs --launch-id=synthetic-launch\n`);
        if (args.includes('-A')) return ok(row() + row(4322));
        return ok(row());
      }
      if (command === '/usr/sbin/lsof') {
        if (args.includes('txt')) return ok(`p4321\0n${executable}\0n/usr/lib/libSynthetic.dylib\0\n`);
        return ok('p4321\0n127.0.0.1:32123\0n[::1]:32124\0n*:4444\0n10.0.0.1:5555\0\n');
      }
      assert.fail(`Unexpected fixed helper: ${command}`);
    }
  });
  return { reader, calls };
}

test('Darwin ps parser records honest second precision and rejects malformed identities', () => {
  const parsed = parseDarwinPsRow(row(), birth);
  assert.equal(parsed.pid, 4321);
  assert.equal(parsed.ppid, 4000);
  assert.equal(parsed.pgid, 4321);
  assert.equal(parsed.uid, 501);
  assert.equal(parsed.startTime, '2026-11-13T12:34:56.000Z');
  assert.equal(parsed.startTimePrecision, 'seconds');
  assert.match(parsed.processStartToken, /^darwin-ps-seconds:1794560000\.123456:/);
  assert.equal(parseDarwinPsRow(row(4321, '56', 'Z'), birth).running, false);
  for (const invalid of ['', row().replace('4321', 'NaN'), row().replace('Nov 13', 'Feb 31'), row().replace('Fri', 'Mon')]) {
    assert.throws(() => parseDarwinPsRow(invalid, birth), controlError('POSIX_PS_OUTPUT_INVALID'));
  }
});

test('Darwin reads full paths and argv separately, validates mapped text, and rechecks birth', async () => {
  const executable = '/Applications/An Application With Spaces.app/Contents/MacOS/a-very-long-executable-name';
  const { reader, calls } = darwinReader({ executable });
  const inspected = await reader.readProcess(4321, { critical: true });
  assert.equal(inspected.executablePath, executable);
  assert.equal(inspected.executableEvidence, 'comm-and-mapped-text');
  assert.match(inspected.commandLine, /--launch-id=synthetic-launch$/);
  const psCalls = calls.filter(call => call.command === '/bin/ps');
  assert.ok(psCalls.every(call => call.args.includes('-ww')));
  assert.deepEqual(psCalls.filter(call => call.args.at(-1) === 'comm=').map(call => call.args), [
    ['-ww', '-p', '4321', '-o', 'comm='], ['-ww', '-p', '4321', '-o', 'comm=']
  ]);
  assert.ok(psCalls.some(call => call.args.at(-1) === 'args='));
  assert.ok(calls.every(call => call.options.critical === true));
  assert.ok(calls.some(call => call.command === '/usr/sbin/lsof' && call.args.includes('-a') && call.args.includes('txt')));
});

test('Darwin cannot establish executable identity from spoofed argv0 alone', async () => {
  const { reader } = darwinReader({ intercept(call) {
    if (call.command === '/usr/sbin/lsof') return ok('p4321\0n/actual/other-executable\0\n');
  } });
  await assert.rejects(reader.readProcess(4321), controlError('POSIX_EXECUTABLE_PATH_UNVERIFIED'));
});

test('Darwin detects a PID birth change across the inspection and does not claim absence', async () => {
  let metadataCalls = 0;
  const { reader } = darwinReader({ intercept(call) {
    if (call.command === '/bin/ps' && call.args.at(-1).includes('lstart=')) {
      metadataCalls += 1;
      return ok(row(4321, metadataCalls === 1 ? '56' : '57'));
    }
  } });
  await assert.rejects(reader.readProcess(4321), controlError('POSIX_PROCESS_CHANGED'));
});

test('Darwin distinguishes a missing PID from helper failure and empty success output', async () => {
  const missing = darwinReader({ intercept: call => call.command === '/bin/ps' ? absent : undefined });
  assert.equal(await missing.reader.readProcess(4321), null);
  for (const response of [{ code: 1, stdout: '', stderr: 'synthetic read failure' }, ok('')]) {
    const { reader } = darwinReader({ intercept: call => call.command === '/bin/ps' ? response : undefined });
    await assert.rejects(reader.readProcess(4321), error => error?.controlChannel === true);
  }
  const { reader } = darwinReader({ intercept(call) {
    if (call.command === '/bin/ps') throw new Error('synthetic helper exception');
  } });
  await assert.rejects(reader.readProcess(4321), controlError('POSIX_HELPER_FAILED'));
});

test('Darwin lists numeric metadata without reading unrelated command lines or environments', async () => {
  const { reader, calls } = darwinReader();
  const group = await reader.listGroup(4321);
  assert.deepEqual(group.map(process => process.pid), [4321, 4322]);
  assert.equal(calls.filter(call => call.command === '/bin/ps').length, 1);
  assert.deepEqual(calls.at(-1).args, ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,uid=,stat=,lstart=']);
  assert.equal(group[0].commandLine, undefined);
});

test('Darwin process tables tolerate kernel_task and zero-group system rows without authorizing pid zero', async () => {
  const { reader } = darwinReader({ intercept(call) {
    if (call.command === '/bin/ps' && call.args.includes('-A')) {
      return ok('0 0 0 0 Ss Fri Nov 13 00:00:00 2026\n' +
        '1 0 0 0 Ss Fri Nov 13 00:00:00 2026\n' + row());
    }
  } });
  const rows = await reader.listProcesses();
  assert.deepEqual(rows.map(entry => [entry.pid, entry.pgid]), [[1, 0], [4321, 4321]]);
  assert.deepEqual((await reader.listGroup(4321)).map(entry => entry.pid), [4321]);
  await assert.rejects(reader.readProcess(0), controlError('POSIX_INVALID_PID'));
});

test('Darwin listener query is bound to the requested PID and excludes public and wildcard addresses', async () => {
  const { reader, calls } = darwinReader();
  const listeners = await reader.listeners(4321);
  assert.deepEqual(listeners.map(listener => [listener.localAddress, listener.localPort]), [
    ['127.0.0.1', 32123], ['::1', 32124]
  ]);
  assert.equal(listeners[1].healthURL, 'http://[::1]:32124');
  assert.ok(listeners.every(listener => listener.pid === 4321));
  const call = calls.find(call => call.command === '/usr/sbin/lsof');
  assert.deepEqual(call.args, ['-nP', '-a', '-p', '4321', '-iTCP', '-sTCP:LISTEN', '-F0pn']);
});

test('Darwin listener absence requires an empty no-match result; errors and PID substitution fail closed', async () => {
  const missing = darwinReader({ intercept: call => call.command === '/usr/sbin/lsof' ? absent : undefined });
  assert.deepEqual(await missing.reader.listeners(4321), []);
  for (const response of [{ code: 1, stdout: '', stderr: 'synthetic access failure' }, ok('p9999\0n127.0.0.1:32123\0')]) {
    const { reader } = darwinReader({ intercept: call => call.command === '/usr/sbin/lsof' ? response : undefined });
    await assert.rejects(reader.listeners(4321), error => error?.controlChannel === true);
  }
});

test('all process-reading entry points reject invalid numeric identifiers before invoking a helper', async () => {
  const { reader, calls } = darwinReader();
  for (const pid of [0, -1, '4321', 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    await assert.rejects(reader.readProcess(pid), controlError('POSIX_INVALID_PID'));
    await assert.rejects(reader.listeners(pid), controlError('POSIX_INVALID_PID'));
    await assert.rejects(reader.listGroup(pid), controlError('POSIX_INVALID_PGID'));
  }
  assert.equal(calls.length, 0);
});

test('lsof field parsing preserves spaces and rejects names without matching process evidence', () => {
  assert.deepEqual(parseLsofNames('p123\0n/a path/with spaces\0\n', 123), ['/a path/with spaces']);
  assert.deepEqual(parseLsofNames('p123\nn/a path/with spaces\n', 123), ['/a path/with spaces']);
  assert.deepEqual(parseLsofNames('p123\0\nftxt\0n/a path/with spaces\0\nf7\0n127.0.0.1:32123\0\n', 123),
    ['/a path/with spaces', '127.0.0.1:32123']);
  assert.throws(() => parseLsofNames('f7\0n/a/path\0', 123), controlError('POSIX_LSOF_OUTPUT_INVALID'));
  assert.throws(() => parseLsofNames('n/a/path\0', 123), controlError('POSIX_LSOF_OUTPUT_INVALID'));
  assert.throws(() => parseLsofNames('p124\0n/a/path\0', 123), controlError('POSIX_LSOF_PID_MISMATCH'));
});

function linuxStat({ pid = 123, name = 'a (nested) process', state = 'S', ppid = 100, pgid = 123, ticks = '456789' } = {}) {
  const fields = Array(24).fill('0');
  [fields[0], fields[1], fields[2], fields[3], fields[19]] = [state, String(ppid), String(pgid), '123', ticks];
  return `${pid} (${name}) ${fields.join(' ')}\n`;
}

test('Linux proc stat parses start ticks without confusing spaces and parentheses in comm', () => {
  assert.deepEqual(parseLinuxProcStat(linuxStat()), { pid: 123, ppid: 100, pgid: 123, state: 'S', startTicks: '456789' });
  assert.throws(() => parseLinuxProcStat('123 (partial) S 1 2'), controlError('POSIX_PROC_STAT_INVALID'));
});

test('Linux TCP parsing attributes socket inodes to one process and supports IPv4 and IPv6 loopback', () => {
  const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
  const line = (index, local, state, inode) => `${index}: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}\n`;
  const table = header + line(0, '0100007F:7D00', '0A', '101') + line(1, '00000000:7D01', '0A', '101') +
    line(2, '0100007F:7D02', '0A', '202') + line(3, '0100007F:7D03', '01', '101') +
    line(4, '00000000000000000000000001000000:7D04', '0A', '303');
  const parsed = parseLinuxTcpListeners(table, new Set(['101', '303']), 123, { littleEndian: true });
  assert.deepEqual(parsed.map(listener => [listener.localAddress, listener.localPort]), [['127.0.0.1', 32000], ['::1', 32004]]);
});

test('Linux reader fails closed if a PID is recycled between executable observations', async () => {
  let statReads = 0;
  const reader = createPosixProcessReader({
    platform: 'linux', linuxClockTicks: 100,
    fsImpl: {
      async readFile(file, encoding) {
        if (file.endsWith('/boot_id')) return '67c135ec-b969-4e67-8ad3-b6f9b3fd3e0e\n';
        if (file === '/proc/stat') return 'btime 1794560000\n';
        if (file.endsWith('/123/stat')) return linuxStat({ ticks: ++statReads === 1 ? '456789' : '456790' });
        if (file.endsWith('/cmdline')) return Buffer.from('/task/synthetic-node\0fixture.mjs\0');
        assert.fail(`Unexpected synthetic path ${file} (${encoding})`);
      },
      async stat() { return { uid: 1000 }; },
      async readlink() { return '/task/synthetic-node'; }
    }
  });
  await assert.rejects(reader.readProcess(123), controlError('POSIX_PROCESS_CHANGED'));
});

test('Linux permission failures are control failures, not verified process absence', async () => {
  const reader = createPosixProcessReader({
    platform: 'linux', linuxClockTicks: 100,
    fsImpl: {
      async readFile(file) {
        if (file.endsWith('/boot_id')) return '67c135ec-b969-4e67-8ad3-b6f9b3fd3e0e\n';
        if (file === '/proc/stat') return 'btime 1794560000\n';
        throw Object.assign(new Error('synthetic permission error'), { code: 'EACCES' });
      },
      async stat() { return { uid: 1000 }; }
    }
  });
  await assert.rejects(reader.readProcess(123), controlError('POSIX_PROC_READ_FAILED'));
});

function fakeChild({ pid = 8765, stdout = true, stderr = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = stdout ? new EventEmitter() : undefined;
  child.stderr = stderr ? new EventEmitter() : undefined;
  child.kills = [];
  child.kill = signal => { child.kills.push(signal); return true; };
  return child;
}

function newBudget() { return createHelperBudget({ maxTotal: 2, maxNormal: 1, waitTimeoutMs: 30 }); }

test('POSIX helpers share the bounded budget and receive a minimal locale-pinned environment', async () => {
  const budget = newBudget();
  let observed;
  const run = createPosixCommandRunner({ helperBudget: budget, spawnHelper(command, args, options) {
    observed = { command, args, options };
    const child = fakeChild();
    queueMicrotask(() => { child.stdout.emit('data', 'synthetic output'); child.emit('close', 0, null); });
    return child;
  } });
  assert.deepEqual(await run('/bin/ps', ['-p', '8765']), { code: 0, signal: null, stdout: 'synthetic output', stderr: '' });
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.detached, true);
  assert.deepEqual(observed.options.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
  assert.equal(budget.getStats().active, 0);
  await assert.rejects(run('ps', []), controlError('POSIX_HELPER_INVALID_ARGUMENTS'));
  await assert.rejects(run('/bin/ps', ['\0']), controlError('POSIX_HELPER_INVALID_ARGUMENTS'));
});

test('a public helper timeout holds its physical lease until close and leaves the critical lane available', async t => {
  const keepAlive = setTimeout(() => {}, 3000);
  t.after(() => clearTimeout(keepAlive));
  const budget = newBudget();
  const children = [];
  const run = createPosixCommandRunner({ helperBudget: budget, helperExecutionTimeoutMs: 10, helperKillGraceMs: 10,
    spawnHelper() { const child = fakeChild(); children.push(child); return child; } });
  await assert.rejects(run('/bin/ps', []), error => controlError('POSIX_HELPER_TIMEOUT')(error) && error.exitUnconfirmed === true);
  assert.equal(budget.getStats().active, 1);
  assert.deepEqual(children[0].kills, ['SIGTERM']);
  const blocked = assert.rejects(run('/bin/ps', []), error => error.code === 'PROCESS_CONTROL_CONGESTED');
  const critical = run('/bin/ps', [], { critical: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 2);
  children[1].emit('close', 0, null);
  await critical;
  await blocked;
  assert.equal(children.length, 2, 'congestion cannot create an additional helper');
  assert.equal(budget.getStats().active, 1);
  children[0].emit('close', null, 'SIGTERM');
  assert.equal(budget.getStats().active, 0, 'late physical close returns the original lease');
});

test('a helper with missing output pipes cannot publish empty success or release a still-live lease', async () => {
  for (const closes of [true, false]) {
    const budget = newBudget();
    const child = fakeChild({ stdout: false });
    const run = createPosixCommandRunner({ helperBudget: budget, helperExecutionTimeoutMs: 10, helperKillGraceMs: 10,
      spawnHelper: () => child });
    const promise = run('/bin/ps', []);
    if (closes) queueMicrotask(() => child.emit('close', 0, null));
    await assert.rejects(promise, controlError('POSIX_HELPER_OUTPUT_UNAVAILABLE'));
    assert.equal(budget.getStats().active, closes ? 0 : 1);
    if (!closes) child.emit('close', 0, null);
    assert.equal(budget.getStats().active, 0);
  }
});

test('spawn failure releases a nonexistent helper but an unobservable child isolates its lease', async () => {
  const syncBudget = newBudget();
  const syncRun = createPosixCommandRunner({ helperBudget: syncBudget,
    spawnHelper() { throw Object.assign(new Error('synthetic missing binary'), { code: 'ENOENT' }); } });
  await assert.rejects(syncRun('/bin/ps', []), controlError('POSIX_HELPER_SPAWN_FAILED'));
  assert.equal(syncBudget.getStats().active, 0);

  const asyncBudget = newBudget();
  const asyncRun = createPosixCommandRunner({ helperBudget: asyncBudget, spawnHelper() {
    const child = fakeChild({ pid: undefined });
    child.pid = undefined;
    queueMicrotask(() => child.emit('error', Object.assign(new Error('synthetic spawn error'), { code: 'ENOENT' })));
    return child;
  } });
  await assert.rejects(asyncRun('/bin/ps', []), controlError('POSIX_HELPER_SPAWN_FAILED'));
  assert.equal(asyncBudget.getStats().active, 0);

  const unknownBudget = newBudget();
  const unknownRun = createPosixCommandRunner({ helperBudget: unknownBudget,
    spawnHelper: () => ({ pid: 8765, get on() { throw new Error('synthetic invalid child'); } }) });
  await assert.rejects(unknownRun('/bin/ps', []), controlError('POSIX_HELPER_UNOBSERVABLE'));
  assert.equal(unknownBudget.getStats().active, 1);
});

test('helper output limits and a live channel error hold the physical lease until close', async () => {
  for (const kind of ['overflow', 'error']) {
    const budget = newBudget();
    const child = fakeChild();
    const run = createPosixCommandRunner({ helperBudget: budget, maxOutputBytes: 8, helperKillGraceMs: 10,
      spawnHelper: () => child });
    const promise = run('/bin/ps', []);
    await new Promise(resolve => setImmediate(resolve));
    if (kind === 'overflow') child.stdout.emit('data', '123456789');
    else child.emit('error', new Error('synthetic pipe failure'));
    await assert.rejects(promise, error => error.controlChannel === true && error.exitUnconfirmed === true);
    assert.equal(budget.getStats().active, 1);
    child.emit('close', 0, null);
    assert.equal(budget.getStats().active, 0);
  }
});

test('an exited helper is never signalled again while waiting for its pipes to close', async () => {
  const budget = newBudget();
  const child = fakeChild();
  const run = createPosixCommandRunner({ helperBudget: budget, helperExecutionTimeoutMs: 10, helperKillGraceMs: 10,
    spawnHelper: () => child });
  const promise = run('/bin/ps', []);
  queueMicrotask(() => child.emit('exit', 0, null));
  await assert.rejects(promise, error => error.exitUnconfirmed === true);
  assert.deepEqual(child.kills, []);
  assert.equal(budget.getStats().active, 1);
  child.emit('close', 0, null);
  assert.equal(budget.getStats().active, 0);
});

test('native POSIX reader observes a real synthetic child, its exact executable, and only its listener',
  { skip: !['linux', 'darwin'].includes(process.platform) }, async t => {
    const artifactRoot = process.env.TEST_ARTIFACT_ROOT ? path.resolve(process.env.TEST_ARTIFACT_ROOT, 'posix') :
      path.join(process.cwd(), 'artifacts', 'mac-port-20261113', 'posix');
    await fs.mkdir(artifactRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(artifactRoot, 'reader-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const unrelated = net.createServer();
    unrelated.listen(0, '127.0.0.1');
    await once(unrelated, 'listening');
    t.after(() => new Promise(resolve => unrelated.close(resolve)));
    const unrelatedPort = unrelated.address().port;
    const script = path.join(directory, 'synthetic listener with spaces.mjs');
    await fs.writeFile(script, 'import net from "node:net"; const server=net.createServer(); server.listen(0,"127.0.0.1",()=>console.log(server.address().port));\n');
    const child = spawn(process.execPath, [script, 'literal argument with spaces'], {
      cwd: directory, env: {}, detached: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    });
    const output = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data)),
      once(child, 'error').then(([error]) => { throw error; })
    ]);
    const port = Number(output.trim());
    assert.ok(Number.isSafeInteger(port) && port > 0);
    const reader = createPosixProcessReader();
    const observed = await reader.readProcess(child.pid);
    assert.equal(observed.pid, child.pid);
    assert.equal(observed.pgid, child.pid);
    assert.equal(observed.running, true);
    assert.equal(observed.executablePath, await fs.realpath(process.execPath));
    assert.match(observed.commandLine, /literal argument with spaces/);
    assert.ok(observed.processStartToken);
    const listeners = await reader.listeners(child.pid);
    assert.ok(listeners.some(listener => listener.localPort === port));
    assert.ok(listeners.every(listener => listener.localPort !== unrelatedPort));
    const listed = await reader.listGroup(child.pid);
    assert.ok(listed.some(process => process.pid === child.pid));
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
    assert.equal(await reader.readProcess(child.pid), null);
    assert.deepEqual(await reader.listeners(child.pid), []);
  });
