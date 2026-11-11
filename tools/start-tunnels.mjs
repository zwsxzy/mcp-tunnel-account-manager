#!/usr/bin/env node
/**
 * 启动 MCP 隧道（生产分叉部署用，separate 模式）。
 *
 * 机制：
 *   - 启动三个独立的 tunnel-client（overleaf / antigravity / deepseek-bridge）。
 *   - 从 manager.db 只读解密 Runtime API Key（与控制台同一把），密钥不打印、不落盘。
 *   - 从子进程 PATH 中移除 npm 目录，使 tunnel-client 探测不到 Codex，
 *     从而不再拉起每份约 96 MB 的 `codex app-server` 桥接及其控制台窗口。
 *
 * 用法：
 *   node tools/start-tunnels.mjs
 *   node tools/start-tunnels.mjs --dry-run
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 本文件位于 <BUNDLE>/tools/start-tunnels.mjs，因此往上一级就是部署包根目录。
// 不再写死盘符：无论包被解压到哪个目录都能运行。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(__dirname, '..');

const { createVault } = await import(pathToFileURL(path.join(BUNDLE, 'console', 'src', 'vault.mjs')).href);
const DATA = path.join(process.env.LOCALAPPDATA || process.env.HOME || __dirname, 'McpTunnelAccountManager');
const CLIENT = path.join(BUNDLE, 'tunnel-client', 'tunnel-client.exe');
// 可选 HTTP 代理：默认不启用，需要时用 MCP_PROXY 环境变量指定（例如 http://127.0.0.1:7897）。
const PROXY = process.env.MCP_PROXY || '';
const LOGDIR = path.join(DATA, 'logs');
const NODE = path.join(BUNDLE, 'console', 'runtime', 'node.exe');
const OVERLEAF_ENTRY = path.join(BUNDLE, 'servers', 'overleaf-mcp', 'node_modules', 'mcp-server-overleaf', 'dist', 'index.js');
const ANTIGRAVITY_HOME = path.join(BUNDLE, 'servers', 'antigravity-mcp');

/**
 * 解析 Python 解释器，按优先级：
 *   1. 环境变量 MCP_PYTHON
 *   2. 常见安装位置（含 venv、conda）
 *   3. PATH 上的 python.exe / python3
 * 找不到时返回 null（antigravity 隧道将无法启动，overleaf/deepseek 不受影响）。
 */
function resolvePython() {
  const candidates = [];
  if (process.env.MCP_PYTHON) candidates.push(process.env.MCP_PYTHON);
  const local = process.env.LOCALAPPDATA || '';
  candidates.push(path.join(BUNDLE, '.venv', 'Scripts', 'python.exe'));
  if (local) candidates.push(path.join(local, 'Programs', 'Python', 'Python313', 'python.exe'));
  if (local) candidates.push(path.join(local, 'Programs', 'Python', 'Python312', 'python.exe'));
  if (local) candidates.push(path.join(local, 'Programs', 'Python', 'Python311', 'python.exe'));
  candidates.push('C:\\Python313\\python.exe', 'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe');
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  for (const name of ['python.exe', 'python3.exe', 'python', 'python3']) {
    try {
      const out = execFileSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/).map((s) => s.trim()).find((s) => s);
      if (out) return out;
    } catch { /* not found on PATH */ }
  }
  return null;
}

const PYTHON = resolvePython();

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');

