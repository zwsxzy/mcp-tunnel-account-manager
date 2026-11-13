import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInstaller, parseArguments, quoteCommandArgument, runProcess, SOURCES, tunnelProfile, versionAtLeast } from '../scripts/install-components-macos.mjs';
import { probeMcpStdio } from '../scripts/smoke-components-macos.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(repository, 'artifacts', 'mac-port-20261113', 'installer-fixtures');
const probe = spawnSync('python3', ['-c', 'import sys,venv;print(sys.executable)'], { encoding: 'utf8' });
const python = probe.status === 0 ? probe.stdout.trim() : null;
const requiresPosixPython = { skip: process.platform === 'win32' || !python ? 'These isolated POSIX venv fixtures need python3; they are not macOS hardware claims.' : false };
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const officialTunnelVersion = '0.0.20+c2144b0904980bcbae2636cdca4f4167e9818e0b';

async function write(file, content, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode });
}

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function snapshot(directory) {
  if (!(await exists(directory))) return {};
  const values = {};
  async function walk(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) values[name] = `link:${await fs.readlink(file)}`;
      else if (entry.isDirectory()) { values[`${name}/`] = 'directory'; await walk(file, name); }
      else values[name] = hash(await fs.readFile(file));
    }
  }
  await walk(directory);
  return values;
}

