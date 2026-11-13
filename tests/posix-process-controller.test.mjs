import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDefaultProcessController, createAdapters, resolveDefaultProxy } from '../src/adapters/index.mjs';
import { createInstanceAdapter } from '../src/adapters/instance-adapter.mjs';
import { createPosixProcessController, requestPosixSupervisor } from '../src/adapters/posix-process-controller.mjs';
import { createPosixProcessReader } from '../src/adapters/posix-process-reader.mjs';
import { writeJsonFile, processPaths, processFault } from '../src/adapters/posix-process-protocol.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const native = { skip: !['linux', 'darwin'].includes(process.platform) };
const artifactRoot = process.env.TEST_ARTIFACT_ROOT ? path.resolve(process.env.TEST_ARTIFACT_ROOT, 'posix') :
  path.join(repo, 'artifacts', 'mac-port-20261113', 'posix');
fs.mkdirSync(artifactRoot, { recursive: true });
const socketRoot = process.platform === 'darwin'
  ? fs.mkdtempSync('/tmp/mtam-posix-test-') : path.join(artifactRoot, 'sockets');
after(() => { try { fs.rmdirSync(socketRoot); } catch { /* a failed test keeps evidence */ } });
// The managed Linux test sandbox forbids Unix sockets and allows loopback TCP.
// Darwin CI exercises the production default Unix socket transport directly.
const controlTransport = process.platform === 'darwin' ? 'unix' : 'tcp';

const fixtureCode = `
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const flag = name => { const i=args.indexOf(name); return i >= 0 ? args[i+1] : null; };
const output = flag('--output') || process.env.FIXTURE_OUTPUT;
if (process.env.IGNORE_TERM === 'yes') process.on('SIGTERM', () => {});
if (process.env.AUTO_EXIT_MS) setTimeout(()=>process.exit(0),Number(process.env.AUTO_EXIT_MS));
const server=net.createServer(socket=>socket.end('fixture'));
server.listen(0,'127.0.0.1',()=>{
  const info={pid:process.pid,port:server.address().port,args,env:process.env};
  if(output)fs.writeFileSync(output,JSON.stringify(info));
  const health=flag('--health.url-file');
  if(health)fs.writeFileSync(health,'http://127.0.0.1:'+server.address().port);
  if(process.env.SPAWN_DESCENDANT==='yes'){
    spawn(process.execPath,[process.argv[1]],{stdio:'ignore',detached:process.env.DETACH_DESCENDANT==='yes',
      env:{PATH:process.env.PATH || '/usr/bin:/bin',FIXTURE_OUTPUT:output+'.child',IGNORE_TERM:process.env.IGNORE_TERM || '',
        AUTO_EXIT_MS:process.env.DESCENDANT_EXIT_MS || ''}}).unref();
  }
});
`;

