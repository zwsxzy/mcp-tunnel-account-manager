/**
 * macOS/Linux process control. Only an authenticated, still-live session owner
 * sends termination signals; the manager never signals a pid read from disk.
 * A Darwin ps start time has second precision, so it is corroborating evidence,
 * never the capability that authorizes termination.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPosixProcessReader } from './posix-process-reader.mjs';
import {
  POSIX_PROTOCOL_VERSION, POSIX_PACKET_LIMIT, POSIX_SOCKET_PATH_LIMIT,
  assertProcessScope, processPaths, processFault, readJsonFile, writeJsonFile,
  sameProcessIdentity, validateControl, pause
} from './posix-process-protocol.mjs';

const supervisorScript = fileURLToPath(new URL('./posix-process-supervisor.mjs', import.meta.url));
const pendingLaunches = new Set();

function validateLaunch({ command, args, env, cwd }) {
  if (typeof command !== 'string' || !command || command.includes('\0') ||
      !Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0')) ||
      !env || typeof env !== 'object' || Array.isArray(env) ||
      (cwd !== undefined && cwd !== null && (typeof cwd !== 'string' || !cwd || cwd.includes('\0')))) {
    throw processFault('INVALID_LAUNCH_PAYLOAD');
  }
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(env))) {
    if (!name || /[=\0]/.test(name) || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'string' || descriptor.value.includes('\0')) {
      throw processFault('INVALID_LAUNCH_PAYLOAD');
    }
  }
  if (Buffer.byteLength(JSON.stringify({ command, args, env, cwd })) > POSIX_PACKET_LIMIT) {
    throw processFault('INVALID_LAUNCH_PAYLOAD');
  }
}

function resolveExecutable(command, env, cwd) {
  const candidates = command.includes('/')
    ? [path.resolve(cwd || process.cwd(), command)]
    : String(env.PATH || '/usr/bin:/bin').split(':').filter(Boolean).map(dir => path.resolve(cwd || process.cwd(), dir, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch { /* Keep looking only in the supplied child PATH. */ }
  }
  throw processFault('EXECUTABLE_NOT_FOUND', 'The selected executable is unavailable');
}

function defaultEnvironment() {
  const result = {};
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (typeof process.env[name] === 'string') result[name] = process.env[name];
  }
  return result;
}

function cleanupControlEndpoint(control) {
  // SIGKILL cannot unlink a Unix socket. Only remove this exact socket and its
  // empty private directory after group exit has been proved; never recurse.
  const directory = path.dirname(control.socketPath);
  if (path.basename(control.socketPath) !== 'ctl' || !/^mtam-[A-Za-z0-9]+$/.test(path.basename(directory))) return;
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return;
    try {
      const endpoint = fs.lstatSync(control.socketPath);
      if (!endpoint.isSocket()) return;
      fs.unlinkSync(control.socketPath);
    } catch (error) { if (error.code !== 'ENOENT') return; }
    fs.rmdirSync(directory);
  } catch { /* preserve unexpected files and report process state independently */ }
}

export function requestPosixSupervisor(control, action, identity, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let settled = false;
    let bytes = '';
    let socket;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(processFault('PROCESS_CONTROL_TIMEOUT')), timeoutMs);
    try {
      socket = net.createConnection(control.transport === 'tcp'
        ? { host: '127.0.0.1', port: control.port }
        : { path: control.socketPath });
      socket.once('connect', () => socket.write(JSON.stringify({
        version: POSIX_PROTOCOL_VERSION, requestId, launchId: control.launchId,
        token: control.token, action, identity
      }) + '\n'));
      socket.on('data', chunk => {
        bytes += chunk.toString('utf8');
        if (Buffer.byteLength(bytes) > POSIX_PACKET_LIMIT) return finish(processFault('PROCESS_CONTROL_PROTOCOL_ERROR'));
        const end = bytes.indexOf('\n');
        if (end < 0) return;
        try {
          const response = JSON.parse(bytes.slice(0, end));
          if (response.version !== POSIX_PROTOCOL_VERSION || response.requestId !== requestId ||
              response.launchId !== control.launchId) throw new Error('Invalid envelope');
          if (response.ok !== true) return finish(processFault(response.code || 'PROCESS_CONTROL_UNAVAILABLE'));
          finish(null, response);
        } catch { finish(processFault('PROCESS_CONTROL_PROTOCOL_ERROR')); }
      });
      socket.once('error', () => finish(processFault('PROCESS_CONTROL_UNAVAILABLE')));
      socket.once('close', () => finish(processFault('PROCESS_CONTROL_UNAVAILABLE')));
    } catch { finish(processFault('PROCESS_CONTROL_UNAVAILABLE')); }
  });
}

