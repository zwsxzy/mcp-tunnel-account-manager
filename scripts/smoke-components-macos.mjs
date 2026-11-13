#!/usr/bin/env node
/** Credential-free stdio checks for an explicitly installed, isolated Mac home. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createInstaller, parseArguments, SOURCES } from './install-components-macos.mjs';

function killOwned(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
}

async function closeOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(term); clearTimeout(force); clearTimeout(last); resolve();
    };
    const term = setTimeout(() => killOwned(child, 'SIGTERM'), 1000);
    const force = setTimeout(() => killOwned(child, 'SIGKILL'), 2500);
    const last = setTimeout(finish, 4000);
    child.once('close', finish);
    child.stdin.end();
  });
}

/** No tools are invoked: only initialize, initialized, and tools/list. */
export async function probeMcpStdio({ executable, args, env, cwd, expectedVersion, timeoutMs = 15_000 }) {
  const child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; let buffer = ''; let completed = false; let timer;
  try {
    return await new Promise((resolve, reject) => {
      let initialized = false;
      const fail = (message) => { if (!completed) { completed = true; reject(new Error(message)); } };
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      timer = setTimeout(() => fail(`stdio smoke 在 ${timeoutMs} ms 内未完成 initialize/tools/list。`), timeoutMs);
      child.once('error', (error) => fail(`无法启动 MCP：${error.message}`));
      child.stdin.on('error', (error) => { if (!completed) fail(`MCP stdin 错误：${error.message}`); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      child.once('close', (code) => { if (!completed) fail(`MCP 在返回 tools/list 前退出（${code}）：${stderr.trim()}`); });
      child.stdout.on('data', (chunk) => {
        if (completed) return;
        buffer += chunk.toString();
        if (buffer.length > 2 * 1024 * 1024) { fail('MCP stdout 超过 smoke 输出上限。'); return; }
        let end;
        while (!completed && (end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line) continue;
          let reply;
          try { reply = JSON.parse(line); } catch { fail('MCP stdout 含非 JSON-RPC 内容。'); return; }
          if (reply.id !== 1 && reply.id !== 2) continue; // Notifications may be interleaved.
          if (reply.jsonrpc !== '2.0') { fail('MCP 响应不是 JSON-RPC 2.0。'); return; }
          if (reply.error) { fail(`MCP 返回错误 ${reply.error.code}：${reply.error.message}`); return; }
          if (reply.id === 1 && !initialized) {
            if (!reply.result?.protocolVersion || reply.result?.serverInfo?.version !== expectedVersion) { fail(`MCP initialize 版本不符；期望 ${expectedVersion}。`); return; }
            initialized = true;
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          } else if (reply.id === 2) {
            if (!initialized || !Array.isArray(reply.result?.tools) || !reply.result.tools.length || !reply.result.tools.every((tool) => typeof tool.name === 'string' && tool.name.length > 0)) { fail('MCP tools/list 未返回有效的非空工具列表。'); return; }
            completed = true;
            resolve({ version: expectedVersion, toolCount: reply.result.tools.length, toolNames: reply.result.tools.map((tool) => tool.name) });
          }
        }
      });
      child.once('spawn', () => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-tunnel-install-smoke', version: '1.0.0' } } }));
    });
  } finally { clearTimeout(timer); await closeOwned(child); }
}

export async function probeInstalledComponents(locations, components, log = console.log) {
  // Always use a newly created synthetic HOME. No real account/IDE environment
  // or inherited NODE_OPTIONS/PYTHONPATH/token variables are passed to servers.
  const base = path.join(locations.kit, 'smoke');
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const synthetic = await fs.mkdtemp(path.join(base, 'synthetic-home-'));
  const temporary = path.join(synthetic, 'tmp');
  await fs.mkdir(temporary, { mode: 0o700 });
  const emptyOverleafEnvironment = path.join(synthetic, 'overleaf-smoke.env');
  await fs.writeFile(emptyOverleafEnvironment, '# Synthetic smoke configuration: no projects or credentials.\n', { mode: 0o600 });
  const environment = {
    HOME: synthetic, PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8', TMPDIR: temporary, XDG_CONFIG_HOME: path.join(synthetic, '.config'),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
    OVERLEAF_MCP_ENV_FILE: emptyOverleafEnvironment,
    OVERLEAF_MCP_WORKSPACE_DIR: path.join(synthetic, 'overleaf-projects'),
    ANTIGRAVITY_STATE_DIR: path.join(synthetic, 'antigravity-state'),
  };
  const results = [];
  try {
    for (const component of components) {
      if (component === 'tunnel-client') continue; // Verified without starting an authenticated tunnel.
      const isOverleaf = component === 'overleaf-mcp';
      const result = await probeMcpStdio({
        executable: isOverleaf ? process.execPath : locations.venvPython,
        args: isOverleaf ? [locations.overleafEntry, '--stdio'] : ['-X', 'utf8', '-u', '-m', 'antigravity_mcp'],
        env: environment, cwd: synthetic,
        expectedVersion: isOverleaf ? SOURCES.overleafVersion : SOURCES.antigravityVersion,
      });
      results.push({ component, ...result });
      log(`[OK] ${component} ${result.version}: initialize + tools/list（${result.toolCount} 个工具，无实际工具调用）`);
    }
  } finally { await fs.rm(synthetic, { recursive: true, force: true }); }
  return results;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node scripts/smoke-components-macos.mjs --home-dir <已安装的隔离用户目录> [--component all|overleaf-mcp|antigravity-mcp|tunnel-client] [--config-dir PATH]\n仅限真实 macOS；先运行 install-components-macos.mjs 安装。随后只验证组件，并在合成 HOME 中检查 stdio initialize/tools/list，不需要账号、Tunnel ID 或 IDE。');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('此 smoke CLI 仅在真实 macOS 上运行。');
  if (!options.homeDir || path.resolve(options.homeDir) === path.resolve(os.homedir())) throw new Error('smoke 必须显式提供一个与真实用户 HOME 不同的 --home-dir 隔离目录。');
  if (options.force) throw new Error('smoke 不接受 --force；请先运行安装器。');
  const verification = await createInstaller().execute({ ...options, verifyOnly: true });
  if (!verification.ok) { process.exitCode = verification.code; return; }
  await probeInstalledComponents(verification.locations, options.components);
  console.log('macOS 真实组件 smoke 通过（没有连接真实账号或调用 IDE 工具）。');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) { console.error(`[失败] ${error.message}`); process.exitCode = 1; }
}