async function fixture(t, changes = {}) {
  await fs.mkdir(artifacts, { recursive: true });
  const base = await fs.mkdtemp(path.join(artifacts, 'case-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "中文 用户 O'Reilly $(touch SHOULD_NOT_EXIST)");
  const brewPrefix = path.join(base, 'Homebrew opt', 'tunnel-client');
  const brew = path.join(base, 'tools with spaces', 'brew');
  const npm = path.join(base, 'tools with spaces', 'npm');
  const git = path.join(base, 'tools with spaces', 'git');
  const calls = []; const logs = []; const downloads = []; const sleeps = [];
  const status = { brewInstalled: false, failNpm: false, badNpmIntegrity: false, downloadFailures: 0, missing: new Set(), ...changes };
  await write(path.join(brewPrefix, 'libexec', 'tunnel-client'), 'fixture executable, never run as a Mac program\n', 0o700);
  await write(path.join(brewPrefix, 'libexec', 'cloudflared'), 'fixture companion\n', 0o700);
  await write(path.join(brewPrefix, 'libexec', 'cloudflared-manifest.json'), '{"version":"fixture"}\n');
  await write(path.join(brewPrefix, 'bin', 'tunnel-client'), '#!/bin/sh\nexec "$0/../../libexec/tunnel-client" "$@"\n', 0o700);
  const archiveFile = path.join(base, 'antigravity-source.tar.gz');
  const rootName = `antigravity-mcp-fork-${SOURCES.antigravityCommit}`;
  const contents = {
    [`${rootName}/src/antigravity_mcp/__init__.py`]: '__version__ = "1.1.0.post1"\n',
    [`${rootName}/src/antigravity_mcp/__main__.py`]: 'import sys\nprint("fixture", file=sys.stderr)\n',
    [`${rootName}/src/antigravity_mcp/workflow_settings.json`]: '{"user_setting": "default"}\n',
    [`${rootName}/LICENSE`]: 'fixture license\n',
    [`${rootName}/README.md`]: 'fixture source\n',
    [`${rootName}/pyproject.toml`]: '[project]\ndependencies = []\n',
    ...changes.archiveContents,
  };
  if (python) {
    const created = await runProcess(python, ['-c', 'import io,json,tarfile,sys\nwith tarfile.open(sys.argv[1], "w:gz") as tar:\n for name,text in json.loads(sys.argv[2]).items():\n  data=text.encode("utf-8"); info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644;tar.addfile(info,io.BytesIO(data))', archiveFile, JSON.stringify(contents)]);
    assert.equal(created.code, 0, created.stderr);
  } else await write(archiveFile, 'fixture');
  const antigravityArchive = await fs.readFile(archiveFile);
  const overleafArchive = Buffer.from('fixture npm archive; the npm process is injected, not executed');
  const sources = {
    overleafUrl: 'https://fixtures.invalid/overleaf-0.3.9.tgz',
    overleafIntegrity: `sha512-${crypto.createHash('sha512').update(overleafArchive).digest('base64')}`,
    antigravityUrl: 'https://fixtures.invalid/antigravity.tar.gz',
    antigravitySha256: hash(antigravityArchive),
  };
  const injectedRun = async (executable, args, options = {}) => {
    assert.ok(Array.isArray(args));
    assert.ok(args.every((item) => typeof item === 'string'));
    assert.notEqual(options.shell, true);
    calls.push({ executable, args: [...args], cwd: options.cwd });
    if (executable === brew) {
      if (args[0] === '--version') return { code: 0, stdout: 'Homebrew fixture\n', stderr: '' };
      if (args[0] === 'list') return { code: status.brewInstalled ? 0 : 1, stdout: status.brewInstalled ? (status.brewVersions ?? 'tunnel-client 0.0.20\n') : '', stderr: '' };
      if (['install', 'reinstall'].includes(args[0])) { status.brewInstalled = true; return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === '--prefix') return { code: 0, stdout: `${brewPrefix}\n`, stderr: '' };
      throw new Error(`Unexpected Homebrew fixture call: ${JSON.stringify(args)}`);
    }
    if (executable === git) return { code: 0, stdout: 'git version fixture\n', stderr: '' };
    if (executable === path.join(brewPrefix, 'libexec', 'tunnel-client')) return { code: 0, stdout: status.tunnelVersionOutput ?? 'tunnel-client v0.0.20\n', stderr: '' };
    if (executable === npm) {
      if (args[0] === '--version') return { code: 0, stdout: '11.4.0\n', stderr: '' };
      assert.ok(args.includes('--ignore-scripts'));
      assert.ok(args.includes('--registry=https://registry.npmjs.org'));
      assert.ok(path.isAbsolute(options.cwd));
      if (status.failNpm) return { code: 73, stdout: '', stderr: 'fixture registry failure' };
      const packageRoot = path.join(options.cwd, 'node_modules', 'mcp-server-overleaf');
      await write(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'mcp-server-overleaf', version: '0.3.9' }));
      await write(path.join(packageRoot, 'dist', 'index.js'), 'if (process.argv.includes("--version")) process.stdout.write("0.3.9\\n");\n');
      await write(path.join(options.cwd, 'node_modules', 'dependency', 'index.js'), '// dependency\n');
      await fs.mkdir(path.join(options.cwd, 'node_modules', '.bin'), { recursive: true });
      await fs.symlink('../mcp-server-overleaf/dist/index.js', path.join(options.cwd, 'node_modules', '.bin', 'overleaf'));
      await write(path.join(options.cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/mcp-server-overleaf': { version: '0.3.9', integrity: status.badNpmIntegrity ? 'sha512-wrong' : sources.overleafIntegrity } } }));
      return { code: 0, stdout: 'installed fixture package\n', stderr: '' };
    }
    if (executable === process.execPath && args[1] === '--version') return runProcess(executable, args, options);
    if (executable === python && args[0] === '-m' && args[1] === 'venv' && status.failVenvOnce) {
      status.failVenvOnce = false;
      await write(path.join(args.at(-1), 'partial-creation.txt'), 'preserve failed creation');
      return { code: 27, stdout: '', stderr: 'fixture venv creation interrupted' };
    }
    if (executable === python || executable === path.join(home, '.antigravity-mcp', 'venv', 'bin', 'python')) return runProcess(executable, args, options);
    throw new Error(`Unexpected process in isolated fixture: ${executable} ${JSON.stringify(args)}`);
  };
  const dependencies = {
    platform: 'darwin', arch: 'arm64', nodeVersion: '22.14.0', nodePath: process.execPath,
    env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' }, sources, run: injectedRun,
    findExecutable: async (name) => {
      if (status.missing.has(name)) return null;
      if (name === 'brew') return brew;
      if (name === 'npm') return npm;
      if (name === 'git') return git;
      if (/^python/.test(name)) return status.missing.has('python') ? null : python;
      if (path.isAbsolute(name)) {
        try { await fs.access(name, fsConstants.X_OK); return name; } catch { return null; }
      }
      return null;
    },
    download: async (url, file) => {
      downloads.push(url);
      if (status.downloadFailures-- > 0) { await write(file, 'partial transfer'); throw new Error('fixture HTTP 503'); }
      if (status.badDownload) { await write(file, 'wrong bytes'); return; }
      await write(file, url === sources.antigravityUrl ? antigravityArchive : overleafArchive);
    },
    sleep: async (ms) => { sleeps.push(ms); },
    log: (message) => logs.push(message),
  };
  return { base, home, brewPrefix, calls, logs, downloads, sleeps, status, dependencies, sources, execute: (options = {}, deps = {}) => createInstaller({ ...dependencies, ...deps }).execute({ homeDir: home, ...options }) };
}

test('macOS CLI pins reviewed sources, accepts component aliases and rejects ambiguous flags', () => {
  assert.equal(SOURCES.antigravityCommit, '02df3ed95aae0c5103f5db7b332d0c4e6f1eec50');
  assert.equal(SOURCES.antigravitySha256, '1fec6740ac07a0202e92ba8bc657ce35de2b9726feb29d36ee9c15723b79a921');
  assert.equal(SOURCES.overleafIntegrity, 'sha512-j+NsA9bWyyNHM5hUqdn1+aAmGBiYvs4Rlslwi/BEoP/vfs3Gy8OXh51WMG/8cIKV+e0BMFsMFH+d4Exu+OyNPg==');
  assert.deepEqual(parseArguments(['--component', 'tunnel,overleaf-mcp', '--component', 'antigravity']).components, ['tunnel-client', 'overleaf-mcp', 'antigravity-mcp']);
  assert.throws(() => parseArguments(['--force', '--verify-only']), /不能同时/);
  assert.throws(() => parseArguments(['--component', 'all,typo']), /未知组件/);
  assert.throws(() => parseArguments(['--component']), /缺少参数/);
  assert.throws(() => parseArguments(['--platform', 'darwin']), /未知参数/);
  assert.equal(versionAtLeast('22.14.0', '22.14.0'), true);
  assert.equal(versionAtLeast('22.13.9', '22.14.0'), false);
  assert.equal(versionAtLeast('broken', '3.9.0'), false);
});

test('real CLI rejects Linux without creating a user profile', { skip: process.platform !== 'linux' }, async (t) => {
  await fs.mkdir(artifacts, { recursive: true });
  const base = await fs.mkdtemp(path.join(artifacts, 'cli-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'must-not-exist');
  const outcome = spawnSync(process.execPath, [path.join(repository, 'scripts', 'install-components-macos.mjs'), '--home-dir', home], { encoding: 'utf8' });
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /只支持 macOS/);
  assert.equal(await exists(home), false);
  const wrapper = spawnSync('/bin/bash', [path.join(repository, 'Install-Components.command'), '--verify-only'], { encoding: 'utf8' });
  assert.equal(wrapper.status, 1);
  assert.match(wrapper.stderr, /只支持 macOS/);
});

test('isolated POSIX fixture installs all components in a Unicode, space and quote home', requiresPosixPython, async (t) => {
  const f = await fixture(t);
  const outcome = await f.execute();
  assert.equal(outcome.code, 0, f.logs.join('\n'));
  assert.equal(await fs.readlink(outcome.locations.tunnelBinary), path.join(f.brewPrefix, 'libexec', 'tunnel-client'));
  assert.equal(outcome.results[0].version, '0.0.20');
  assert.equal(outcome.results[0].wrapper, path.join(f.brewPrefix, 'bin', 'tunnel-client'));
  assert.equal(await exists(path.join(path.dirname(await fs.realpath(outcome.locations.tunnelBinary)), 'cloudflared-manifest.json')), true);
  const state = JSON.parse(await fs.readFile(path.join(f.home, '.mcp-tunnel-kit', 'install-state-macos.json')));
  assert.equal(state.components['antigravity-mcp'].commit, SOURCES.antigravityCommit);
  assert.equal(state.components['antigravity-mcp'].stateDir, path.join(f.home, 'Library', 'Application Support', 'antigravity-mcp'));
  const layout = await runProcess(outcome.locations.venvPython, ['-c', 'import json,sysconfig,antigravity_mcp,pathlib; print(json.dumps({"site":sysconfig.get_path("purelib"),"package":str(pathlib.Path(antigravity_mcp.__file__).resolve().parent)}))'], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(layout.code, 0, layout.stderr);
  const parsed = JSON.parse(layout.stdout);
  const pth = await fs.readFile(path.join(parsed.site, '_antigravity_mcp_src.pth'), 'utf8');
  assert.equal(pth.trim(), '../../../../app');
  assert.equal(parsed.package, path.join(outcome.locations.antigravityApp, 'antigravity_mcp'));
  for (const file of [outcome.locations.overleafProfile, outcome.locations.antigravityProfile]) {
    const yaml = await fs.readFile(file, 'utf8');
    assert.match(yaml, /  tunnel_id: ""/);
    assert.match(yaml, /^mcp:\n  commands:\n    - channel: main\n      command:/m);
    assert.doesNotMatch(yaml, /^env:|System\.Object\[\]/m);
  }
  assert.equal(await exists(path.join(repository, 'SHOULD_NOT_EXIST')), false);
  const second = await f.execute({ verifyOnly: true });
  assert.equal(second.code, 0, f.logs.join('\n'));
});

test('official Homebrew build metadata matches its release and remains in the installation record', requiresPosixPython, async (t) => {
  const output = `tunnel-client version ${officialTunnelVersion}\n`;
  const f = await fixture(t, { tunnelVersionOutput: output });
  const installed = await f.execute({ components: ['tunnel-client'] });
  assert.equal(installed.code, 0, f.logs.join('\n'));
  assert.equal(installed.results[0].version, officialTunnelVersion);
  assert.equal(installed.results[0].versionOutput, output.trim());
  const state = JSON.parse(await fs.readFile(path.join(f.home, '.mcp-tunnel-kit', 'install-state-macos.json')));
  assert.equal(state.components['tunnel-client'].version, officialTunnelVersion);
  assert.equal(state.components['tunnel-client'].versionOutput, output.trim());
  assert.equal(state.components['tunnel-client'].brewVersions, 'tunnel-client 0.0.20');
  assert.ok(f.logs.some((line) => line.includes(`[OK] tunnel-client ${officialTunnelVersion}`)));
});

test('Homebrew matching preserves release and prerelease identity while accepting formula revisions', requiresPosixPython, async (t) => {
  const cases = [
    ['0.0.20+001.build-7', '0.0.20_1', true],
    ['0.0.20-rc.1+build.7', '0.0.20-rc.1', true],
    ['0.0.19+build.7', '0.0.20', false],
    ['0.0.21+build.7', '0.0.20', false],
    ['0.0.20-rc.1+build.7', '0.0.20', false],
    ['0.0.20+build.7', '0.0.20-rc.1', false],
    ['0.0.20-rc.2+build.7', '0.0.20-rc.1', false],
  ];
  for (const [version, formulaVersion, expected] of cases) {
    const f = await fixture(t, { tunnelVersionOutput: `tunnel-client v${version}\n`, brewVersions: `tunnel-client ${formulaVersion}\n` });
    const outcome = await f.execute({ components: ['tunnel-client'] });
    assert.equal(outcome.ok, expected, `${version} vs ${formulaVersion}: ${f.logs.join('\n')}`);
    if (expected) assert.equal(outcome.results[0].version, version);
    else {
      assert.match(outcome.results[0].error, /与 Homebrew 记录不符/);
      assert.equal(await exists(outcome.locations.tunnelBinary), false);
    }
  }
});

test('malformed SemVer metadata cannot be truncated into an accepted tunnel-client release', requiresPosixPython, async (t) => {
  const f = await fixture(t);
  for (const version of ['0.0.20+', '0.0.20+build..7', '0.0.20+.build', '0.0.20+build.', '0.0.20+build_7', '0.0.20+build+7', '0.0.20+build!', '0.0.20+构建', '00.0.20+build', '0.0.20-01+build']) {
    f.status.tunnelVersionOutput = `tunnel-client v${version}\n`;
    const outcome = await f.execute({ components: ['tunnel-client'] });
    assert.equal(outcome.code, 1, version);
    assert.match(outcome.results[0].error, /无法识别 tunnel-client --version 输出/);
    assert.equal(await exists(outcome.locations.tunnelBinary), false);
  }
});

test('repeat install reuses components; force preserves personal files and settings', requiresPosixPython, async (t) => {
  const f = await fixture(t);
  const first = await f.execute();
  assert.equal(first.code, 0, f.logs.join('\n'));
  const downloads = f.downloads.length;
  const installCalls = () => f.calls.filter((call) => ['install', 'reinstall', 'ci'].includes(call.args[0])).length;
  const installs = installCalls();
  assert.equal((await f.execute()).code, 0, f.logs.join('\n'));
  assert.equal(f.downloads.length, downloads);
  assert.equal(installCalls(), installs);
  const personalFiles = {
    [path.join(f.home, '.openai-tunnel', 'tunnel.env')]: 'PRIVATE=value\n',
    [path.join(first.locations.overleafRuntime, 'personal notes.txt')]: 'keep my runtime file\n',
    [path.join(first.locations.antigravityApp, 'my workflow.py')]: 'my personal code\n',
    [path.join(first.locations.venv, 'my settings.ini')]: 'keep venv additions\n',
    [path.join(first.locations.antigravityApp, 'antigravity_mcp', 'workflow_settings.json')]: '{"user_setting":"custom"}\n',
  };
  for (const [file, content] of Object.entries(personalFiles)) await write(file, content);
  await fs.writeFile(first.locations.overleafEntry, '// personally edited entry that must be backed up\n');
  assert.equal((await f.execute({ force: true })).code, 0, f.logs.join('\n'));
  for (const [file, content] of Object.entries(personalFiles)) assert.equal(await fs.readFile(file, 'utf8'), content, file);
  assert.equal(await exists(path.join(first.locations.antigravityApp, 'antigravity_mcp', 'workflow_settings.json.suggested')), true);
  const backups = await snapshot(path.join(f.home, '.mcp-tunnel-kit', 'backups'));
  assert.ok(Object.values(backups).includes(hash(Buffer.from('// personally edited entry that must be backed up\n'))));
  assert.ok(f.calls.some((call) => call.args[0] === 'reinstall'));
  assert.ok(f.calls.some((call) => call.args[0] === 'ci'));
  assert.equal(f.downloads.length, downloads);
});

test('existing usable custom YAML stays byte-for-byte unchanged and receives a suggestion', requiresPosixPython, async (t) => {
  const f = await fixture(t);
  const yamlFile = path.join(f.home, '.config', 'tunnel-client', 'overleaf.yaml');
  const custom = tunnelProfile(`${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(path.join(f.home, 'my custom server.js'))}`).replace('tunnel_id: ""', 'tunnel_id: "existing-user-id"').replace("api_key: 'env:CONTROL_PLANE_API_KEY'", "api_key: 'file:/private/user-key'") + '# my comment\n';
  await write(yamlFile, custom);
  const outcome = await f.execute({ components: ['overleaf'] });
  assert.equal(outcome.code, 0, f.logs.join('\n'));
  assert.equal(await fs.readFile(yamlFile, 'utf8'), custom);
  assert.match(await fs.readFile(`${yamlFile}.suggested`, 'utf8'), /保留自己的凭据/);
  assert.equal((await f.execute({ components: ['overleaf'], force: true })).code, 0, f.logs.join('\n'));
  assert.equal(await fs.readFile(yamlFile, 'utf8'), custom);
});

test('broken existing YAML produces a nonzero result without overwriting credentials', requiresPosixPython, async (t) => {
  const f = await fixture(t);
  const yamlFile = path.join(f.home, '.config', 'tunnel-client', 'overleaf.yaml');
  const custom = tunnelProfile("'/missing/executable' '--stdio'").replace('tunnel_id: ""', 'tunnel_id: "keep-id"');
  await write(yamlFile, custom);
  const outcome = await f.execute({ components: ['overleaf'] });
  assert.equal(outcome.code, 1);
  assert.match(outcome.results[0].error, /合并 .suggested/);
  assert.equal(await fs.readFile(yamlFile, 'utf8'), custom);
  assert.equal(await exists(`${yamlFile}.suggested`), true);
});

test('verify-only has no filesystem mutations or install/download commands', requiresPosixPython, async (t) => {
  const f = await fixture(t, { tunnelVersionOutput: `tunnel-client version ${officialTunnelVersion}\n` });
  assert.equal((await f.execute()).code, 0, f.logs.join('\n'));
  const before = await snapshot(f.home);
  f.calls.length = 0; f.downloads.length = 0;
  const writeMethods = new Set(['appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'link', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile']);
  const readOnlyFs = new Proxy(fs, { get(target, property) {
    if (writeMethods.has(property)) return async () => { throw new Error(`verify-only attempted ${String(property)}`); };
    if (property === 'open') return async (_file, flags) => { throw new Error(`unexpected open in verification (${flags})`); };
    return target[property];
  } });
  const outcome = await f.execute({ verifyOnly: true }, { fs: readOnlyFs });
  assert.equal(outcome.code, 0, f.logs.join('\n'));
  assert.deepEqual(await snapshot(f.home), before);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.calls.some((call) => ['install', 'reinstall', 'ci'].includes(call.args[0]) || call.args.includes('venv')), false);
});

test('download retries are bounded and digest failure never promotes files', requiresPosixPython, async (t) => {
  const f = await fixture(t, { downloadFailures: 2 });
  assert.equal((await f.execute({ components: ['antigravity'] })).code, 0, f.logs.join('\n'));
  assert.equal(f.downloads.length, 3);
  assert.deepEqual(f.sleeps, [500, 1000]);
  const bad = await fixture(t, { badDownload: true });
  const rejected = await bad.execute({ components: ['antigravity'] });
  assert.equal(rejected.code, 1);
  assert.match(rejected.results[0].error, /sha256 校验失败/);
  assert.equal(bad.downloads.length, 1, 'checksum failures are not blindly retried');
  assert.equal(await exists(path.join(bad.home, '.antigravity-mcp')), false);
  const failed = await fixture(t, { downloadFailures: 20 });
  assert.equal((await failed.execute({ components: ['antigravity'] })).code, 1);
  assert.equal(failed.downloads.length, 3);
});

test('npm command and integrity failures leave existing user content untouched; retry works', requiresPosixPython, async (t) => {
  for (const failure of ['failNpm', 'badNpmIntegrity']) {
    const f = await fixture(t, { [failure]: true });
    const personal = path.join(f.home, '.overleaf-mcp', 'runtime', 'important.txt');
    await write(personal, 'must survive a failed installation');
    const before = await snapshot(path.dirname(personal));
    const failed = await f.execute({ components: ['overleaf'] });
    assert.equal(failed.code, 1);
    assert.match(failed.results[0].error, failure === 'failNpm' ? /退出码 73/ : /integrity 不符/);
    assert.deepEqual(await snapshot(path.dirname(personal)), before);
    f.status[failure] = false;
    assert.equal((await f.execute({ components: ['overleaf'] })).code, 0, f.logs.join('\n'));
    assert.equal(await fs.readFile(personal, 'utf8'), 'must survive a failed installation');
    assert.equal(f.downloads.length, 1, 'retry reuses only the already verified archive');
  }
});

test('prerequisite failures are actionable and occur before creating the user profile', requiresPosixPython, async (t) => {
  for (const [missing, expected] of [['brew', /Homebrew/], ['git', /Command Line Tools/], ['python', /Python >= 3.9/], ['npm', /包含 npm/]]) {
    const f = await fixture(t, { missing: new Set([missing]) });
    await assert.rejects(f.execute(), expected);
    assert.equal(await exists(f.home), false);
  }
  const f = await fixture(t);
  await assert.rejects(f.execute({}, { nodeVersion: '22.13.9' }), /Node.js 22.13.9 版本过低/);
  assert.equal(await exists(f.home), false);
});

test('archive traversal is rejected before extraction can write outside staging', requiresPosixPython, async (t) => {
  const f = await fixture(t, { archiveContents: { '../../escaped.txt': 'do not extract' } });
  const outcome = await f.execute({ components: ['antigravity'] });
  assert.equal(outcome.code, 1);
  assert.match(outcome.results[0].error, /unsafe archive path/);
  assert.equal(await exists(path.join(f.home, '.mcp-tunnel-kit', 'escaped.txt')), false);
  assert.equal(await exists(path.join(f.home, '.antigravity-mcp')), false);
});

test('an interrupted new venv is preserved under a unique name and retry can succeed', requiresPosixPython, async (t) => {
  const f = await fixture(t, { failVenvOnce: true });
  const failed = await f.execute({ components: ['antigravity'] });
  assert.equal(failed.code, 1);
  assert.match(failed.results[0].error, /退出码 27/);
  const root = path.join(f.home, '.antigravity-mcp');
  const incomplete = (await fs.readdir(root)).find((name) => name.startsWith('venv.incomplete-'));
  assert.ok(incomplete);
  assert.equal(await fs.readFile(path.join(root, incomplete, 'partial-creation.txt'), 'utf8'), 'preserve failed creation');
  assert.equal(await exists(path.join(root, 'venv')), false);
  assert.equal((await f.execute({ components: ['antigravity'] })).code, 0, f.logs.join('\n'));
  assert.equal(await exists(path.join(root, incomplete, 'partial-creation.txt')), true);
});

test('a symlinked existing runtime is preserved and never followed for installation', requiresPosixPython, async (t) => {
  const f = await fixture(t);
  const external = path.join(f.base, 'external user files');
  await write(path.join(external, 'keep.txt'), 'outside destination');
  await fs.mkdir(path.join(f.home, '.overleaf-mcp'), { recursive: true });
  await fs.symlink(external, path.join(f.home, '.overleaf-mcp', 'runtime'));
  const before = await snapshot(external);
  const outcome = await f.execute({ components: ['overleaf'] });
  assert.equal(outcome.code, 1);
  assert.match(outcome.results[0].error, /目标目录不是普通目录/);
  assert.deepEqual(await snapshot(external), before);
});

test('process timeout has a nonzero status and bounded completion', { skip: process.platform === 'win32' }, async () => {
  const started = Date.now();
  const outcome = await runProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(outcome.code, 124);
  assert.equal(outcome.timedOut, true);
  assert.ok(Date.now() - started < 5000);
});

test('stdio smoke checks initialize and catalog only, and rejects a protocol error', async () => {
  const server = `let initialized=false,buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\\n'))>=0){const q=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);let result;if(q.method==='initialize'){result={protocolVersion:'2024-11-05',serverInfo:{version:'1.2.3'}};}else if(q.method==='notifications/initialized'){initialized=true;continue;}else if(q.method==='tools/list'&&initialized){result={tools:[{name:'fixture_readonly'}]};}else{process.exit(73);}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});`;
  const result = await probeMcpStdio({ executable: process.execPath, args: ['-e', server], env: process.env, expectedVersion: '1.2.3' });
  assert.deepEqual(result.toolNames, ['fixture_readonly']);
  const bad = 'process.stdin.once("data",()=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,error:{code:-32602,message:"fixture rejected"}})+"\\n"));';
  await assert.rejects(probeMcpStdio({ executable: process.execPath, args: ['-e', bad], env: process.env, expectedVersion: '1.2.3' }), /fixture rejected/);
});
