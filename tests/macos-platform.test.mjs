import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { resolvePlatformPaths } from '../src/core/platform-paths.mjs';
import { createVault } from '../src/vault.mjs';
import { createSecurity } from '../src/security.mjs';
import { issueCarrierConfirmation, verifyCarrierConfirmation } from '../src/core/carrier-confirmation.mjs';
import { createMcpLocationResolver } from '../src/config/mcp-locations.mjs';
import { createMcpDiscovery } from '../src/config/mcp-discovery.mjs';
import { assertIsolatedInstanceDataDir, createInstanceAdapterProvider, rewriteInstanceLaunchArgs, realResolve } from '../src/adapters/instance-adapter.mjs';

const artifactRoot = fileURLToPath(new URL('../artifacts/mac-port-20261113/platform-tests/', import.meta.url));
function workspace(t) {
  fs.mkdirSync(artifactRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifactRoot, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const posixOnly = { skip: process.platform === 'win32' };
const mode = target => fs.statSync(target).mode & 0o777;

test('Mac defaults use Application Support, XDG config, and native executable paths', () => {
  const home = '/Users/Case Sensitive 用户';
  const result = resolvePlatformPaths({ platform: 'darwin', env: {}, home });
  assert.equal(result.dataDir, `${home}/Library/Application Support/McpTunnelAccountManager`);
  assert.equal(result.tunnelConfigDir, `${home}/.config/tunnel-client`);
  assert.equal(result.tunnelClientBin, `${home}/.openai-tunnel/tunnel-client`);
  assert.equal(result.antigravityPython, `${home}/.antigravity-mcp/venv/bin/python`);
  assert.equal(result.antigravityAppDir, `${home}/.antigravity-mcp/app`);
  assert.equal(result.antigravityStateDir, `${home}/Library/Application Support/antigravity-mcp`);
  assert.equal(result.overleafConfigDir, `${home}/.config/overleaf-mcp`);
});

test('platform defaults honor explicit legacy fixture roots and valid XDG roots', () => {
  const win = resolvePlatformPaths({ platform: 'win32', env: {
    USERPROFILE: 'C:\\Users\\Case User', APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'E:\\Local'
  } });
  assert.equal(win.tunnelConfigDir, 'D:\\Roaming\\tunnel-client');
  assert.equal(win.dataDir, 'E:\\Local\\McpTunnelAccountManager');
  assert.equal(win.tunnelClientBin, 'C:\\Users\\Case User\\.openai-tunnel\\tunnel-client.exe');
  assert.equal(win.antigravityPython, 'C:\\Users\\Case User\\.antigravity-mcp\\venv\\Scripts\\python.exe');
  const linux = resolvePlatformPaths({ platform: 'linux', home: '/home/Case', env: {
    XDG_CONFIG_HOME: '/custom/Config', XDG_DATA_HOME: '/custom/Data', XDG_STATE_HOME: '/custom/State'
  } });
  assert.equal(linux.tunnelConfigDir, '/custom/Config/tunnel-client');
  assert.equal(linux.dataDir, '/custom/Data/McpTunnelAccountManager');
  assert.equal(linux.antigravityStateDir, '/custom/State/antigravity-mcp');
  const explicit = resolvePlatformPaths({ platform: 'darwin', home: '/Users/Unused', env: {
    USERPROFILE: '/fixture/User', APPDATA: '/fixture/Roaming', LOCALAPPDATA: '/fixture/Local'
  } });
  assert.equal(explicit.userProfile, '/fixture/User');
  assert.equal(explicit.tunnelConfigDir, '/fixture/Roaming/tunnel-client');
  assert.equal(explicit.dataDir, '/fixture/Local/McpTunnelAccountManager');
  assert.equal(resolvePlatformPaths({ platform: 'linux', home: '/home/Test', env: { XDG_CONFIG_HOME: 'relative' } }).appData, '/home/Test/.config');
});

test('POSIX carrier receipts preserve executable case while Windows receipts remain compatible', async t => {
  const vault = createVault({ dataDir: workspace(t) });
  t.after(() => vault.close());
  const now = Date.now();
  const context = {
    action: 'restart', serviceId: 'antigravity-mcp', serviceRevision: 1,
    profileId: 'example', sessionBinding: 'test-session', idempotencyKey: 'test-key',
    identity: { pid: 1234, startedAt: new Date(now - 1000).toISOString(), executablePath: '/Users/Case/Tools/tunnel-client', verified: true }
  };
  const token = await issueCarrierConfirmation(vault, context, now);
  assert.equal(await verifyCarrierConfirmation(vault, token, context, now), true);
  assert.equal(await verifyCarrierConfirmation(vault, token, { ...context, identity: { ...context.identity, executablePath: '/users/case/tools/tunnel-client' } }, now), false);
  const windows = { ...context, identity: { ...context.identity, executablePath: 'C:\\Program Files\\Tunnel\\tunnel-client.exe' } };
  const winToken = await issueCarrierConfirmation(vault, windows, now);
  assert.equal(await verifyCarrierConfirmation(vault, winToken, { ...windows, identity: { ...windows.identity, executablePath: 'c:/program files/tunnel/tunnel-client.exe' } }, now), true);
  await assert.rejects(issueCarrierConfirmation(vault, { ...context, identity: { ...context.identity, executablePath: 'relative/tunnel-client' } }, now), { code: 'PROCESS_IDENTITY_UNVERIFIED' });
});

test('vault tightens an existing directory and key without changing AES-GCM envelopes', posixOnly, t => {
  const dataDir = workspace(t);
  fs.chmodSync(dataDir, 0o755);
  const keyPath = path.join(dataDir, 'master.key');
  const existing = Buffer.alloc(32, 0x41);
  fs.writeFileSync(keyPath, existing, { mode: 0o644 });
  fs.chmodSync(keyPath, 0o644);
  const vault = createVault({ dataDir });
  assert.equal(mode(dataDir), 0o700);
  assert.equal(mode(keyPath), 0o600);
  assert.deepEqual(fs.readFileSync(keyPath), existing);
  const envelope = vault.seal({ sample: 'fixture' }, 'platform-test');
  assert.equal(envelope.v, 2);
  vault.close();
  const reopened = createVault({ dataDir });
  assert.deepEqual(reopened.unseal(envelope, 'platform-test'), { sample: 'fixture' });
  reopened.close();
});

test('vault refuses key symlinks, nonregular keys, and malformed lengths', posixOnly, t => {
  const root = workspace(t);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const keyPath = path.join(dataDir, 'master.key');
  const outside = path.join(root, 'untouched-key');
  fs.writeFileSync(outside, Buffer.alloc(32, 0x52), { mode: 0o640 });
  fs.chmodSync(outside, 0o640);
  fs.symlinkSync(outside, keyPath);
  assert.throws(() => createVault({ dataDir }), { code: 'UNSAFE_PRIVATE_PATH' });
  assert.equal(mode(outside), 0o640, 'a symlink target must not be chmod-ed');
  fs.unlinkSync(keyPath);
  fs.mkdirSync(keyPath);
  assert.throws(() => createVault({ dataDir }), { code: 'UNSAFE_PRIVATE_PATH' });
  fs.rmdirSync(keyPath);
  fs.writeFileSync(keyPath, Buffer.alloc(31));
  assert.throws(() => createVault({ dataDir }), /expected 32 bytes, got 31/);
});

test('vault refuses a key whose open descriptor belongs to a different user', posixOnly, t => {
  const dataDir = workspace(t);
  fs.writeFileSync(path.join(dataDir, 'master.key'), Buffer.alloc(32, 0x53));
  const fstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', descriptor => {
    const stat = fstat(descriptor);
    stat.uid = process.getuid() + 1;
    return stat;
  });
  assert.throws(() => createVault({ dataDir }), /owner does not match the current user/);
});