/** 供 MCP 子进程使用的命令行（按 tunnel-client 自己的引号/反斜杠规则转义） */
const q = (a) => a.map((x) => '"' + x.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"').join(' ');

/** 去掉 PATH 中的 npm 目录，阻断 Codex 探测 */
function pathWithoutNpm() {
  const sep = path.delimiter;
  return (process.env.PATH || '')
    .split(sep)
    .filter((p) => !p || !/[\\/]Roaming[\\/]npm(?:[\\/]|$)/i.test(p))
    .join(sep);
}

// 检查是否开启 Codex 桥接
let codexEnabled = true;
try {
  const db = new DatabaseSync(path.join(DATA, 'manager.db'), { readOnly: true });
  const row = db.prepare("SELECT value FROM metadata WHERE key='codex_bridge_enabled'").get();
  codexEnabled = row ? row.value !== '0' : true;
  db.close();
} catch (e) {
  console.error('无法读取 Codex 设置，默认开启:', e);
}

const vault = createVault({ dataDir: DATA });
const db = new DatabaseSync(path.join(DATA, 'manager.db'), { readOnly: true });
const prof = db.prepare("SELECT id, revision, sealed_credentials FROM profiles WHERE label='本机默认'").get();
const sealed = JSON.parse(prof.sealed_credentials || '{}');
const creds = {};
for (const svc of Object.keys(sealed)) {
  creds[svc] = vault.unseal(sealed[svc], JSON.stringify(['profile', prof.id, prof.revision, svc, 'credentials-v2']));
}
const bridgeRow = db.prepare("SELECT revision, sealed_definition FROM mcp_services WHERE id='mcp_dsh_chatgpt_bridge'").get();
const bridgeDef = vault.unseal(bridgeRow.sealed_definition,
  JSON.stringify(['mcp-service', 'mcp_dsh_chatgpt_bridge', bridgeRow.revision, 'definition-v1']));
const bridgeAuth = bridgeDef.binding.headers.Authorization.value;
db.close();
vault.close();

fs.mkdirSync(LOGDIR, { recursive: true });

/** 停掉本部署已有的隧道（只按可执行路径匹配） */
function stopExisting() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" |
    Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq [IO.Path]::GetFullPath('${CLIENT}')) } |
    Select-Object -ExpandProperty ProcessId`;
  let ids = [];
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    ids = out.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger);
  } catch { /* 没有进程时忽略 */ }
  for (const id of ids) {
    try { execFileSync('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
  return ids;
}

function launch(job) {
  const args = ['run', '--config', job.config,
    '--health.listen-addr', '127.0.0.1:0',
    '--control-plane.poll-timeout', '10s',
    '--control-plane.initial-poll-timeout', '100ms'];
  if (PROXY) args.push('--http-proxy', PROXY);
  
  const filteredPath = pathWithoutNpm();
  
  const env = {
    ...process.env,
    CONTROL_PLANE_API_KEY: job.apiKey,
    ...(job.env || {}),
  };
  if (PROXY) {
    env.HTTP_PROXY = PROXY; env.HTTPS_PROXY = PROXY; env.ALL_PROXY = PROXY;
  }
  
  // 只有当 codexEnabled 为 false 时，才覆盖 PATH 和 Path
  if (!codexEnabled) {
    env.PATH = filteredPath;
    env.Path = filteredPath;
    console.log(`  [debug] ${job.name} 的 PATH 已过滤，包含 npm: ${filteredPath.toLowerCase().includes('roaming\\npm')}`);
  }

  if (dryRun) {
    console.log(`  [dry-run] ${job.name.padEnd(18)} config=${path.basename(job.config)} cwd=${job.cwd}`);
    return null;
  }
  const out = fs.openSync(path.join(LOGDIR, `separate-${job.name}.out.log`), 'w');
  const err = fs.openSync(path.join(LOGDIR, `separate-${job.name}.err.log`), 'w');
  const child = spawn(CLIENT, args, {
    cwd: job.cwd, env, detached: true, stdio: ['ignore', out, err], windowsHide: true,
  });
  child.unref();
  console.log(`  ${job.name.padEnd(18)} PID=${child.pid} (Codex桥接: ${codexEnabled ? '开启' : '关闭'})`);
  return child.pid;
}

const overleafCmd = q([NODE, OVERLEAF_ENTRY, '--stdio']);

console.log('启动模式: separate（三个独立 tunnel-client 隧道）');
console.log(`  部署包目录: ${BUNDLE}`);
const ids = dryRun ? [] : stopExisting();
if (ids.length) console.log('  已停止既有隧道 PID:', ids.join(', '));
launch({
  name: 'overleaf',
  config: path.join(BUNDLE, 'generated-profiles', 'overleaf-local.yaml'),
  cwd: BUNDLE,
  apiKey: creds['overleaf-mcp'].apiKey,
  env: { DEPLOYMENT_MCP_COMMAND: overleafCmd },
});
if (PYTHON) {
  const antigravityCmd = q([PYTHON, '-m', 'antigravity_mcp']);
  launch({
    name: 'antigravity',
    config: path.join(BUNDLE, 'generated-profiles', 'antigravity-local.yaml'),
    cwd: ANTIGRAVITY_HOME,
    apiKey: creds['antigravity-mcp'].apiKey,
    env: { DEPLOYMENT_MCP_COMMAND: antigravityCmd, PYTHONPATH: ANTIGRAVITY_HOME },
  });
} else {
  console.warn('  [skip] antigravity：未找到 Python 解释器。请安装 Python 3.9+，或设置环境变量 MCP_PYTHON 指向 python.exe 后重试。');
}
launch({
  name: 'deepseek-bridge',
  config: path.join(BUNDLE, 'generated-profiles', 'deepseek-local.yaml'),
  cwd: BUNDLE,
  apiKey: creds['mcp_dsh_chatgpt_bridge'].apiKey,
  env: { DSH_CHATGPT_BRIDGE_AUTHORIZATION: bridgeAuth },
});

console.log(dryRun ? '\n(dry-run 结束)' : '\n完成。日志目录: ' + LOGDIR);