export function createPosixProcessController({
  dataDir, paths = {}, platform = process.platform, processReader = null,
  buildDefaultEnvironment = defaultEnvironment, supervisorEnvironment = defaultEnvironment(),
  socketRoot = platform === 'darwin' ? '/tmp' : os.tmpdir(),
  controlTransport = 'unix',
  spawnSupervisor = spawn, requestControl = requestPosixSupervisor,
  criticalServiceIds = [], helperBudget, helperBudgetOptions, spawnHelper,
  helperExecutionTimeoutMs = 12000, helperKillGraceMs = 5000, setTimeoutFn, clearTimeoutFn,
  launchTimeoutMs = 12000, controlTimeoutMs = 5000, stopTimeoutMs = 10000, stopGraceMs = 1000
} = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw processFault('PROCESS_PLATFORM_UNSUPPORTED');
  if (!['unix', 'tcp'].includes(controlTransport)) throw processFault('PROCESS_TRANSPORT_UNSUPPORTED');
  if (typeof dataDir !== 'string' || !dataDir) throw processFault('INVALID_PROCESS_DATA_DIR');
  for (const value of [launchTimeoutMs, controlTimeoutMs, stopTimeoutMs, stopGraceMs]) {
    if (!Number.isFinite(value) || value <= 0) throw processFault('INVALID_PROCESS_TIMEOUT');
  }
  const reader = processReader || createPosixProcessReader({
    platform, helperBudget, helperBudgetOptions, spawnHelper, helperExecutionTimeoutMs, helperKillGraceMs,
    setTimeoutFn, clearTimeoutFn
  });
  const criticalIds = new Set(Array.isArray(criticalServiceIds) ? criticalServiceIds.map(String) : []);
  const isCritical = scope => criticalIds.has(scope) || criticalIds.has(String(scope).split('__')[0]);

  function loadControl(scope) {
    const file = processPaths(dataDir, scope).controlFile;
    const control = readJsonFile(file, { privateFile: true });
    return control ? validateControl(control, scope) : null;
  }

  function recordFor(control, stored) {
    const record = stored?.posix?.launchId === control.launchId ? stored : control.record;
    if (!record || record.posix?.scope !== control.scope || record.posix?.launchId !== control.launchId ||
        !sameProcessIdentity(record, control.record)) throw processFault('PROCESS_RECORD_UNTRUSTED');
    return record;
  }

  async function proveAbsent(control, { critical = false } = {}) {
    // Even after the root exits, a cloudflared/MCP listener can remain. A stopped
    // receipt is forbidden until the whole anchored process group is gone.
    const pgid = control.supervisor?.pid || control.supervisorPid;
    if (!Number.isSafeInteger(pgid) || pgid <= 0) throw processFault('PROCESS_LAUNCH_UNCONFIRMED');
    const group = await reader.listGroup(pgid, { critical });
    if (group.some(entry => entry.running !== false && !String(entry.state || '').startsWith('Z'))) {
      throw processFault('PROCESS_DESCENDANTS_UNCONFIRMED', undefined, { exitUnconfirmed: true });
    }
    const recorded = control.record;
    if (recorded) {
      const live = await reader.readProcess(recorded.pid, { critical, includeCommandLine: false });
      if (sameProcessIdentity(live, recorded)) throw processFault('PROCESS_EXIT_UNCONFIRMED', undefined, { exitUnconfirmed: true });
    }
    for (const escaped of control.escapedProcesses || []) {
      const live = await reader.readProcess(escaped.pid, { critical, includeCommandLine: false });
      if (sameProcessIdentity(live, escaped)) throw processFault('PROCESS_DESCENDANTS_UNCONFIRMED', undefined, { exitUnconfirmed: true });
    }
    if (control.descendantsUnverified === true) throw processFault('PROCESS_DESCENDANTS_UNCONFIRMED', undefined, { exitUnconfirmed: true });
    cleanupControlEndpoint(control);
    return { running: false, absenceVerified: true, pid: recorded?.pid || null,
      operationId: recorded?.operationId || null, service: control.scope };
  }

  async function observeControl(control, stored, { includeListeners = true, critical = isCritical(control.scope) } = {}) {
    const supervisorPid = control.supervisor?.pid || control.supervisorPid;
    if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) throw processFault('PROCESS_LAUNCH_UNCONFIRMED');
    const owner = await reader.readProcess(supervisorPid, { critical, includeCommandLine: true });
    if (!owner || owner.running === false) return proveAbsent(control, { critical });
    if (!control.supervisor || !sameProcessIdentity(owner, control.supervisor) || owner.pgid !== supervisorPid) {
      // PID reuse is not ownership. Do not contact or signal a replacement.
      return proveAbsent(control, { critical });
    }
    const marker = `--launch-id=${control.launchId}`;
    const argvMatches = Array.isArray(owner.argv)
      ? owner.argv.includes(marker)
      : typeof owner.commandLine === 'string' && owner.commandLine.endsWith(` ${marker}`);
    if (!argvMatches) throw processFault('PROCESS_IDENTITY_MISMATCH');
    const record = recordFor(control, stored);
    let status;
    try {
      status = await requestControl(control, 'inspect', undefined, { timeoutMs: controlTimeoutMs });
    } catch (error) {
      const after = await reader.readProcess(supervisorPid, { critical, includeCommandLine: false });
      if (!after || after.running === false) return proveAbsent(loadControl(control.scope) || control, { critical });
      throw error;
    }
    if (!sameProcessIdentity(status.identity, record) || status.supervisorPid !== supervisorPid) {
      throw processFault('PROCESS_IDENTITY_MISMATCH');
    }
    if (status.state === 'unconfirmed') throw processFault('PROCESS_DESCENDANTS_UNCONFIRMED', undefined, { exitUnconfirmed: true });
    if (status.rootRunning !== true) {
      // The supervisor is still cleaning up the inherited group. Absence has not
      // been established, and a later account launch must not pass this point.
      throw processFault('PROCESS_EXIT_UNCONFIRMED', undefined, { exitUnconfirmed: true });
    }
    const root = await reader.readProcess(record.pid, { critical, includeCommandLine: false });
    if (!sameProcessIdentity(root, record) || root.pgid !== supervisorPid) throw processFault('PROCESS_IDENTITY_MISMATCH');
    let endpoint = null;
    if (includeListeners) {
      const listeners = await reader.listeners(record.pid, { critical });
      const after = await reader.readProcess(record.pid, { critical, includeCommandLine: false });
      if (!sameProcessIdentity(after, record)) throw processFault('PROCESS_IDENTITY_MISMATCH');
      // Never use a cached port after the listener was rebound by another pid.
      endpoint = listeners.find(item => item.localPort === stored?.localPort) ||
        (listeners.length === 1 ? listeners[0] : null);
    }
    return { ...record, running: true, managed: true, external: false,
      executable: record.executablePath, startedAt: record.startTime,
      localPort: endpoint?.localPort || null, healthURL: endpoint?.healthURL || null,
      service: control.scope };
  }

  async function inspect(scope, options = {}) {
    const files = processPaths(dataDir, scope);
    const control = loadControl(scope);
    const stored = readJsonFile(files.recordFile);
    if (control) return observeControl(control, stored, options);
    if (stored?.pid) {
      const live = await reader.readProcess(stored.pid, { critical: isCritical(scope), includeCommandLine: false });
      if (live && live.running !== false) {
        // A legacy/unverifiable record is visible, but does not grant a stop
        // capability. In particular a Windows record is never adopted on Mac.
        return { ...live, running: true, managed: false, external: true, service: scope,
          reasonCode: 'PROCESS_OWNERSHIP_UNCONFIRMED' };
      }
      if (stored.posix) throw processFault('PROCESS_RECORD_UNTRUSTED');
    }
    return { running: false, absenceVerified: true, pid: stored?.pid || null, service: scope };
  }

  function scopeForIdentity(identity) {
    return assertProcessScope(identity?.posix?.scope || identity?.instanceId || identity?.service);
  }

  function expectedRecord(identity, control) {
    if (!control?.record || identity?.posix?.launchId !== control.launchId ||
        !sameProcessIdentity(identity, control.record)) throw processFault('PROCESS_IDENTITY_MISMATCH');
    return control.record;
  }

  async function verify(identity) {
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return { valid: false, reason: 'INVALID_PROCESS_ID' };
    let scope;
    let control;
    try {
      scope = scopeForIdentity(identity);
      control = loadControl(scope);
      expectedRecord(identity, control);
    } catch (error) {
      if (['PROCESS_IDENTITY_MISMATCH', 'INVALID_PROCESS_SCOPE'].includes(error.code)) return { valid: false, reason: 'PROCESS_IDENTITY_MISMATCH' };
      throw error;
    }
    const observed = await observeControl(control, readJsonFile(processPaths(dataDir, scope).recordFile), { includeListeners: false });
    return { valid: observed.running === true, reason: observed.running ? 'VALID' : 'PROCESS_NOT_FOUND',
      processId: identity.pid, executablePath: identity.executablePath,
      creationDate: identity.startTime, processStartToken: identity.processStartToken };
  }

  async function stop(identity) {
    if (!identity?.pid) return { stopped: true };
    let scope;
    try { scope = scopeForIdentity(identity); }
    catch { throw processFault('PROCESS_IDENTITY_MISMATCH'); }
    let control = loadControl(scope);
    const expected = expectedRecord(identity, control);
    // Full path/start/launch identity is checked both here and inside the owner.
    let observed;
    try { observed = await observeControl(control, null, { includeListeners: false, critical: true }); }
    catch (error) {
      if (!['PROCESS_EXIT_UNCONFIRMED', 'PROCESS_DESCENDANTS_UNCONFIRMED'].includes(error.code)) throw error;
      observed = { running: true };
    }
    if (!observed.running) return { stopped: true };
    try {
      await requestControl(control, 'stop', expected, { timeoutMs: controlTimeoutMs });
    } catch (error) {
      // Losing the acknowledgement is not success. Continue only with observed
      // group exit; never repeat a launch or send an unverified fallback signal.
      if (!['PROCESS_CONTROL_UNAVAILABLE', 'PROCESS_CONTROL_TIMEOUT'].includes(error.code)) throw error;
    }
    const deadline = Date.now() + stopTimeoutMs;
    let retryAt = Date.now() + 250;
    while (Date.now() < deadline) {
      control = loadControl(scope) || control;
      const owner = await reader.readProcess(control.supervisor?.pid || control.supervisorPid, { critical: true, includeCommandLine: false });
      if (!owner || owner.running === false || !sameProcessIdentity(owner, control.supervisor)) {
        await proveAbsent(control, { critical: true });
        writeJsonFile(processPaths(dataDir, scope).controlFile, { ...control, state: 'stopped', stoppedAt: new Date().toISOString() });
        return { stopped: true };
      }
      if (control.state === 'unconfirmed' && Date.now() >= retryAt) {
        // A previous observation failure or a now-exited daemonized child can
        // be reconciled within the ORIGINAL stop deadline. An acknowledgement
        // is not exit, and a transient unconfirmed state is not a final result.
        let escapedStillLive = false;
        for (const escaped of control.escapedProcesses || []) {
          const live = await reader.readProcess(escaped.pid, { critical: true, includeCommandLine: false });
          if (sameProcessIdentity(live, escaped)) escapedStillLive = true;
        }
        if (!escapedStillLive) {
          try { await requestControl(control, 'stop', expected, { timeoutMs: Math.min(controlTimeoutMs, Math.max(1, deadline - Date.now())) }); }
          catch (error) { if (!['PROCESS_CONTROL_UNAVAILABLE', 'PROCESS_CONTROL_TIMEOUT'].includes(error.code)) throw error; }
        }
        retryAt = Date.now() + 250;
      }
      await pause(80);
    }
    throw processFault(control.state === 'unconfirmed' ? 'PROCESS_DESCENDANTS_UNCONFIRMED' : 'STOP_UNCONFIRMED', undefined,
      { exitUnconfirmed: true, ...(control.controlFaultCode ? { helperCode: control.controlFaultCode } : {}) });
  }

  async function launch({ service, command, args = [], env, cwd, operationId }) {
    const files = processPaths(dataDir, service);
    const launchKey = files.controlFile;
    if (pendingLaunches.has(launchKey)) throw processFault('PROCESS_LAUNCH_UNCONFIRMED');
    pendingLaunches.add(launchKey);
    let control;
    let child;
    let childCreated = false;
    try {
      const safeEnv = env === undefined || env === null ? buildDefaultEnvironment() : env;
      validateLaunch({ command, args, env: safeEnv, cwd });
      const executable = resolveExecutable(command, safeEnv, cwd);
      if (cwd) fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const previous = loadControl(service);
      if (previous) {
        const state = await observeControl(previous, readJsonFile(files.recordFile), { includeListeners: false });
        if (state.running) throw processFault('ALREADY_RUNNING');
        // Only observed group absence releases the durable service launch slot.
        fs.unlinkSync(files.controlFile);
      } else if (readJsonFile(files.recordFile)) {
        const state = await inspect(service, { includeListeners: false });
        if (state.running) throw processFault('PROCESS_OWNERSHIP_UNCONFIRMED');
      }
      fs.mkdirSync(files.runtimeDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
      const socketDir = fs.mkdtempSync(path.join(socketRoot, 'mtam-'));
      fs.chmodSync(socketDir, 0o700);
      const socketPath = path.join(socketDir, 'ctl');
      if (controlTransport === 'unix' && Buffer.byteLength(socketPath) > POSIX_SOCKET_PATH_LIMIT) {
        fs.rmdirSync(socketDir);
        throw processFault('PROCESS_SOCKET_PATH_TOO_LONG');
      }
      control = { version: POSIX_PROTOCOL_VERSION, scope: service, transport: controlTransport, launchId: crypto.randomUUID(),
        token: crypto.randomBytes(32).toString('hex'), socketPath, state: 'pending', createdAt: new Date().toISOString() };
      writeJsonFile(files.controlFile, control, { exclusive: true });

      const identity = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (child?.connected) child.disconnect();
          child?.unref();
          if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => {
          if (child?.connected) {
            try { child.send({ action: 'abort', launchId: control.launchId, token: control.token }, () => {}); } catch { /* keep the durable lease */ }
          }
          finish(processFault('PROCESS_LAUNCH_UNCONFIRMED', undefined, { exitUnconfirmed: true }));
        }, launchTimeoutMs);
        try {
          child = spawnSupervisor(process.execPath, [supervisorScript, `--launch-id=${control.launchId}`], {
            cwd: files.runtimeDir, env: supervisorEnvironment, detached: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc']
          });
          childCreated = Number.isSafeInteger(child.pid) && child.pid > 0;
          if (childCreated) {
            control = { ...control, supervisorPid: child.pid };
            writeJsonFile(files.controlFile, control);
          }
          child.once('error', () => finish(processFault(childCreated ? 'PROCESS_LAUNCH_UNCONFIRMED' : 'SPAWN_FAILED')));
          child.once('exit', () => finish(processFault('PROCESS_LAUNCH_UNCONFIRMED')));
          child.on('message', message => {
            if (!message || message.launchId !== control.launchId) return;
            if (message.kind === 'launch-error') return finish(processFault(message.code || 'PROCESS_LAUNCH_UNCONFIRMED', undefined,
              { helperCode: /^[A-Z_0-9]{1,64}$/.test(message.helperCode || '') ? message.helperCode : null }));
            if (message.kind !== 'ready') return;
            try {
              const durable = loadControl(service);
              if (durable?.state !== 'running' || !sameProcessIdentity(message.identity, durable.record)) throw processFault('PROCESS_LAUNCH_UNCONFIRMED');
              finish(null, durable.record);
            } catch (error) { finish(error); }
          });
          child.once('spawn', () => {
            childCreated = true;
            child.send({ action: 'launch', launchId: control.launchId, token: control.token,
              dataDir: path.resolve(dataDir), service, command: executable, requestedCommand: command,
              args, env: safeEnv, cwd: cwd ? path.resolve(cwd) : undefined, operationId, stopGraceMs }, error => {
              if (error) finish(processFault('PROCESS_LAUNCH_UNCONFIRMED'));
            });
          });
        } catch { finish(processFault(childCreated ? 'PROCESS_LAUNCH_UNCONFIRMED' : 'SPAWN_FAILED')); }
      });
      return identity;
    } catch (error) {
      if (control && !childCreated) {
        const current = loadControl(service);
        if (current?.launchId === control.launchId) fs.unlinkSync(files.controlFile);
        try { fs.rmdirSync(path.dirname(control.socketPath)); } catch { /* only an empty private directory is removed */ }
      }
      throw error;
    } finally {
      pendingLaunches.delete(launchKey);
    }
  }

  return {
    platform, runtimeCommand: undefined, inspect, verify, stop, launch,
    async list() {
      const runtimeDir = path.resolve(dataDir, 'runtime');
      let names;
      try { names = fs.readdirSync(runtimeDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const scopes = [...new Set(names.filter(name => name.endsWith('-posix-control.json') || name.endsWith('-process.json'))
        .map(name => name.replace(/-(?:posix-control|process)\.json$/, '')))];
      const result = [];
      // Serial inspection respects the same bounded helper lane as normal calls.
      for (const scope of scopes.sort()) result.push(await inspect(scope));
      return result;
    },
    getIntent(scope) { return readJsonFile(processPaths(dataDir, scope).intentFile); },
    clearIntent(scope, expectedOperationId) {
      const file = processPaths(dataDir, scope).intentFile;
      const current = readJsonFile(file);
      if (!current || (expectedOperationId && current.operationId !== expectedOperationId)) return false;
      fs.unlinkSync(file);
      return true;
    }
  };
}