test('authentication files are private on initial write and on reopening', posixOnly, async t => {
  const dataDir = workspace(t);
  const bootstrapPath = path.join(dataDir, 'bootstrap-code.txt');
  const legacyPath = path.join(dataDir, 'bootstrap.secret');
  for (const target of [bootstrapPath, legacyPath]) {
    fs.writeFileSync(target, 'synthetic-bootstrap\n');
    fs.chmodSync(target, 0o644);
  }
  const security = createSecurity({ dataDir });
  assert.equal(mode(bootstrapPath), 0o600);
  assert.equal(mode(legacyPath), 0o600);
  await security.setup({ headers: { host: '127.0.0.1:17642' } }, {}, { bootstrapCode: 'synthetic-bootstrap', password: 'synthetic-password' });
  const authPath = path.join(dataDir, 'auth.json');
  assert.equal(mode(authPath), 0o600);
  fs.chmodSync(authPath, 0o644);
  createSecurity({ dataDir });
  assert.equal(mode(authPath), 0o600);
});

test('Mac location reveal uses /usr/bin/open with a literal directory argument', async t => {
  const root = workspace(t);
  const folder = path.join(root, "Case User ' space; $literal");
  fs.mkdirSync(folder);
  const config = path.join(folder, 'overleaf.yaml');
  fs.writeFileSync(config, 'fixture: true\n');
  const calls = [];
  const resolver = createMcpLocationResolver({ platform: 'darwin', env: {}, home: root,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }
  });
  const revealed = await resolver.reveal({ id: 'mcp_example', binding: { type: 'http' }, locations: { sourceConfigPath: config } }, 'sourceConfig');
  assert.equal(revealed.opened, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/open');
  assert.deepEqual(calls[0].args, [fs.realpathSync(folder)]);
  assert.equal(calls[0].options.shell, false);
});

