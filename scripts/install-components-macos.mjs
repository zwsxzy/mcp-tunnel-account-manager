#!/usr/bin/env node
/**
 * Native macOS component installer. No npm dependencies are needed to run it.
 * The CLI always checks the real platform. Dependency injection is only exposed
 * by createInstaller() for isolated fixtures; it is not an environment bypass.
 */
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SOURCES = Object.freeze({
  tunnelFormula: 'openai/tools/tunnel-client',
  overleafPackage: 'mcp-server-overleaf',
  overleafVersion: '0.3.9',
  overleafIntegrity: 'sha512-j+NsA9bWyyNHM5hUqdn1+aAmGBiYvs4Rlslwi/BEoP/vfs3Gy8OXh51WMG/8cIKV+e0BMFsMFH+d4Exu+OyNPg==',
  overleafUrl: 'https://registry.npmjs.org/mcp-server-overleaf/-/mcp-server-overleaf-0.3.9.tgz',
  antigravityRepository: 'https://github.com/zwsxzy/antigravity-mcp-fork',
  antigravityVersion: '1.1.0.post1',
  antigravityCommit: '02df3ed95aae0c5103f5db7b332d0c4e6f1eec50',
  antigravitySha256: '1fec6740ac07a0202e92ba8bc657ce35de2b9726feb29d36ee9c15723b79a921',
  antigravityUrl: 'https://codeload.github.com/zwsxzy/antigravity-mcp-fork/tar.gz/02df3ed95aae0c5103f5db7b332d0c4e6f1eec50',
});
const COMPONENTS = ['tunnel-client', 'overleaf-mcp', 'antigravity-mcp'];
const ALIASES = { tunnel: 'tunnel-client', overleaf: 'overleaf-mcp', antigravity: 'antigravity-mcp' };
const NODE_MINIMUM = '22.14.0';
const PYTHON_MINIMUM = '3.9.0';
const MAX_OUTPUT = 2 * 1024 * 1024;

export function versionAtLeast(actual, minimum) {
  const match = String(actual).match(/^(?:v|Python\s+)?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const a = match.slice(1).map((x) => Number(x || 0));
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== (b[i] || 0)) return a[i] > (b[i] || 0);
  }
  return true;
}

export function parseArguments(args) {
  const options = { components: [], force: false, verifyOnly: false };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--force') options.force = true;
    else if (flag === '--verify-only') options.verifyOnly = true;
    else if (flag === '--yes') { /* All installer actions are already noninteractive. */ }
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (['--component', '--home-dir', '--config-dir'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少参数。`);
      if (flag === '--component') options.components.push(...value.split(','));
      else options[flag === '--home-dir' ? 'homeDir' : 'configDir'] = value;
    } else throw new Error(`未知参数：${flag}；使用 --help 查看用法。`);
  }
  options.components = normalizeComponents(options.components);
  if (options.force && options.verifyOnly) throw new Error('--force 与 --verify-only 不能同时使用。');
  return options;
}

function normalizeComponents(values = []) {
  const normalized = values.map((value) => ALIASES[value] || value);
  for (const id of normalized) {
    if (id !== 'all' && !COMPONENTS.includes(id)) throw new Error(`未知组件：${id}`);
  }
  return !normalized.length || normalized.includes('all') ? [...COMPONENTS] : [...new Set(normalized)];
}

export function quoteCommandArgument(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('命令参数不能含 NUL 或换行。');
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function tunnelProfile(command) {
  const scalar = `'${command.replaceAll("'", "''")}'`;
  return [
    'config_version: 1', 'control_plane:', "  base_url: 'https://api.openai.com'",
    '  tunnel_id: ""', "  api_key: 'env:CONTROL_PLANE_API_KEY'",
    'health:', "  listen_addr: '127.0.0.1:0'", 'admin_ui:', '  open_browser: false',
    'log:', '  level: info', '  format: json', 'mcp:', '  commands:',
    '    - channel: main', `      command: ${scalar}`, '',
  ].join('\n');
}

/** Capture bounded output and terminate only this invocation's process group. */
export function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, env: options.env, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let stdout = ''; let stderr = ''; let timedOut = false; let escalation;
    const kill = (signal) => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
    };
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT); });
    const timeout = setTimeout(() => {
      timedOut = true; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 1500);
    }, options.timeoutMs || 60_000);
    child.once('error', (error) => { clearTimeout(timeout); clearTimeout(escalation); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout); clearTimeout(escalation);
      resolve({ code: timedOut ? 124 : (code ?? 1), signal, stdout, stderr, timedOut });
    });
  });
}