test('macOS defaults use direct networking and an absolute profile file', t => {
  assert.equal(resolveDefaultProxy({}, 'darwin'), '');
  assert.equal(resolveDefaultProxy({}, 'win32'), 'http://127.0.0.1:7897');
  assert.equal(resolveDefaultProxy({ HTTPS_PROXY: 'http://fixture.invalid:8123' }, 'darwin'), 'http://fixture.invalid:8123');
  const saved = new Map(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].map(key => [key, process.env[key]]));
  const directory = fs.mkdtempSync(path.join(artifactRoot, 'template-'));
  try {
    for (const key of saved.keys()) delete process.env[key];
    const adapter = createAdapters({ dataDir: directory, platform: 'darwin',
      paths: { userProfile: path.join(directory, 'Home With Spaces'), appData: path.join(directory, 'config') },
      processController: {}, probe: {} })['overleaf-mcp'];
    const template = adapter._buildLaunchTemplate();
    assert.equal(template.args.includes('--http-proxy'), false);
    assert.equal(template.args.includes(''), false);
    assert.equal(template.args.includes('--profile'), false);
    assert.equal(template.args[template.args.indexOf('--profile-file') + 1], adapter.configPath);
    assert.equal(template.serviceMcpEnv.HTTP_PROXY, '');
    assert.equal(template.command.endsWith('/tunnel-client'), true);
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await predicate(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw last || new Error('Synthetic process did not reach the expected state');
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(artifactRoot, 'controller-'));
  const dataDir = path.join(directory, 'data');
  const script = path.join(directory, 'child fixture.mjs');
  fs.writeFileSync(script, fixtureCode);
  const controller = createDefaultProcessController({ dataDir,
    posixOptions: { socketRoot, controlTransport, ...options } });
  const scopes = new Set();
  t.after(async () => {
    for (const scope of scopes) {
      try {
        const file = processPaths(dataDir, scope).recordFile;
        if (fs.existsSync(file)) await controller.stop(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (error) {
        assert.fail(`Synthetic fixture cleanup failed for ${scope}: ${error.code || error.message}`);
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const launch = (service, extra = {}) => {
    scopes.add(service);
    return controller.launch({ service, command: process.execPath, args: [script],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', FIXTURE_OUTPUT: path.join(directory, `${service}.json`) },
      operationId: 'synthetic-operation', ...extra });
  };
  return { directory, dataDir, script, controller, scopes, launch };
}

test('default macOS dispatch never starts PowerShell and verifies an empty owned scope', async t => {
  const directory = fs.mkdtempSync(path.join(artifactRoot, 'dispatch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let spawned = 0;
  const controller = createDefaultProcessController({ dataDir: directory, platform: 'darwin',
    scriptPath: 'bundled-process-control.ps1', spawnHelper: () => { spawned += 1; throw new Error('must not spawn'); } });
  assert.equal(controller.platform, 'darwin');
  assert.deepEqual(await controller.inspect('mcp_empty'), {
    running: false, absenceVerified: true, pid: null, service: 'mcp_empty'
  });
  assert.deepEqual(await controller.list(), []);
  assert.equal(spawned, 0);
});

test('native POSIX launch preserves explicit environment/argv and observes only the owned listener', native, async t => {
  const f = fixture(t);
  const output = path.join(f.directory, 'env.json');
  // CoreFoundation initializes this UID-qualified value on macOS. Supply a
  // valid, deterministic value so the entire environment still compares
  // exactly; no unexpected inherited variable (including secrets) is ignored.
  const env = Object.freeze({ PATH: process.env.PATH || '/usr/bin:/bin', FIXTURE_OUTPUT: output,
    SYNTHETIC_SECRET: 'fixture-only-value', CASE_sensitive: 'unchanged',
    ...(process.platform === 'darwin'
      ? { __CF_USER_TEXT_ENCODING: `0x${process.getuid().toString(16).toUpperCase()}:0x0:0x0` } : {}) });
  const args = [f.script, 'a b', '$(not-a-shell)', 'quote"and\''];
  const identity = await f.launch('mcp_env', { args, env });
  const childInfo = await waitFor(() => fs.existsSync(output) && JSON.parse(fs.readFileSync(output, 'utf8')));
  assert.deepEqual(childInfo.args, args.slice(1));
  assert.deepEqual(childInfo.env, env);
  assert.equal((await f.controller.verify(identity)).valid, true);
  const inspected = await f.controller.inspect('mcp_env');
  assert.equal(inspected.pid, identity.pid);
  assert.equal(inspected.localPort, childInfo.port);
  assert.equal(inspected.healthURL, `http://127.0.0.1:${childInfo.port}`);
  assert.equal(inspected.managed, true);
  assert.ok(inspected.processStartToken);
  assert.ok(identity.posix.launchId);
  const record = fs.readFileSync(processPaths(f.dataDir, 'mcp_env').recordFile, 'utf8');
  assert.equal(record.includes('fixture-only-value'), false);
  assert.equal(record.includes('"token"'), false);
  assert.equal(fs.statSync(processPaths(f.dataDir, 'mcp_env').controlFile).mode & 0o777, 0o600);
  const control = JSON.parse(fs.readFileSync(processPaths(f.dataDir, 'mcp_env').controlFile, 'utf8'));
  assert.equal(fs.statSync(path.dirname(control.socketPath)).mode & 0o777, 0o700);
  if (controlTransport === 'unix') assert.ok(Buffer.byteLength(control.socketPath) <= 100);
  await f.controller.stop(identity);
  assert.equal((await f.controller.inspect('mcp_env')).absenceVerified, true);
  assert.equal(fs.existsSync(path.dirname(control.socketPath)), false);
});

test('native wrong launch capability, executable, birth token and missing ownership cannot stop a live service', native, async t => {
  const f = fixture(t);
  const identity = await f.launch('mcp_identity');
  for (const changed of [
    { ...identity, processStartToken: identity.processStartToken + '-reused' },
    { ...identity, executablePath: '/unrelated/program' },
    { ...identity, startTime: '2000-01-01T00:00:00.000Z' },
    { ...identity, posix: { ...identity.posix, launchId: '11111111-1111-1111-1111-111111111111' } },
    { ...identity, posix: undefined }
  ]) {
    assert.equal((await f.controller.verify(changed)).valid, false);
    await assert.rejects(f.controller.stop(changed), { code: 'PROCESS_IDENTITY_MISMATCH' });
  }
  const control = JSON.parse(fs.readFileSync(processPaths(f.dataDir, 'mcp_identity').controlFile, 'utf8'));
  await assert.rejects(requestPosixSupervisor({ ...control, token: '0'.repeat(64) }, 'stop', identity), { code: 'PROCESS_IDENTITY_MISMATCH' });
  assert.equal((await f.controller.verify(identity)).valid, true);
});

test('native parallel scopes survive sibling stop and a new controller reconnects to persisted ownership', native, async t => {
  const f = fixture(t);
  const [first, second] = await Promise.all([f.launch('mcp_parallel__a'), f.launch('mcp_parallel__b')]);
  assert.notEqual(first.pid, second.pid);
  assert.notEqual(first.posix.processGroupId, second.posix.processGroupId);
  await f.controller.stop(first);
  assert.equal((await f.controller.inspect('mcp_parallel__a')).absenceVerified, true);
  const restarted = createDefaultProcessController({ dataDir: f.dataDir, posixOptions: { socketRoot, controlTransport } });
  assert.equal((await restarted.verify(second)).valid, true);
  const rows = await restarted.list();
  assert.equal(rows.find(row => row.service === 'mcp_parallel__a').running, false);
  assert.equal(rows.find(row => row.service === 'mcp_parallel__b').pid, second.pid);
  await assert.rejects(f.launch('mcp_parallel__b'), { code: 'ALREADY_RUNNING' });
  await restarted.stop(second);
  const switched = await f.launch('mcp_parallel__b', { operationId: 'synthetic-next-account' });
  assert.notEqual(switched.posix.launchId, second.posix.launchId);
  assert.equal(switched.operationId, 'synthetic-next-account');
  assert.equal((await restarted.verify(switched)).valid, true);
});

test('native owned sessions survive their launching manager process exiting and remain stoppable', native, async t => {
  const f = fixture(t);
  f.scopes.add('mcp_manager_restart');
  const managerFile = path.join(f.directory, 'synthetic-manager.mjs');
  const moduleURL = new URL('../src/adapters/index.mjs', import.meta.url).href;
  fs.writeFileSync(managerFile, `import { createDefaultProcessController } from ${JSON.stringify(moduleURL)};
const controller=createDefaultProcessController(${JSON.stringify({ dataDir: f.dataDir, posixOptions: { socketRoot, controlTransport } })});
const record=await controller.launch(${JSON.stringify({ service: 'mcp_manager_restart', command: process.execPath,
    args: [f.script], env: { PATH: process.env.PATH || '/usr/bin:/bin' }, operationId: 'synthetic-manager-start' })});
process.stdout.write(JSON.stringify(record));\n`);
  const manager = spawn(process.execPath, [managerFile], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
  t.after(() => { if (manager.exitCode === null && manager.signalCode === null) manager.kill('SIGTERM'); });
  let output = '';
  manager.stdout.on('data', bytes => { output += bytes; });
  manager.stderr.resume();
  const code = await new Promise((resolve, reject) => { manager.once('error', reject); manager.once('close', resolve); });
  assert.equal(code, 0, 'launching manager exits naturally after disconnecting the private bootstrap pipe');
  const record = JSON.parse(output);
  assert.equal((await f.controller.verify(record)).valid, true);
  await f.controller.stop(record);
  assert.equal((await f.controller.inspect('mcp_manager_restart')).absenceVerified, true);
});

test('native stop confirms descendants and escalates only its own anchored group', native, async t => {
  const f = fixture(t, { stopGraceMs: 150 });
  const output = path.join(f.directory, 'descendants.json');
  const identity = await f.launch('mcp_descendants', { env: {
    PATH: process.env.PATH || '/usr/bin:/bin', FIXTURE_OUTPUT: output, SPAWN_DESCENDANT: 'yes', IGNORE_TERM: 'yes'
  } });
  const descendant = await waitFor(() => fs.existsSync(output + '.child') && JSON.parse(fs.readFileSync(output + '.child', 'utf8')));
  const reader = createPosixProcessReader();
  const before = await reader.readProcess(descendant.pid);
  assert.equal(before.pgid, identity.posix.processGroupId);
  const unrelated = net.createServer(socket => socket.end('unrelated'));
  await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  const file = processPaths(f.dataDir, 'mcp_descendants').recordFile;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  writeJsonFile(file, { ...record, localPort: unrelated.address().port, healthURL: `http://127.0.0.1:${unrelated.address().port}` });
  const inspected = await f.controller.inspect('mcp_descendants');
  assert.notEqual(inspected.localPort, unrelated.address().port, 'cached foreign listener is never adopted');
  await f.controller.stop(identity);
  assert.equal((await reader.readProcess(descendant.pid))?.running === true, false);
  assert.equal((await f.controller.inspect('mcp_descendants')).absenceVerified, true);
  assert.equal(unrelated.listening, true, 'another service using a recorded port remains alive');
  const control = JSON.parse(fs.readFileSync(processPaths(f.dataDir, 'mcp_descendants').controlFile, 'utf8'));
  assert.equal(control.killEscalated, true);
  assert.equal(fs.existsSync(path.dirname(control.socketPath)), false, 'post-kill cleanup removes only the owned endpoint');
});

test('native daemonized descendants keep exit unconfirmed until their recorded identities are gone', native, async t => {
  const f = fixture(t, { stopGraceMs: 200, stopTimeoutMs: 1000 });
  const output = path.join(f.directory, 'detached.json');
  const identity = await f.launch('mcp_detached', { env: {
    PATH: process.env.PATH || '/usr/bin:/bin', FIXTURE_OUTPUT: output,
    SPAWN_DESCENDANT: 'yes', DETACH_DESCENDANT: 'yes', DESCENDANT_EXIT_MS: '4000'
  } });
  const descendant = await waitFor(() => fs.existsSync(output + '.child') && JSON.parse(fs.readFileSync(output + '.child', 'utf8')));
  const reader = createPosixProcessReader();
  const before = await reader.readProcess(descendant.pid);
  assert.notEqual(before.pgid, identity.posix.processGroupId);
  await assert.rejects(f.controller.stop(identity), { code: 'PROCESS_DESCENDANTS_UNCONFIRMED' });
  assert.equal((await reader.readProcess(descendant.pid)).running, true, 'the controller never guesses a signal target outside its anchored group');
  await assert.rejects(f.controller.inspect('mcp_detached'), { code: 'PROCESS_DESCENDANTS_UNCONFIRMED' });
  await waitFor(async () => (await reader.readProcess(descendant.pid))?.running !== true);
  await f.controller.stop(identity);
  assert.equal((await f.controller.inspect('mcp_detached')).absenceVerified, true);
});

function syntheticControl(t, readerOverrides = {}, request = async () => { throw new Error('must not contact reused owner'); }) {
  const dataDir = fs.mkdtempSync(path.join(artifactRoot, 'synthetic-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const scope = 'mcp_synthetic';
  const launchId = '12345678-1234-1234-1234-123456789abc';
  const owner = { pid: 111, ppid: 1, pgid: 111, running: true, executablePath: '/usr/local/bin/node',
    startTime: '2026-11-13T00:00:00.000Z', processStartToken: 'darwin-ps-seconds:boot:1', commandLine: `node supervisor --launch-id=${launchId}` };
  const identity = { pid: 222, pgid: 111, running: true, executablePath: '/opt/synthetic/tunnel-client',
    startTime: '2026-11-13T00:00:01.000Z', processStartToken: 'darwin-ps-seconds:boot:2', service: scope,
    posix: { scope, launchId, supervisorPid: 111, processGroupId: 111 } };
  const control = { version: 1, scope, launchId, token: 'a'.repeat(64), socketPath: '/tmp/mtam-synthetic/ctl', state: 'running',
    supervisor: owner, supervisorPid: 111, record: identity };
  writeJsonFile(processPaths(dataDir, scope).controlFile, control);
  writeJsonFile(processPaths(dataDir, scope).recordFile, identity);
  const reader = { readProcess: async () => null, listGroup: async () => [], listeners: async () => [], ...readerOverrides };
  const controller = createPosixProcessController({ dataDir, platform: 'darwin', processReader: reader, requestControl: request });
  return { dataDir, scope, owner, identity, control, controller, reader };
}

test('stop preserves supervisor escalation metadata written during the owner exit probe', async t => {
  let stopping = false;
  const f = syntheticControl(t, {}, async (_control, action) => {
    if (action === 'stop') { stopping = true; return { accepted: true }; }
    return { state: 'running', supervisorPid: f.owner.pid, rootRunning: true, identity: f.identity };
  });
  const file = processPaths(f.dataDir, f.scope).controlFile;
  f.reader.readProcess = async pid => {
    if (!stopping) return pid === f.owner.pid ? f.owner : f.identity;
    if (pid === f.owner.pid) {
      // The supervisor persists the final receipt and then kills its group
      // while the manager's asynchronous process observation is in flight.
      writeJsonFile(file, { ...f.control, state: 'stopping', killEscalated: true,
        stopReason: 'requested', escapedProcesses: [], descendantsUnverified: false });
    }
    return null;
  };
  assert.deepEqual(await f.controller.stop(f.identity), { stopped: true });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.state, 'stopped');
  assert.equal(saved.killEscalated, true);
  assert.equal(saved.stopReason, 'requested');
  assert.deepEqual(saved.escapedProcesses, []);
  assert.equal(saved.descendantsUnverified, false);
});

test('absence uses newly persisted escaped identities after owner exit or control loss', async t => {
  for (const event of ['owner-exit', 'owner-reuse', 'control-loss']) {
    await t.test(event, async t => {
      const f = syntheticControl(t, {}, async () => { throw processFault('PROCESS_CONTROL_UNAVAILABLE'); });
      const file = processPaths(f.dataDir, f.scope).controlFile;
      const escaped = { ...f.identity, pid: 333, pgid: 333, processStartToken: 'escaped-birth' };
      let ownerReads = 0;
      f.reader.readProcess = async pid => {
        if (pid === f.owner.pid) {
          ownerReads += 1;
          if (event === 'control-loss' && ownerReads === 1) return f.owner;
          writeJsonFile(file, { ...f.control, state: 'stopping', escapedProcesses: [escaped] });
          return event === 'owner-reuse' ? { ...f.owner, processStartToken: 'replacement-birth' } : null;
        }
        return pid === escaped.pid ? escaped : null;
      };
      await assert.rejects(f.controller.inspect(f.scope), { code: 'PROCESS_DESCENDANTS_UNCONFIRMED' });
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'stopping');
    });
  }
});

test('absence refuses changed descendant evidence or a replacement launch during its probes', async t => {
  for (const change of ['descendants', 'launch']) {
    await t.test(change, async t => {
      const f = syntheticControl(t);
      const file = processPaths(f.dataDir, f.scope).controlFile;
      const changed = change === 'descendants'
        ? { ...f.control, escapedProcesses: [{ ...f.identity, pid: 333, pgid: 333, processStartToken: 'escaped-birth' }] }
        : { ...f.control, launchId: 'abcdefab-1234-1234-1234-123456789abc', token: 'b'.repeat(64) };
      f.reader.listGroup = async () => { writeJsonFile(file, changed); return []; };
      await assert.rejects(f.controller.inspect(f.scope), {
        code: change === 'descendants' ? 'PROCESS_DESCENDANTS_UNCONFIRMED' : 'PROCESS_IDENTITY_MISMATCH'
      });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), changed,
        'the old observation must neither release nor overwrite new ownership evidence');
    });
  }
});

test('PID reuse and orphaned recorded descendants never become false absence or numeric kill authority', async t => {
  const f = syntheticControl(t);
  f.reader.readProcess = async pid => pid === 111
    ? { ...f.owner, processStartToken: 'new-birth', executablePath: '/unrelated/node' }
    : f.identity;
  await assert.rejects(f.controller.inspect(f.scope), { code: 'PROCESS_EXIT_UNCONFIRMED' });
  f.reader.readProcess = async () => null;
  f.reader.listGroup = async () => [{ pid: 333, pgid: 111, running: true, state: 'S' }];
  await assert.rejects(f.controller.inspect(f.scope), { code: 'PROCESS_DESCENDANTS_UNCONFIRMED' });
  f.reader.listGroup = async () => [];
  assert.equal((await f.controller.inspect(f.scope)).absenceVerified, true);
});

test('dead control channel and failed process observation propagate without an absence receipt', async t => {
  const f = syntheticControl(t, {}, async () => { throw processFault('PROCESS_CONTROL_TIMEOUT'); });
  f.reader.readProcess = async pid => pid === 111 ? f.owner : f.identity;
  await assert.rejects(f.controller.inspect(f.scope), { code: 'PROCESS_CONTROL_TIMEOUT' });
  f.reader.readProcess = async () => { throw processFault('PROCESS_CONTROL_CONGESTED'); };
  await assert.rejects(f.controller.inspect(f.scope), { code: 'PROCESS_CONTROL_CONGESTED' });
});

test('stop uses the reserved critical helper lane for identity verification as well as exit confirmation', async t => {
  const f = syntheticControl(t);
  const roles = [];
  f.reader.readProcess = async (_pid, options) => { roles.push(options.critical); return null; };
  f.reader.listGroup = async (_pgid, options) => { roles.push(options.critical); return []; };
  assert.equal((await f.controller.stop(f.identity)).stopped, true);
  assert.ok(roles.length >= 2);
  assert.ok(roles.every(value => value === true));
});

test('malformed private ownership records and launch path traversal fail closed', async t => {
  const f = syntheticControl(t);
  fs.writeFileSync(processPaths(f.dataDir, f.scope).controlFile, '{broken');
  await assert.rejects(f.controller.inspect(f.scope), { code: 'PROCESS_RECORD_UNREADABLE' });
  await assert.rejects(f.controller.inspect('../outside'), { code: 'INVALID_PROCESS_SCOPE' });
  await assert.rejects(f.controller.launch({ service: '../outside', command: process.execPath, env: {}, args: [] }), { code: 'INVALID_PROCESS_SCOPE' });
});

test('native launch acknowledgement loss never replays a launch and retains its durable ownership record', native, async t => {
  let spawns = 0;
  const f = fixture(t, {
    launchTimeoutMs: 500,
    spawnSupervisor(command, args, options) {
      spawns += 1;
      const child = spawn(command, args, options);
      const emit = child.emit.bind(child);
      child.emit = (event, ...values) => event === 'message' && values[0]?.kind === 'ready' ? false : emit(event, ...values);
      return child;
    }
  });
  await assert.rejects(f.launch('mcp_ack_loss'), { code: 'PROCESS_LAUNCH_UNCONFIRMED' });
  assert.equal(spawns, 1, 'a lost acknowledgement does not replay Launch');
  assert.ok(fs.existsSync(processPaths(f.dataDir, 'mcp_ack_loss').controlFile));
  await waitFor(async () => (await f.controller.inspect('mcp_ack_loss')).absenceVerified === true);
  assert.equal(spawns, 1);
});

test('native instance adapters switch one account and preserve a simultaneous sibling', native, async t => {
  const f = fixture(t);
  const serviceId = 'mcp_posix_fixture';
  const paths = { userProfile: path.join(f.directory, 'home'), appData: path.join(f.directory, 'config'),
    tunnelHome: f.directory, tunnelClientBin: process.execPath, binaryPrefix: [f.script] };
  const probe = { verify: async input => ({ ok: true, verified: true, identity: input.identity,
    listenerIdentity: input.listenerIdentity, toolListOk: true, expectedTunnelId: input.snapshot.credential.tunnelId }) };
  const a = createInstanceAdapter({ dataDir: f.dataDir, serviceId, profileId: 'a', paths, processController: f.controller, probe });
  const b = createInstanceAdapter({ dataDir: f.dataDir, serviceId, profileId: 'b', paths, processController: f.controller, probe });
  f.scopes.add(a.instanceId); f.scopes.add(b.instanceId);
  const start = async (adapter, operationId, tunnelId) => {
    const snapshot = await adapter.prepare({ operationId, credential: { tunnelId, apiKey: `synthetic-${tunnelId}` } });
    await adapter.applyIfUnchanged({ operationId, snapshot });
    return snapshot;
  };
  const first = await start(a, 'op-a', 'tunnel-a');
  await start(b, 'op-b', 'tunnel-b');
  assert.ok(a.localPort);
  assert.ok(b.localPort);
  assert.notEqual(a.localPort, b.localPort);
  const sibling = await f.controller.inspect(b.instanceId);
  const second = await start(a, 'op-a-next', 'tunnel-a-next');
  assert.notEqual(second.identity.posix.launchId, first.identity.posix.launchId);
  assert.equal((await f.controller.inspect(b.instanceId)).pid, sibling.pid);
  const receipt = await a.stopConnection({ operationId: 'stop-a', serviceId });
  assert.equal(receipt.stopped, true);
  assert.equal((await f.controller.inspect(a.instanceId)).absenceVerified, true);
  assert.equal((await f.controller.verify(sibling)).valid, true);
});