test('failed and unsupported directory reveal never reports opened', async t => {
  const root = workspace(t);
  const config = path.join(root, 'config.yaml');
  fs.writeFileSync(config, 'fixture: true\n');
  const definition = { id: 'mcp_example', binding: { type: 'http' }, locations: { sourceConfigPath: config } };
  const failed = createMcpLocationResolver({ platform: 'darwin', env: {}, home: root,
    spawn() {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 7));
      return child;
    }
  });
  await assert.rejects(failed.reveal(definition, 'sourceConfig'), { code: 'REVEAL_FAILED' });
  const unsupported = createMcpLocationResolver({ platform: 'freebsd', env: {}, home: root });
  await assert.rejects(unsupported.reveal(definition, 'sourceConfig'), { code: 'REVEAL_UNSUPPORTED' });
});

test('Mac discovery and locations share the actual XDG tunnel config directory', async t => {
  const home = workspace(t);
  const env = { XDG_CONFIG_HOME: path.join(home, 'Custom Config') };
  const defaults = resolvePlatformPaths({ platform: 'darwin', env, home });
  fs.mkdirSync(defaults.tunnelConfigDir, { recursive: true });
  const config = path.join(defaults.tunnelConfigDir, 'antigravity-local.yaml');
  fs.writeFileSync(config, 'control_plane:\n  tunnel_id: tunnel_fixture\n  api_key: synthetic-key\nmcp:\n  commands:\n    - command: "python -m antigravity_mcp"\n');
  const resolver = createMcpLocationResolver({ platform: 'darwin', env, home });
  const described = await resolver.describe({ id: 'antigravity-mcp', binding: { type: 'stdio', executable: 'missing-fixture-python' } });
  assert.equal(described.sourceConfigPath, config);
  const discovery = createMcpDiscovery({ platform: 'darwin', env, home });
  const found = await discovery.scan();
  assert.ok(found.some(candidate => candidate.sourceConfigPath === fs.realpathSync(config)));
});

test('POSIX discovery preserves distinct path case and excludes sibling-directory symlinks', posixOnly, async t => {
  const home = workspace(t);
  const defaults = resolvePlatformPaths({ platform: 'darwin', env: {}, home });
  fs.mkdirSync(defaults.tunnelConfigDir, { recursive: true });
  const upper = path.join(defaults.tunnelConfigDir, 'Case.yaml');
  const lower = path.join(defaults.tunnelConfigDir, 'case.yaml');
  const contents = 'server:\n  command: "node fixture.mjs"\n';
  fs.writeFileSync(upper, contents);
  const caseSensitive = !fs.existsSync(lower);
  if (caseSensitive) fs.writeFileSync(lower, contents);
  const sibling = `${defaults.tunnelConfigDir}-other`;
  fs.mkdirSync(sibling);
  const outside = path.join(sibling, 'outside.yaml');
  fs.writeFileSync(outside, contents);
  fs.symlinkSync(outside, path.join(defaults.tunnelConfigDir, 'linked.yaml'));
  const found = await createMcpDiscovery({ platform: 'darwin', env: {}, home }).scan();
  assert.equal(found.some(candidate => candidate.sourceConfigPath === outside), false);
  if (caseSensitive) {
    const matches = found.filter(candidate => [upper, lower].includes(candidate.sourceConfigPath));
    assert.equal(matches.length, 2);
    assert.notEqual(matches[0].id, matches[1].id);
  } else {
    assert.ok(found.some(candidate => candidate.sourceConfigPath === fs.realpathSync(upper)));
  }
});

