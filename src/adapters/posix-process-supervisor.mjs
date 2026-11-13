/**
 * One managed POSIX session. This process remains the session/group leader for
 * its entire lifetime. Stop requests carry a private capability, and signals
 * are sent only by the leader to its own group, while its pid cannot be reused.
 * No process-name search, port kill, shell, or negative pid read from a record
 * is ever used as signal authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createPosixProcessReader } from './posix-process-reader.mjs';
import {
  POSIX_PROTOCOL_VERSION, POSIX_PACKET_LIMIT, processPaths, processFault,
  readJsonFile, writeJsonFile, validateControl, publicProcessIdentity,
  sameProcessIdentity, sameCapability, pause
} from './posix-process-protocol.mjs';

const launchId = process.argv.find(value => value.startsWith('--launch-id='))?.slice('--launch-id='.length);
const reader = createPosixProcessReader();
let control = null;
let files = null;
let server = null;
let root = null;
let rootExited = false;
let starting = false;
let stopping = null;
let connections = 0;
let graceMs = 1000;
const sockets = new Set();

// A manager that dies before sending the launch payload cannot leave an idle
// supervisor indefinitely. There is no application child at this point.
const bootstrapTimer = setTimeout(() => { if (!starting) process.exit(1); }, 12000);

function saveControl(patch) {
  control = { ...control, ...patch };
  writeJsonFile(files.controlFile, control);
}

function notify(message) {
  if (process.connected) {
    try { process.send({ ...message, launchId }, () => {}); } catch { /* durable record is the recovery channel */ }
  }
}

function safeGroupSignal(signal) {
  // process.pid is read from this running process, never from persisted input.
  // Launch verifies pgid === pid before any target is created. Because this
  // leader is still alive, its group id cannot be recycled underneath the call.
  process.kill(-process.pid, signal);
}

async function escapedDescendants() {
  const all = await reader.listProcesses({ critical: true });
  const descendantIds = new Set([process.pid]);
  if (root?.pid) descendantIds.add(root.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of all) {
      if (entry.running !== false && descendantIds.has(entry.ppid) && !descendantIds.has(entry.pid)) {
        descendantIds.add(entry.pid);
        changed = true;
      }
    }
  }
  const result = [...(control.escapedProcesses || [])];
  for (const entry of all) {
    if (entry.pid === process.pid || entry.running === false || !descendantIds.has(entry.pid) || entry.pgid === process.pid) continue;
    const full = await reader.readProcess(entry.pid, { critical: true, includeCommandLine: false });
    if (full?.running !== false && full && full.processStartToken === entry.processStartToken) {
      const identity = publicProcessIdentity(full);
      if (!result.some(previous => sameProcessIdentity(identity, previous))) result.push(identity);
    }
  }
  return result;
}

async function liveEscapes(known) {
  const live = [];
  for (const recorded of known) {
    const observed = await reader.readProcess(recorded.pid, { critical: true, includeCommandLine: false });
    if (sameProcessIdentity(observed, recorded)) live.push(recorded);
  }
  return live;
}

async function shutdown(reason) {
  if (stopping) return stopping;
  stopping = (async () => {
    if (!control || !files) { process.exit(1); return; }
    saveControl({ state: 'stopping', stopReason: reason, stopRequestedAt: new Date().toISOString() });
    let escaped = [];
    try {
      escaped = await escapedDescendants();
      saveControl({ escapedProcesses: escaped, descendantsUnverified: false });
    } catch {
      // A failed process-table observation is never permission to declare exit.
      saveControl({ descendantsUnverified: true });
    }
    safeGroupSignal('SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      const members = await reader.listGroup(process.pid, { critical: true });
      const live = members.filter(entry => entry.pid !== process.pid && entry.running !== false);
      if (live.length === 0) {
        const remaining = await liveEscapes(escaped);
        if (remaining.length || control.descendantsUnverified) {
          saveControl({ state: 'unconfirmed', escapedProcesses: remaining });
          stopping = null;
          return;
        }
        saveControl({ state: 'stopped', stoppedAt: new Date().toISOString() });
        if (server) server.close();
        for (const socket of sockets) socket.destroy();
        try { fs.unlinkSync(control.socketPath); } catch { /* no recursive deletion */ }
        try { fs.rmdirSync(path.dirname(control.socketPath)); } catch { /* private directory only */ }
        process.exit(0);
        return;
      }
      await pause(40);
    }
    const remaining = await liveEscapes(escaped);
    saveControl({ killEscalated: true, escapedProcesses: remaining });
    // The owner dies in this same signal. Its durable stopping record remains
    // until the controller proves that every member of this group has exited.
    safeGroupSignal('SIGKILL');
  })().catch(error => {
    // Unexpected helper/file failure leaves the owner alive and its lease held.
    // It can still authenticate another stop attempt, but never reports success.
    const detail = error?.helperCode || error?.code;
    try { saveControl({ state: 'unconfirmed', descendantsUnverified: true,
      controlFaultCode: typeof detail === 'string' && /^[A-Z_0-9]{1,64}$/.test(detail) ? detail : 'PROCESS_CONTROL_UNAVAILABLE' }); }
    catch { /* retain the previous durable lease */ }
    stopping = null;
  });
  return stopping;
}

