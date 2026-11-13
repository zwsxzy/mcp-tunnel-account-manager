/** Private protocol shared by the POSIX controller and its session owner. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SwitchFault } from '../core/switch-core.mjs';

export const POSIX_PROTOCOL_VERSION = 1;
export const POSIX_PACKET_LIMIT = 262144;
export const POSIX_SOCKET_PATH_LIMIT = 100; // macOS sockaddr_un.sun_path is 104 bytes.

export function processFault(code, message = code, details = {}) {
  return Object.assign(new SwitchFault(code, message), { controlChannel: true, ...details });
}

export function assertProcessScope(scope) {
  if (typeof scope !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/.test(scope)) {
    throw processFault('INVALID_PROCESS_SCOPE');
  }
  return scope;
}

export function processPaths(dataDir, scope) {
  assertProcessScope(scope);
  const runtimeDir = path.resolve(dataDir, 'runtime');
  return {
    runtimeDir,
    recordFile: path.join(runtimeDir, `${scope}-process.json`),
    controlFile: path.join(runtimeDir, `${scope}-posix-control.json`),
    intentFile: path.join(runtimeDir, `${scope}-intent.json`)
  };
}

/** No credentials, environment values, or private IPC capability are in this identity. */
export function publicProcessIdentity(processInfo) {
  if (!processInfo || !Number.isSafeInteger(processInfo.pid) || processInfo.pid <= 0 ||
      typeof processInfo.executablePath !== 'string' || !path.isAbsolute(processInfo.executablePath) ||
      typeof processInfo.startTime !== 'string' || !Number.isFinite(Date.parse(processInfo.startTime)) ||
      typeof processInfo.processStartToken !== 'string' || !processInfo.processStartToken) {
    throw processFault('PROCESS_IDENTITY_UNCONFIRMED');
  }
  return {
    pid: processInfo.pid,
    executablePath: processInfo.executablePath,
    startTime: processInfo.startTime,
    processStartToken: processInfo.processStartToken,
    ...(Number.isSafeInteger(processInfo.pgid) ? { pgid: processInfo.pgid } : {})
  };
}

export function sameProcessIdentity(actual, expected) {
  return Boolean(actual && expected && actual.running !== false &&
    Number.isSafeInteger(actual.pid) && actual.pid > 0 && actual.pid === expected.pid &&
    actual.executablePath === (expected.executablePath || expected.executable) &&
    actual.startTime === (expected.startTime || expected.startedAt) &&
    typeof actual.processStartToken === 'string' && actual.processStartToken.length > 0 &&
    actual.processStartToken === expected.processStartToken);
}

export function sameCapability(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string' &&
    /^[0-9a-f]{64}$/.test(actual) && /^[0-9a-f]{64}$/.test(expected) &&
    crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function readJsonFile(file, { privateFile = false, allowMissing = true } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > POSIX_PACKET_LIMIT ||
        (privateFile && ((process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid())))) {
      throw processFault('PROCESS_RECORD_UNTRUSTED');
    }
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw processFault('PROCESS_RECORD_UNREADABLE');
    }
    return parsed;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    if (error.controlChannel) throw error;
    throw processFault('PROCESS_RECORD_UNREADABLE');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function writeJsonFile(file, value, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(bytes) > POSIX_PACKET_LIMIT) throw processFault('PROCESS_RECORD_TOO_LARGE');
  if (exclusive) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return;
  }
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function validateControl(control, scope) {
  if (!control || control.version !== POSIX_PROTOCOL_VERSION || control.scope !== scope ||
      typeof control.launchId !== 'string' || !/^[0-9a-f-]{36}$/.test(control.launchId) ||
      !/^[0-9a-f]{64}$/.test(control.token || '') ||
      typeof control.socketPath !== 'string' || !path.isAbsolute(control.socketPath) ||
      Buffer.byteLength(control.socketPath) > (control.transport === 'tcp' ? 4096 : POSIX_SOCKET_PATH_LIMIT)) {
    throw processFault('PROCESS_RECORD_UNTRUSTED');
  }
  if (control.transport !== undefined && !['unix', 'tcp'].includes(control.transport)) throw processFault('PROCESS_RECORD_UNTRUSTED');
  if (control.transport === 'tcp' && control.port !== undefined &&
      (!Number.isSafeInteger(control.port) || control.port <= 0 || control.port > 65535)) throw processFault('PROCESS_RECORD_UNTRUSTED');
  return control;
}

export const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