test('default Mac parallel providers read only their dedicated instance scope', async t => {
  const home = workspace(t);
  const defaults = resolvePlatformPaths({ platform: 'darwin', env: {}, home });
  const inspected = [];
  const controller = {
    async inspect(instanceId, options) { inspected.push({ instanceId, options }); return { running: true, pid: 4321, startedAt: '2026-11-13T00:00:00.000Z' }; },
    async verify(record) { return { valid: record.pid === 4321 }; }
  };
  const provider = createInstanceAdapterProvider({ dataDir: defaults.dataDir, platform: 'darwin', env: {}, home, processController: controller });
  assert.equal(provider.dataDir, defaults.instanceDataDir);
  const adapter = await provider({}, 'antigravity-mcp', 'Case Account');
  assert.equal(adapter.dataDir, defaults.instanceDataDir);
  assert.ok(adapter.processPath.startsWith(`${defaults.instanceDataDir}${path.sep}`));
  assert.ok(adapter.configPath.startsWith(`${defaults.instanceDataDir}${path.sep}`));
  const oldRecord = path.join(defaults.dataDir, 'runtime', `${adapter.instanceId}-process.json`);
  fs.mkdirSync(path.dirname(oldRecord), { recursive: true });
  fs.writeFileSync(oldRecord, JSON.stringify({ pid: 9999, operationId: 'unrelated-root-record' }));
  adapter._writeProcessRecord({ pid: 4321, operationId: 'instance-record', instanceId: adapter.instanceId });
  const status = await adapter.inspect();
  assert.equal(status.state, 'running');
  assert.equal(status.pid, 4321);
  assert.equal(status.operationId, 'instance-record');
  assert.equal(status.processPath, adapter.processPath);
  assert.equal(inspected[0].instanceId, adapter.instanceId);
  assert.equal(inspected[0].options.allowExternalScan, false);
  assert.equal(JSON.parse(fs.readFileSync(oldRecord)).pid, 9999);
  const template = adapter._buildInstanceTemplate({ args: ['run', '--profile-file', '/wrong/shared.yaml'], env: {} }, {});
  const index = template.args.indexOf('--profile-file');
  assert.equal(template.args[index + 1], adapter.configPath);
  assert.equal(template.args.includes('/wrong/shared.yaml'), false);
  assert.equal(template.args.includes('--profile'), false);
});

test('Mac instance guard keeps shared profiles out and permits only its dedicated default-data scope', t => {
  const home = workspace(t);
  const options = { platform: 'darwin', env: {}, home };
  const defaults = resolvePlatformPaths(options);
  assert.equal(assertIsolatedInstanceDataDir(defaults.dataDir, options), defaults.instanceDataDir);
  assert.equal(assertIsolatedInstanceDataDir(defaults.instanceDataDir, options), defaults.instanceDataDir);
  assert.throws(() => assertIsolatedInstanceDataDir(defaults.tunnelConfigDir, options), { code: 'INVALID_INSTANCE' });
  assert.throws(() => assertIsolatedInstanceDataDir(path.join(defaults.dataDir, 'elsewhere'), options), { code: 'INVALID_INSTANCE' });
  const legacy = { platform: 'darwin', env: { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') }, home };
  const legacyPaths = resolvePlatformPaths(legacy);
  assert.throws(() => assertIsolatedInstanceDataDir(legacyPaths.dataDir, legacy), { code: 'INVALID_INSTANCE' });
});

test('realResolve preserves a filesystem root while appending nonexistent ancestors', posixOnly, () => {
  const missing = '/MCP-NONEXISTENT-ROOT-FIXTURE/Case-Sensitive/child';
  assert.equal(realResolve(missing), missing);
});

test('instance argument rewriting always discards inherited profile-file bindings', () => {
  const input = ['run', '--profile-file=/shared/one.yaml', '--profile-file', '/shared/two.yaml', '--profile', 'shared'];
  const common = { profileDir: '/private/profiles', profileName: 'instance', healthUrlFile: '/private/health.url' };
  const mac = rewriteInstanceLaunchArgs(input, { ...common, platform: 'darwin' });
  assert.deepEqual(mac.slice(0, 3), ['run', '--profile-file', '/private/profiles/instance.yaml']);
  assert.equal(mac.some(arg => arg.includes('/shared/')), false);
  const windows = rewriteInstanceLaunchArgs(input, { ...common, platform: 'win32' });
  assert.equal(windows.some(arg => arg.startsWith('--profile-file')), false);
  assert.deepEqual(windows.slice(0, 5), ['run', '--profile-dir', '/private/profiles', '--profile', 'instance']);
});