function handleRequest(socket, request) {
  const respond = payload => socket.end(JSON.stringify({ version: POSIX_PROTOCOL_VERSION,
    requestId: request?.requestId, launchId, ...payload }) + '\n');
  if (!request || request.version !== POSIX_PROTOCOL_VERSION || request.launchId !== launchId ||
      typeof request.requestId !== 'string' || request.requestId.length > 80 ||
      !sameCapability(request.token, control.token)) {
    respond({ ok: false, code: 'PROCESS_IDENTITY_MISMATCH' });
    return;
  }
  if (request.action === 'inspect') {
    respond({ ok: true, state: control.state, supervisorPid: process.pid,
      rootRunning: Boolean(root && !rootExited), identity: control.record });
    return;
  }
  if (request.action === 'stop') {
    if (!sameProcessIdentity(request.identity, control.record) ||
        request.identity?.posix?.launchId !== launchId) {
      respond({ ok: false, code: 'PROCESS_IDENTITY_MISMATCH' });
      return;
    }
    respond({ ok: true, accepted: true });
    void shutdown('requested');
    return;
  }
  respond({ ok: false, code: 'PROCESS_CONTROL_PROTOCOL_ERROR' });
}

async function openControlSocket() {
  server = net.createServer(socket => {
    if (connections >= 8) { socket.destroy(); return; }
    connections += 1;
    sockets.add(socket);
    let bytes = '';
    let handled = false;
    socket.setTimeout(2000, () => socket.destroy());
    socket.once('close', () => { connections -= 1; sockets.delete(socket); });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      bytes += chunk.toString('utf8');
      if (Buffer.byteLength(bytes) > POSIX_PACKET_LIMIT) { socket.destroy(); return; }
      const end = bytes.indexOf('\n');
      if (end < 0) return;
      handled = true;
      try { handleRequest(socket, JSON.parse(bytes.slice(0, end))); } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(control.transport === 'tcp'
      ? { host: '127.0.0.1', port: 0, exclusive: true }
      : control.socketPath, resolve);
  });
  if (control.transport === 'tcp') saveControl({ port: server.address().port });
  else fs.chmodSync(control.socketPath, 0o600);
  server.on('error', () => { void shutdown('control-channel-error'); });
}

async function launch(payload) {
  starting = true;
  clearTimeout(bootstrapTimer);
  files = processPaths(payload.dataDir, payload.service);
  control = validateControl(readJsonFile(files.controlFile, { privateFile: true, allowMissing: false }), payload.service);
  if (payload.launchId !== launchId || control.launchId !== launchId || !sameCapability(payload.token, control.token)) {
    throw processFault('PROCESS_IDENTITY_MISMATCH');
  }
  graceMs = Math.max(100, Math.min(Number(payload.stopGraceMs) || 1000, 10000));
  const owner = await reader.readProcess(process.pid, { critical: true });
  if (!owner || owner.pgid !== process.pid) throw processFault('PROCESS_SESSION_UNCONFIRMED');
  saveControl({ supervisor: publicProcessIdentity(owner), supervisorPid: process.pid, state: 'starting' });
  await openControlSocket();
  root = spawn(payload.command, payload.args, {
    cwd: payload.cwd || undefined, env: payload.env, stdio: 'ignore', detached: false, shell: false
  });
  await new Promise((resolve, reject) => {
    root.once('spawn', resolve);
    root.once('error', () => { rootExited = true; reject(processFault('SPAWN_FAILED')); });
    root.once('exit', () => {
      rootExited = true;
      // Reaping a root never abandons its MCP/cloudflared descendants.
      if (control.record) void shutdown('root-exited');
    });
  });

  // A Homebrew entry point may exec its libexec binary immediately. Wait for
  // two stable observations, then record the actual mapped executable.
  let previous = null;
  let observed = null;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !rootExited) {
    const current = await reader.readProcess(root.pid, { critical: true, includeCommandLine: false });
    if (current && current.running !== false && current.ppid === process.pid && current.pgid === process.pid) {
      if (previous && sameProcessIdentity(current, previous)) { observed = current; break; }
      previous = current;
    }
    await pause(40);
  }
  if (!observed || rootExited) throw processFault('PROCESS_LAUNCH_UNCONFIRMED');
  const identity = publicProcessIdentity(observed);
  const record = { ...identity, running: true, processId: identity.pid,
    executable: identity.executablePath, startedAt: identity.startTime, creationDate: identity.startTime,
    service: payload.service, operationId: payload.operationId,
    command: payload.requestedCommand, args: payload.args,
    posix: { version: POSIX_PROTOCOL_VERSION, scope: payload.service, launchId,
      supervisorPid: process.pid, processGroupId: process.pid } };
  // The environment and control token never enter the public runtime record.
  // Persist ownership BEFORE acknowledging launch, so a lost IPC reply cannot
  // authorize a second launch over an untracked first one.
  saveControl({ state: 'running', record });
  writeJsonFile(files.recordFile, record);
  notify({ kind: 'ready', identity: record });
}

process.on('message', message => {
  if (message?.action === 'abort') {
    if (control && message.launchId === launchId && sameCapability(message.token, control.token)) void shutdown('launch-aborted');
    return;
  }
  if (message?.action !== 'launch' || starting) return;
  void launch(message).catch(error => {
    notify({ kind: 'launch-error', code: error?.code === 'SPAWN_FAILED' ? 'SPAWN_FAILED' : 'PROCESS_LAUNCH_UNCONFIRMED', helperCode: error?.code });
    if (control?.supervisor) void shutdown('launch-failed');
    else process.exit(1);
  });
});
process.on('disconnect', () => { if (!starting) process.exit(1); });
// SIGTERM from our own graceful group signal must leave the owner alive until
// it has observed child exit. External TERM/INT initiates the same cleanup.
process.on('SIGTERM', () => { if (!stopping) void shutdown('signal'); });
process.on('SIGINT', () => { if (!stopping) void shutdown('signal'); });
process.on('uncaughtException', () => { if (control?.supervisor) void shutdown('supervisor-error'); else process.exit(1); });
process.on('unhandledRejection', () => { if (control?.supervisor) void shutdown('supervisor-error'); else process.exit(1); });