async function fetchToFile(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`);
  if (!response.url.startsWith('https://')) throw new Error('拒绝非 HTTPS 下载重定向。');
  const file = await fs.open(destination, 'wx', 0o600);
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > 100 * 1024 * 1024) throw new Error('安装包超过 100 MiB 下载上限。');
      await file.write(chunk);
    }
  } finally { await file.close(); }
}

// Extract only regular files/directories from the one expected upstream root.
// Python 3.9 is supported; newer tarfile filter= APIs are deliberately not used.
const EXTRACT_PYTHON = `import pathlib, shutil, sys, tarfile
archive, destination, expected = sys.argv[1:]
root = pathlib.Path(destination)
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    if not members or sum(m.size for m in members) > 100 * 1024 * 1024:
        raise ValueError("empty or oversized archive")
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] != expected:
            raise ValueError("unsafe archive path: " + member.name)
        if not (member.isdir() or member.isfile()):
            raise ValueError("archive links and special files are not allowed")
    for member in members:
        target = root.joinpath(*pathlib.PurePosixPath(member.name).parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
`;

const PYTHON_LAYOUT = 'import json,os,sysconfig,sys; p=sysconfig.get_path("purelib"); print(json.dumps({"purelib":p,"relative":os.path.relpath(sys.argv[1],p)}))';
const PYTHON_PROBE = 'import antigravity_mcp,json,pathlib; p=pathlib.Path(antigravity_mcp.__file__).resolve(); print(json.dumps({"version":antigravity_mcp.__version__,"package":str(p.parent),"workflow":(p.parent/"workflow_settings.json").is_file()}))';

export function createInstaller(overrides = {}) {
  const io = overrides.fs || fs;
  const run = overrides.run || runProcess;
  const download = overrides.download || fetchToFile;
  const platform = overrides.platform ?? process.platform;
  const architecture = overrides.arch ?? process.arch;
  const nodeVersion = overrides.nodeVersion ?? process.versions.node;
  const nodePath = overrides.nodePath ?? process.execPath;
  const sources = { ...SOURCES, ...overrides.sources };
  const baseEnv = { ...(overrides.env || process.env) };
  const log = overrides.log || ((message) => console.log(message));
  const sleep = overrides.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = overrides.now || (() => new Date().toISOString());
  let options; let locations; let environment; let state; let tools; let backupRoot;

  async function stat(file) {
    try { return await io.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function exists(file) {
    try { await io.access(file); return true; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  }
  async function digest(file, algorithm = 'sha256', encoding = 'hex') {
    return crypto.createHash(algorithm).update(await io.readFile(file)).digest(encoding);
  }
  async function readJson(file) { return JSON.parse(await io.readFile(file, 'utf8')); }
  async function ensureDir(directory) {
    // Never traverse a user-supplied symlink within an installation subtree.
    const parent = path.dirname(directory);
    const managedParent = locations && [locations.home, locations.config].some((root) => parent === root || parent.startsWith(root + path.sep));
    if (parent !== directory && (managedParent || !(await stat(directory)))) await ensureDir(parent);
    const current = await stat(directory);
    if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error(`目标目录不是普通目录，未修改：${directory}`);
    if (!current) await io.mkdir(directory, { mode: 0o700 });
  }
  async function findExecutable(name, extra = []) {
    if (overrides.findExecutable) return overrides.findExecutable(name, extra, environment);
    const candidates = path.isAbsolute(name) ? [name] : [...new Set([
      ...extra, ...String(environment.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)),
      path.join('/opt/homebrew/bin', name), path.join('/usr/local/bin', name), path.join('/usr/bin', name),
    ])];
    for (const file of candidates) {
      try { await io.access(file, fsConstants.X_OK); if ((await io.stat(file)).isFile()) return file; } catch { /* Next candidate. */ }
    }
    return null;
  }
  async function checked(executable, args, label, extra = {}) {
    let result;
    try { result = await run(executable, args, { env: environment, timeoutMs: 60_000, ...extra }); }
    catch (error) { throw new Error(`${label} 无法执行：${error.message}`); }
    if (result.code !== 0) throw new Error(`${label} 失败${result.timedOut ? '（超时）' : ''}，退出码 ${result.code}。\n${(result.stderr || result.stdout || '').trim().slice(-12_000)}`);
    return result.stdout.trim();
  }
  async function requireTool(name, hint) {
    const executable = await findExecutable(name);
    if (!executable) throw new Error(`未找到 ${name}。${hint}`);
    return executable;
  }
  async function prerequisites() {
    if (platform !== 'darwin') throw new Error('此入口只支持 macOS；请在 Mac 上运行 Install-Components.command。');
    if (!['arm64', 'x64'].includes(architecture)) throw new Error(`不支持的 Mac 架构：${architecture}；需要 Apple Silicon 或 Intel 64 位。`);
    if (!versionAtLeast(nodeVersion, NODE_MINIMUM)) throw new Error(`Node.js ${nodeVersion} 版本过低，需要 >= ${NODE_MINIMUM}。请安装受支持的 Node.js 后重试（https://nodejs.org/）。`);
    tools = { node: nodePath };
    log(`    [OK] Node.js ${nodeVersion}（${architecture}）`);
    if (options.components.includes('tunnel-client')) {
      tools.brew = await requireTool('brew', '请先按 https://brew.sh/ 的官方说明安装 Homebrew，然后重新运行；安装器不会自动安装 Homebrew。');
      await checked(tools.brew, ['--version'], 'Homebrew 检查');
      if (!options.verifyOnly) {
        tools.git = await requireTool('git', '请安装 Git 或 Apple Command Line Tools（xcode-select --install），然后重试。');
        await checked(tools.git, ['--version'], 'Git 检查（如缺少开发工具，请手动运行 xcode-select --install）');
      }
      log('    [OK] Homebrew' + (tools.git ? ' / Git' : ''));
    }
    if (options.components.includes('overleaf-mcp') && !options.verifyOnly) {
      tools.npm = await requireTool('npm', '请安装包含 npm 的 Node.js >= 22.14.0。');
      await checked(tools.npm, ['--version'], 'npm 检查');
      log('    [OK] npm');
    }
    if (options.components.includes('antigravity-mcp') && !options.verifyOnly) {
      for (const name of ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9']) {
        const executable = await findExecutable(name);
        if (!executable) continue;
        try {
          const version = await checked(executable, ['-c', 'import sys,venv;print(".".join(map(str,sys.version_info[:3])))'], 'Python 检查');
          if (versionAtLeast(version, PYTHON_MINIMUM)) { tools.python = executable; tools.pythonVersion = version; break; }
        } catch { /* A second installed Python may be usable. */ }
      }
      if (!tools.python) throw new Error('未找到包含 venv 的 Python >= 3.9。请安装 Python 3.12 或更新版本（https://www.python.org/downloads/macos/），然后重试。');
      log(`    [OK] Python ${tools.pythonVersion}`);
    }
  }
  async function backup(file) {
    if (!backupRoot) backupRoot = path.join(locations.kit, 'backups', `${now().replaceAll(':', '-')}-${crypto.randomUUID()}`);
    const relative = path.relative(locations.home, file);
    const name = !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : path.join('external-config', crypto.createHash('sha256').update(file).digest('hex').slice(0, 12), path.basename(file));
    let destination = path.join(backupRoot, name);
    if (await stat(destination)) destination += `.revision-${crypto.randomUUID()}`;
    await ensureDir(path.dirname(destination));
    const info = await stat(file);
    if (info.isSymbolicLink()) await io.symlink(await io.readlink(file), destination);
    else if (info.isFile()) await io.copyFile(file, destination, fsConstants.COPYFILE_EXCL);
    else throw new Error(`目标与目录冲突，未覆盖：${file}`);
    log(`    [保留] 原文件备份：${destination}`);
  }
  async function writeAtomic(file, content, { preserveOld = false } = {}) {
    await ensureDir(path.dirname(file));
    const current = await stat(file);
    if (current && current.isFile() && await io.readFile(file, 'utf8') === content) return;
    if (current && preserveOld) await backup(file);
    if (current && !current.isFile() && !current.isSymbolicLink()) throw new Error(`文件位置被目录占用：${file}`);
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.partial`);
    try { await io.writeFile(temp, content, { flag: 'wx', mode: 0o600 }); await io.rename(temp, file); }
    finally { await io.rm(temp, { force: true }); }
  }
  async function withStage(label, operation) {
    const base = path.join(locations.kit, 'staging');
    await ensureDir(base);
    const stage = await io.mkdtemp(path.join(base, `${label}-`));
    try { return await operation(stage); }
    finally { await io.rm(stage, { recursive: true, force: true }); } // Only our unique, fresh staging directory.
  }
  async function verifiedDownload(url, file, expected, algorithm = 'sha256', encoding = 'hex') {
    if (await exists(file) && await digest(file, algorithm, encoding) === expected) {
      log(`    [OK] 复用校验通过的缓存：${path.basename(file)}`); return file;
    }
    await ensureDir(path.dirname(file));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const temp = `${file}.${crypto.randomUUID()}.partial`;
      let networkError;
      try {
        log(`    [下载] ${url}（${attempt}/3）`);
        try { await download(url, temp); } catch (error) { networkError = error; throw error; }
        const actual = await digest(temp, algorithm, encoding);
        if (actual !== expected) throw new Error(`${algorithm} 校验失败：期望 ${expected}，实际 ${actual}；未安装。`);
        if (await stat(file)) await backup(file);
        await io.rename(temp, file);
        return file;
      } catch (error) {
        if (!networkError || attempt === 3) throw new Error(`下载失败：${error.message}`);
        log(`    [重试] ${error.message}`); await sleep(attempt * 500);
      } finally { await io.rm(temp, { force: true }); }
    }
  }
  /** Merge package files only; never clear a runtime, app, venv or user folder. */
  async function mergeTree(source, destination, previous = {}, preserveNames = new Set(), manifest = {}, relative = '') {
    await ensureDir(destination);
    for (const entry of await io.readdir(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await mergeTree(from, to, previous, preserveNames, manifest, key); continue; }
      if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`安装包含不支持的文件：${key}`);
      const link = entry.isSymbolicLink() ? await io.readlink(from) : null;
      if (link && path.isAbsolute(link)) throw new Error(`安装包包含绝对符号链接：${key}`);
      if (link && path.relative(source, path.resolve(path.dirname(from), link)).startsWith('..')) {
        // npm .bin links usually point into a sibling package, so validate against the whole staging tree below.
        const absolute = path.resolve(path.dirname(from), link);
        if (!absolute.startsWith(locations.currentStage + path.sep)) throw new Error(`安装包符号链接越界：${key}`);
      }
      const hash = link ? `symlink:${link}` : await digest(from);
      manifest[key] = hash;
      const current = await stat(to);
      let currentHash;
      if (current?.isSymbolicLink()) currentHash = `symlink:${await io.readlink(to)}`;
      else if (current?.isFile()) currentHash = await digest(to);
      else if (current) throw new Error(`安装文件与现有目录冲突，未清空目录：${to}`);
      if (currentHash === hash) continue;
      if (current && preserveNames.has(entry.name)) {
        await writeAtomic(`${to}.suggested`, await io.readFile(from, 'utf8'), { preserveOld: true });
        manifest[key] = previous[key] || hash;
        log(`    [保留] 已有个人设置：${to}；新版默认值写入 .suggested`); continue;
      }
      if (current && currentHash !== previous[key]) await backup(to);
      const temp = path.join(destination, `.${entry.name}.${crypto.randomUUID()}.partial`);
      try {
        if (link) await io.symlink(link, temp);
        else { await io.copyFile(from, temp, fsConstants.COPYFILE_EXCL); await io.chmod(temp, (await io.stat(from)).mode & 0o777); }
        await io.rename(temp, to);
      } finally { await io.rm(temp, { force: true }); }
    }
    return manifest;
  }
  function profileCommand(content) {
    const mcp = content.match(/^mcp:\s*(?:#.*)?\r?\n([\s\S]*?)(?=^[^\s#]|$(?![\s\S]))/m);
    if (!mcp || !/^\s{2}commands:\s*(?:#.*)?$/m.test(mcp[1])) return null;
    const commands = [...mcp[1].matchAll(/^\s+command:\s*(.+?)\s*$/gm)];
    if (commands.length !== 1) return null;
    const raw = commands[0][1];
    if (raw.startsWith("'")) return raw.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/)?.[1].replaceAll("''", "'") || null;
    if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch { return null; } }
    if (/^[>|&*!]/.test(raw)) return null;
    return raw.replace(/\s+#.*$/, '');
  }
  function firstCommandToken(command) {
    // Parse the executable without executing the user's command or a shell.
    let value = ''; let quote = ''; let escaped = false;
    for (const char of command.trim()) {
      if (escaped) { value += char; escaped = false; }
      else if (char === '\\' && quote !== "'") escaped = true;
      else if (quote) { if (char === quote) quote = ''; else value += char; }
      else if (char === "'" || char === '"') quote = char;
      else if (/\s/.test(char)) break;
      else value += char;
    }
    return quote || escaped ? null : value;
  }
  async function checkProfile(file, expected) {
    if (!(await exists(file))) return { ok: false, reason: '配置文件不存在' };
    const content = await io.readFile(file, 'utf8');
    let command = profileCommand(content);
    if (command === expected) return { ok: true, same: true };
    if (command?.startsWith('env:')) command = environment[command.slice(4)];
    const executable = command && firstCommandToken(command);
    const resolved = executable && await findExecutable(executable);
    return { ok: Boolean(resolved), same: false, reason: resolved ? '现有自定义命令仍可用，已保留' : '未能确认现有 mcp.commands 命令可用' };
  }
  async function configureProfile(file, expected) {
    const check = await checkProfile(file, expected);
    if (options.verifyOnly) {
      if (!check.ok) throw new Error(`隧道配置检查失败：${file}（${check.reason}）。`);
      if (!check.same) log(`    [保留] ${check.reason}：${file}`);
      return check.same ? 'verified' : 'custom-command';
    }
    if (!(await stat(file))) { await writeAtomic(file, tunnelProfile(expected)); return 'created'; }
    if (check.same) return 'unchanged';
    // Never rewrite the user's credentials, comments, env references or command.
    const suggestion = `# 安装器建议的配置；请只合并需要的 mcp.commands 部分，保留自己的凭据。\n${tunnelProfile(expected)}`;
    await writeAtomic(`${file}.suggested`, suggestion, { preserveOld: true });
    log(`    [保留] 现有隧道配置未改动；参考 ${file}.suggested`);
    if (!check.ok) throw new Error(`${check.reason}：${file}。请合并 .suggested 中的 mcp.commands 后重新运行。`);
    return 'custom-command';
  }
  async function tunnel() {
    const versionList = await run(tools.brew, ['list', '--versions', sources.tunnelFormula], { env: environment, timeoutMs: 60_000 });
    const installed = versionList.code === 0 && Boolean(versionList.stdout.trim());
    if (!installed && options.verifyOnly) throw new Error('Homebrew 尚未安装 openai/tools/tunnel-client。');
    if (!options.verifyOnly && (!installed || options.force)) {
      log(`    [安装] Homebrew ${options.force && installed ? 'reinstall' : 'install'} ${sources.tunnelFormula}`);
      await checked(tools.brew, [options.force && installed ? 'reinstall' : 'install', sources.tunnelFormula], 'Homebrew 安装 tunnel-client', { timeoutMs: 900_000 });
    }
    const prefix = await checked(tools.brew, ['--prefix', sources.tunnelFormula], '读取 Homebrew 组件路径');
    if (!path.isAbsolute(prefix) || /[\r\n\0]/.test(prefix)) throw new Error('Homebrew 返回了无效的组件目录。');
    const libexec = path.join(prefix, 'libexec'); const binary = path.join(libexec, 'tunnel-client');
    for (const name of ['tunnel-client', 'cloudflared', 'cloudflared-manifest.json']) {
      const file = path.join(libexec, name);
      if (!(await exists(file)) || !(await io.stat(file)).isFile()) throw new Error(`Homebrew 资源不完整：${file}；请使用 --force 修复。`);
    }
    await readJson(path.join(libexec, 'cloudflared-manifest.json'));
    await io.access(binary, fsConstants.X_OK); await io.access(path.join(libexec, 'cloudflared'), fsConstants.X_OK);
    const output = await checked(binary, ['--version'], 'tunnel-client 版本检查', { timeoutMs: 20_000 });
    const version = output.match(/(?:^|\W)v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=\W|$)/)?.[1];
    if (!version) throw new Error(`无法识别 tunnel-client --version 输出：${output}`);
    const brewVersions = await checked(tools.brew, ['list', '--versions', sources.tunnelFormula], '读取 Homebrew 已安装版本');
    if (!brewVersions.split(/\s+/).slice(1).some((value) => value === version || value.startsWith(`${version}_`))) throw new Error(`tunnel-client 运行版本 ${version} 与 Homebrew 记录不符：${brewVersions}`);
    const current = await stat(locations.tunnelBinary);
    const targetMatches = current?.isSymbolicLink() && await io.readlink(locations.tunnelBinary) === binary;
    if (options.verifyOnly) {
      if (!targetMatches) throw new Error(`安装入口未指向完整 Homebrew libexec：${locations.tunnelBinary}；重新运行安装器修复。`);
    } else if (!targetMatches) {
      await ensureDir(path.dirname(locations.tunnelBinary));
      if (current) await backup(locations.tunnelBinary);
      const temp = `${locations.tunnelBinary}.${crypto.randomUUID()}.partial`;
      try { await io.symlink(binary, temp); await io.rename(temp, locations.tunnelBinary); }
      finally { await io.rm(temp, { force: true }); }
    }
    log(`    [OK] tunnel-client ${version}（Homebrew 实际版本；伴随资源保留在 ${libexec}）`);
    return { version, path: locations.tunnelBinary, source: sources.tunnelFormula, distribution: 'homebrew', brewVersions, prefix, wrapper: path.join(prefix, 'bin', 'tunnel-client'), libexec, versionOutput: output };
  }
  async function validateOverleaf(runtime) {
    const packageFile = path.join(runtime, 'node_modules', sources.overleafPackage, 'package.json');
    const manifest = await readJson(packageFile);
    if (manifest.version !== sources.overleafVersion) throw new Error(`Overleaf 版本不符：${manifest.version}；需要 ${sources.overleafVersion}。`);
    if (!(await exists(path.join(runtime, 'node_modules', sources.overleafPackage, 'dist', 'index.js')))) throw new Error('Overleaf dist/index.js 入口缺失。');
    await validateOverleafLock(runtime);
    const output = await checked(tools.node, [path.join(runtime, 'node_modules', sources.overleafPackage, 'dist', 'index.js'), '--version'], 'Overleaf 运行时版本检查', { timeoutMs: 20_000 });
    if (output !== sources.overleafVersion) throw new Error(`Overleaf --version 输出不符：${output}`);
    return true;
  }
  async function validateOverleafLock(runtime) {
    const lock = await readJson(path.join(runtime, 'package-lock.json'));
    const record = lock.packages?.[`node_modules/${sources.overleafPackage}`];
    if (record?.version !== sources.overleafVersion || record?.integrity !== sources.overleafIntegrity) throw new Error('Overleaf package-lock.json 中的固定版本或 npm integrity 不符；未接受此安装。');
    return true;
  }
  async function overleaf() {
    const runtime = locations.overleafRuntime; let valid = false; let validationError;
    try { valid = await validateOverleaf(runtime); } catch (error) { validationError = error; }
    if (options.verifyOnly && !valid) throw validationError;
    let files = state.components['overleaf-mcp']?.files || {};
    if (!options.verifyOnly && (!valid || options.force)) {
      const archive = await verifiedDownload(sources.overleafUrl, path.join(locations.cache, `mcp-server-overleaf-${sources.overleafVersion}.tgz`), sources.overleafIntegrity.slice('sha512-'.length), 'sha512', 'base64');
      await withStage('overleaf', async (stage) => {
        locations.currentStage = stage;
        const manifest = { name: 'mcp-tunnel-overleaf-runtime', version: '1.0.0', private: true, dependencies: { [sources.overleafPackage]: sources.overleafVersion } };
        await io.writeFile(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        // Download is independently hashed above. npm checks its own downloaded
        // bytes; no lifecycle scripts run, and no files are promoted before the
        // resulting lock's exact pinned SRI and package version are checked.
        const reusableLock = await validateOverleafLock(runtime).catch(() => false);
        if (reusableLock) await io.copyFile(path.join(runtime, 'package-lock.json'), path.join(stage, 'package-lock.json'));
        log(`    [安装] npm ${reusableLock ? 'ci' : 'install'} mcp-server-overleaf@${sources.overleafVersion}`);
        await checked(tools.npm, [reusableLock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--package-lock=true', '--registry=https://registry.npmjs.org', '--cache', path.join(locations.kit, 'npm-cache')], 'npm 安装 Overleaf', { cwd: stage, timeoutMs: 600_000 });
        await validateOverleaf(stage);
        files = await mergeTree(stage, runtime, files);
      });
      log(`    [OK] Overleaf 下载包与 npm integrity 均匹配 ${sources.overleafVersion}（${path.basename(archive)}）`);
    } else log(`    [OK] Overleaf ${sources.overleafVersion} 已安装`);
    const command = [tools.node, locations.overleafEntry, '--stdio'].map(quoteCommandArgument).join(' ');
    const profileAction = await configureProfile(locations.overleafProfile, command);
    return { version: sources.overleafVersion, path: locations.overleafEntry, runtime, node: tools.node, integrity: sources.overleafIntegrity, source: sources.overleafUrl, files, profileYaml: locations.overleafProfile, profileYamlAction: profileAction, command };
  }
  async function validateAntigravity() {
    const marker = await readJson(path.join(locations.antigravityApp, 'SOURCE.json'));
    if (marker.commit !== sources.antigravityCommit || marker.archiveSha256 !== sources.antigravitySha256) throw new Error('Antigravity 源码标记不符；需要固定的用户 fork commit。');
    const result = JSON.parse(await checked(locations.venvPython, ['-c', PYTHON_PROBE], 'Antigravity 导入检查'));
    if (result.version !== sources.antigravityVersion || !result.workflow || result.package !== await io.realpath(path.join(locations.antigravityApp, 'antigravity_mcp'))) throw new Error('Antigravity 版本、导入路径或 workflow_settings.json 检查失败。');
    return true;
  }
  async function antigravity() {
    let valid = false; let validationError;
    try { valid = await validateAntigravity(); } catch (error) { validationError = error; }
    if (options.verifyOnly && !valid) throw validationError;
    let files = state.components['antigravity-mcp']?.files || {};
    if (!options.verifyOnly && (!valid || options.force)) {
      const archive = await verifiedDownload(sources.antigravityUrl, path.join(locations.cache, `antigravity-${sources.antigravityCommit}.tar.gz`), sources.antigravitySha256);
      await withStage('antigravity', async (stage) => {
        locations.currentStage = stage;
        const rootName = `antigravity-mcp-fork-${sources.antigravityCommit}`;
        await checked(tools.python, ['-c', EXTRACT_PYTHON, archive, stage, rootName], '解压固定 Antigravity 源码');
        const sourceRoot = path.join(stage, rootName); const sourcePackage = path.join(sourceRoot, 'src', 'antigravity_mcp');
        for (const name of ['__init__.py', '__main__.py', 'workflow_settings.json']) if (!(await exists(path.join(sourcePackage, name)))) throw new Error(`Antigravity 源码缺少 ${name}。`);
        const app = path.join(stage, 'app'); await ensureDir(app);
        await io.cp(sourcePackage, path.join(app, 'antigravity_mcp'), { recursive: true });
        for (const name of ['LICENSE', 'README.md', 'pyproject.toml']) await io.copyFile(path.join(sourceRoot, name), path.join(app, name));
        const marker = { repository: sources.antigravityRepository, commit: sources.antigravityCommit, version: sources.antigravityVersion, archiveSha256: sources.antigravitySha256 };
        await io.writeFile(path.join(app, 'SOURCE.json'), `${JSON.stringify(marker, null, 2)}\n`);
        // Test staged source before touching a previous app, without importing user-site packages.
        const stagedVersion = await checked(tools.python, ['-c', 'import sys;sys.path.insert(0,sys.argv[1]);import antigravity_mcp;print(antigravity_mcp.__version__)', app], 'Antigravity 源码版本检查');
        if (stagedVersion !== sources.antigravityVersion) throw new Error(`Antigravity 源码版本不符：${stagedVersion}`);
        if (!(await exists(locations.venvPython))) {
          if (await stat(locations.venv)) throw new Error(`已有 venv 缺少有效 Python，未清空目录：${locations.venv}。请先将该目录改名保留后重试。`);
          await ensureDir(path.dirname(locations.venv));
          try { await checked(tools.python, ['-m', 'venv', '--without-pip', locations.venv], '创建独立 Python venv', { timeoutMs: 180_000 }); }
          catch (error) {
            // This directory did not exist before our attempt. Preserve a partial
            // creation under a unique name, so a retry can create a clean venv.
            if (await stat(locations.venv)) {
              const incomplete = `${locations.venv}.incomplete-${crypto.randomUUID()}`;
              await io.rename(locations.venv, incomplete);
              log(`    [保留] 未完成的 venv 已移至 ${incomplete}`);
            }
            throw error;
          }
        }
        const venvVersion = await checked(locations.venvPython, ['-c', 'import sys;print(".".join(map(str,sys.version_info[:3])))'], 'venv Python 版本检查');
        if (!versionAtLeast(venvVersion, PYTHON_MINIMUM)) throw new Error(`已有 venv Python ${venvVersion} 版本过低；请将 ${locations.venv} 改名保留后重试。`);
        const layout = JSON.parse(await checked(locations.venvPython, ['-c', PYTHON_LAYOUT, locations.antigravityApp], '查询 venv site-packages'));
        const relativeSite = path.relative(locations.venv, layout.purelib);
        if (!layout.purelib || path.isAbsolute(relativeSite) || relativeSite.startsWith('..')) throw new Error('venv site-packages 路径超出虚拟环境；未写入 .pth。');
        files = await mergeTree(app, locations.antigravityApp, files, new Set(['workflow_settings.json']));
        // sysconfig + relpath handles Mac's four parent levels and Unicode homes.
        // Our stable app/venv sibling names keep this relative value ASCII even
        // with non-ASCII usernames; reject only line breaks, never encode a home as ASCII.
        if (/[\r\n\0]/.test(layout.relative)) throw new Error('venv 相对路径含非法换行。');
        await writeAtomic(path.join(layout.purelib, '_antigravity_mcp_src.pth'), `${layout.relative}\n`, { preserveOld: true });
        await validateAntigravity();
      });
      log(`    [OK] Antigravity ${sources.antigravityVersion} / ${sources.antigravityCommit.slice(0, 7)}（源码 + venv，无 pip 构建）`);
    } else log(`    [OK] Antigravity ${sources.antigravityVersion} 已安装`);
    const command = [locations.venvPython, '-X', 'utf8', '-u', '-m', 'antigravity_mcp'].map(quoteCommandArgument).join(' ');
    const profileAction = await configureProfile(locations.antigravityProfile, command);
    return { version: sources.antigravityVersion, path: locations.venvPython, app: locations.antigravityApp, venv: locations.venv, stateDir: path.join(locations.home, 'Library', 'Application Support', 'antigravity-mcp'), commit: sources.antigravityCommit, sha256: sources.antigravitySha256, source: sources.antigravityRepository, files, profileYaml: locations.antigravityProfile, profileYamlAction: profileAction, command };
  }
  async function execute(input = {}) {
    backupRoot = undefined;
    options = { force: false, verifyOnly: false, ...input, components: normalizeComponents(input.components) };
    if (options.force && options.verifyOnly) throw new Error('--force 与 --verify-only 不能同时使用。');
    const home = path.resolve(options.homeDir || overrides.homeDir || os.homedir());
    if (/[\r\n\0]/.test(home) || home === path.parse(home).root) throw new Error('用户目录不能是文件系统根目录或包含换行。');
    if (baseEnv.XDG_CONFIG_HOME && !path.isAbsolute(baseEnv.XDG_CONFIG_HOME)) throw new Error('XDG_CONFIG_HOME 必须是绝对路径。');
    const config = path.resolve(options.configDir || path.join(options.homeDir ? path.join(home, '.config') : (baseEnv.XDG_CONFIG_HOME || path.join(home, '.config')), 'tunnel-client'));
    if (/[\r\n\0]/.test(config) || config === path.parse(config).root) throw new Error('隧道配置目录不能是文件系统根目录或包含换行。');
    locations = {
      home, config, kit: path.join(home, '.mcp-tunnel-kit'), cache: path.join(home, '.mcp-tunnel-kit', 'cache'),
      tunnelBinary: path.join(home, '.openai-tunnel', 'tunnel-client'),
      overleafRuntime: path.join(home, '.overleaf-mcp', 'runtime'),
      overleafEntry: path.join(home, '.overleaf-mcp', 'runtime', 'node_modules', sources.overleafPackage, 'dist', 'index.js'),
      antigravityApp: path.join(home, '.antigravity-mcp', 'app'), venv: path.join(home, '.antigravity-mcp', 'venv'),
      venvPython: path.join(home, '.antigravity-mcp', 'venv', 'bin', 'python'),
      overleafProfile: path.join(config, 'overleaf.yaml'), antigravityProfile: path.join(config, 'antigravity-local.yaml'),
    };
    environment = { ...baseEnv, HOME: home, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_ANALYTICS: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
    delete environment.PYTHONPATH; delete environment.PYTHONHOME;
    log(`MCP Tunnel macOS 组件${options.verifyOnly ? '检查' : '安装'}\n  用户目录：${home}\n  隧道配置：${config}`);
    await prerequisites();
    const stateFile = path.join(locations.kit, 'install-state-macos.json');
    let preserveUnreadableState = false;
    try { state = await readJson(stateFile); if (!state.components || typeof state.components !== 'object' || Array.isArray(state.components)) throw new Error('invalid state'); }
    catch { preserveUnreadableState = Boolean(await stat(stateFile)); state = { schemaVersion: 1, platform: 'darwin', components: {} }; }
    const lock = path.join(locations.kit, 'install-macos.lock'); let ownsLock = false;
    if (!options.verifyOnly) {
      await ensureDir(locations.kit);
      try { await io.mkdir(lock, { mode: 0o700 }); ownsLock = true; }
      catch (error) { if (error.code === 'EEXIST') throw new Error(`另一个安装器可能正在运行：${lock}。确认没有安装进程后，可手动移除此空锁目录再试。`); throw error; }
    }
    const results = [];
    try {
      for (const component of options.components) {
        log(`\n==> ${component}`);
        try {
          const record = await ({ 'tunnel-client': tunnel, 'overleaf-mcp': overleaf, 'antigravity-mcp': antigravity })[component]();
          if (!options.verifyOnly) {
            state.components[component] = { ...record, installedAt: now() };
            state.updatedAt = now(); state.homeDir = home; state.configDir = config;
            await writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`, { preserveOld: preserveUnreadableState });
            preserveUnreadableState = false;
          }
          results.push({ component, ok: true, ...record });
        } catch (error) { log(`    [失败] ${error.message}`); results.push({ component, ok: false, error: error.message }); }
      }
    } finally { if (ownsLock) await io.rmdir(lock); }
    const failed = results.filter((result) => !result.ok);
    log(`\n${failed.length ? `未完成：${failed.map((result) => result.component).join('、')}。处理上述问题后重试；已成功的组件会复用。` : (options.verifyOnly ? '检查通过。' : '安装完成。双击 Start-Console.command，在控制台填写自己的 Tunnel ID 与 Runtime API Key。')}`);
    return { ok: failed.length === 0, code: failed.length ? 1 : 0, results, locations };
  }
  return { execute };
}

export const HELP = `MCP Tunnel macOS 组件安装器（Apple Silicon / Intel）
用法：node scripts/install-components-macos.mjs [选项]
  --component all|tunnel-client|overleaf-mcp|antigravity-mcp
                  可重复，或用逗号分隔；默认 all；也接受 tunnel/overleaf/antigravity
  --force         重装所选组件；保留个人文件，修改过的程序文件会备份
  --verify-only   只检查现有安装与隧道配置，不下载、不安装、不写文件
  --home-dir PATH 指定组件的用户根目录（默认当前用户目录）
  --config-dir PATH 指定完整的 tunnel-client 配置目录
  --help          显示此帮助
需要 Node.js >= 22.14.0；tunnel 需要 Homebrew/Git；Overleaf 需要 npm；
Antigravity 需要含 venv 的 Python >= 3.9。不会自动安装系统前提工具。
tunnel-client 使用官方 Homebrew 当前公式，记录实际版本；Overleaf 固定 0.3.9；
Antigravity 固定用户 fork 1.1.0.post1 commit 02df3ed。
`;

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else process.exitCode = (await createInstaller().execute(options)).code;
  } catch (error) { console.error(`[失败] ${error.message}`); process.exitCode = 1; }
}
