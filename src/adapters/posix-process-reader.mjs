import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPosixCommandRunner, posixControlFault } from './posix-helper-runner.mjs';

const PS = '/bin/ps';
const LSOF = '/usr/sbin/lsof';
const SYSCTL = '/usr/sbin/sysctl';
const GETCONF = '/usr/bin/getconf';
const PS_FIELDS = 'pid=,ppid=,pgid=,uid=,stat=,lstart=';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const gone = error => error?.code === 'ENOENT' || error?.code === 'ESRCH';
const control = helperCode => posixControlFault('PROCESS_CONTROL_UNCONFIRMED', helperCode);

function assertPid(value, label = 'PID') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw control(`POSIX_INVALID_${label}`);
  }
  return value;
}

function sameBirth(left, right) {
  return Boolean(left && right && left.pid === right.pid && left.uid === right.uid &&
    left.pgid === right.pgid && left.processStartToken === right.processStartToken);
}

/** Parse only the C-locale numeric/strftime fields; never split an executable path. */
export function parseDarwinPsRow(line, bootToken) {
  const match = String(line).match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/);
  if (!match) throw control('POSIX_PS_OUTPUT_INVALID');
  const [, pidText, ppidText, pgidText, uidText, state, weekday, monthText, dayText, hourText, minuteText, secondText, yearText] = match;
  const [pid, ppid, pgid, uid] = [pidText, ppidText, pgidText, uidText].map(Number);
  if (![pid, ppid, pgid, uid].every(Number.isSafeInteger) || pid <= 0 || pgid < 0 || state.length > 16) {
    throw control('POSIX_PS_OUTPUT_INVALID');
  }
  const [year, month, day, hour, minute, second] =
    [Number(yearText), MONTHS.indexOf(monthText), Number(dayText), Number(hourText), Number(minuteText), Number(secondText)];
  const instant = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (month < 0 || year < 1970 || instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month ||
      instant.getUTCDate() !== day || instant.getUTCHours() !== hour || instant.getUTCMinutes() !== minute ||
      instant.getUTCSeconds() !== second || instant.toUTCString().slice(0, 3) !== weekday) {
    throw control('POSIX_PS_OUTPUT_INVALID');
  }
  return {
    pid, ppid, pgid, uid, state, running: !state.startsWith('Z'), startTime: instant.toISOString(),
    // Apple ps lstarted() reads p_starttime.tv_sec, not microseconds. This token
    // is intentionally labelled seconds and is NOT sufficient signal authority.
    // The managed supervisor's separate launch identity supplies that authority.
    processStartToken: `darwin-ps-seconds:${bootToken}:${instant.getTime() / 1000}`,
    startTimePrecision: 'seconds'
  };
}

export function parseLinuxProcStat(text) {
  const match = String(text).match(/^(\d+) \(([\s\S]*)\) ([\s\S]+)$/);
  if (!match) throw control('POSIX_PROC_STAT_INVALID');
  const fields = match[3].trim().split(/\s+/);
  if (fields.length < 20 || !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[19])) {
    throw control('POSIX_PROC_STAT_INVALID');
  }
  const [pid, ppid, pgid] = [match[1], fields[1], fields[2]].map(Number);
  if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid <= 0 || ppid < 0 || pgid <= 0) {
    throw control('POSIX_PROC_STAT_INVALID');
  }
  return { pid, ppid, pgid, state: fields[0], startTicks: fields[19] };
}

/** lsof -F0 uses NUL field terminators and newline record separators. */
export function parseLsofNames(output, expectedPid) {
  assertPid(expectedPid);
  if (typeof output !== 'string') throw control('POSIX_LSOF_OUTPUT_INVALID');
  const records = output.includes('\0') ? output.split('\0') : output.split('\n');
  const names = [];
  let pid = null;
  for (let record of records) {
    // Record separators precede a field; a file name's spaces are preserved.
    record = record.replace(/^[\r\n]+/, '');
    if (!record) continue;
    if (record[0] === 'p') {
      if (!/^p[1-9]\d*$/.test(record) || Number(record.slice(1)) !== expectedPid) {
        throw control('POSIX_LSOF_PID_MISMATCH');
      }
      pid = expectedPid;
    } else if (record[0] === 'f') {
      // Apple lsof versions may emit their file-set descriptor even when only
      // names were requested. It carries no ownership authority; preserve the
      // required preceding pid and validate the simple descriptor field.
      if (pid !== expectedPid || !/^f(?:[0-9]+|txt|mem|cwd|rtd)$/.test(record)) {
        throw control('POSIX_LSOF_OUTPUT_INVALID');
      }
    } else if (record[0] === 'n') {
      if (pid !== expectedPid || !record.slice(1)) throw control('POSIX_LSOF_OUTPUT_INVALID');
      names.push(record.slice(1));
    } else {
      throw control('POSIX_LSOF_OUTPUT_INVALID');
    }
  }
  if (output.trim() && pid === null) throw control('POSIX_LSOF_OUTPUT_INVALID');
  return names;
}

function listenerFromAddress(address, pid) {
  const match = String(address).match(/^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)(?: \(LISTEN\))?$/);
  if (!match) return null;
  const host = match[1] || match[2];
  const port = Number(match[3]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
  const ipv4 = host.split('.').map(Number);
  const loopback4 = /^127(?:\.\d{1,3}){3}$/.test(host) && ipv4.every(octet => octet >= 0 && octet <= 255);
  const loopback6 = host === '::1' || host === '0:0:0:0:0:0:0:1';
  if (!loopback4 && !loopback6) return null;
  const localAddress = loopback6 ? '::1' : host;
  return { pid, processId: pid, localAddress, localPort: port, isLoopback: true,
    healthURL: `http://${loopback6 ? '[::1]' : localAddress}:${port}` };
}

function uniqueListeners(listeners) {
  return [...new Map(listeners.filter(Boolean).map(row => [`${row.localAddress}:${row.localPort}`, row])).values()]
    .sort((left, right) => left.localPort - right.localPort || left.localAddress.localeCompare(right.localAddress));
}

function decodeProcAddress(hex, littleEndian) {
  if (!/^(?:[a-f\d]{8}|[a-f\d]{32})$/i.test(hex)) return null;
  const bytes = [];
  for (let offset = 0; offset < hex.length; offset += 8) {
    const word = [...Buffer.from(hex.slice(offset, offset + 8), 'hex')];
    bytes.push(...(littleEndian ? word.reverse() : word));
  }
  if (bytes.length === 4) return bytes.join('.');
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return '[::1]';
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return bytes.slice(12).join('.');
  }
  return null;
}

export function parseLinuxTcpListeners(output, socketInodes, pid, { littleEndian = os.endianness() === 'LE' } = {}) {
  const result = [];
  const lines = String(output).trim().split('\n');
  if (!lines.length || !/\blocal_address\b/.test(lines[0])) throw control('POSIX_TCP_TABLE_INVALID');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) throw control('POSIX_TCP_TABLE_INVALID');
    if (fields[3] !== '0A' || !socketInodes.has(fields[9])) continue;
    const [hexAddress, hexPort] = fields[1].split(':');
    if (!/^[a-f\d]{4}$/i.test(hexPort || '')) throw control('POSIX_TCP_TABLE_INVALID');
    const host = decodeProcAddress(hexAddress, littleEndian);
    if (!host) continue;
    result.push(listenerFromAddress(`${host}:${parseInt(hexPort, 16)}`, pid));
  }
  return uniqueListeners(result);
}

/**
 * OS observations for an identity-owning controller. These functions never send
 * signals and never infer ownership from a port or from a matching executable.
 *
 * Darwin field semantics are from Apple's ps/print.c and ps/keyword.c:
 * https://github.com/apple-oss-distributions/adv_cmds/tree/main/ps
 * comm is argv[0] and a non-final command field is truncated. Therefore each
 * command field is queried alone with -ww and comm is cross-checked against
 * lsof's mapped text files, followed by another birth/comm observation.
 * https://github.com/apple-oss-distributions/lsof/blob/main/lsof/lsof.8
 */
export function createPosixProcessReader({
  platform = process.platform,
  runCommand = null,
  fsImpl = fs,
  procRoot = '/proc',
  linuxClockTicks = null,
  ...runnerOptions
} = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw control('POSIX_PLATFORM_UNSUPPORTED');
  const command = runCommand || createPosixCommandRunner(runnerOptions);
  let bootPromise = null;

  async function run(executable, args, options) {
    let result;
    try { result = await command(executable, args, options); }
    catch (error) {
      if (error?.controlChannel === true) throw error;
      throw control('POSIX_HELPER_FAILED');
    }
    if (!result || !Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      throw control('POSIX_HELPER_RESPONSE_INVALID');
    }
    return result;
  }

  async function boot(options) {
    if (!bootPromise) {
      bootPromise = (async () => {
        if (platform === 'darwin') {
          const result = await run(SYSCTL, ['-n', 'kern.boottime'], options);
          const match = result.stdout.match(/^\s*\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/);
          if (result.code !== 0 || result.stderr.trim() || !match) throw control('POSIX_BOOT_ID_UNAVAILABLE');
          return { token: `${match[1]}.${match[2]}` };
        }
        const [bootId, stat] = await Promise.all([
          fsImpl.readFile(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8'),
          fsImpl.readFile(path.join(procRoot, 'stat'), 'utf8')
        ]);
        const btime = stat.match(/^btime\s+(\d+)\s*$/m);
        if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(bootId.trim()) || !btime) {
          throw control('POSIX_BOOT_ID_UNAVAILABLE');
        }
        let ticks = linuxClockTicks;
        if (ticks === null) {
          const result = await run(GETCONF, ['CLK_TCK'], options);
          if (result.code !== 0 || result.stderr.trim() || !/^\d+\s*$/.test(result.stdout)) {
            throw control('POSIX_CLOCK_TICKS_UNAVAILABLE');
          }
          ticks = Number(result.stdout.trim());
        }
        if (!Number.isSafeInteger(ticks) || ticks <= 0) throw control('POSIX_CLOCK_TICKS_UNAVAILABLE');
        return { token: bootId.trim(), bootSeconds: Number(btime[1]), ticks };
      })().catch(error => {
        bootPromise = null;
        if (error?.controlChannel) throw error;
        throw control('POSIX_BOOT_ID_UNAVAILABLE');
      });
    }
    return bootPromise;
  }

  async function readMetadata(pid, options) {
    assertPid(pid);
    const context = await boot(options);
    if (platform === 'darwin') {
      const result = await run(PS, ['-ww', '-p', String(pid), '-o', PS_FIELDS], options);
      if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return null;
      if (result.code !== 0 || result.stderr.trim()) throw control('POSIX_PS_FAILED');
      const rows = result.stdout.trim().split('\n');
      if (rows.length !== 1 || !rows[0]) throw control('POSIX_PS_OUTPUT_INVALID');
      const row = parseDarwinPsRow(rows[0], context.token);
      if (row.pid !== pid) throw control('POSIX_PS_PID_MISMATCH');
      return row;
    }
    try {
      const directory = path.join(procRoot, String(pid));
      const [text, status] = await Promise.all([fsImpl.readFile(path.join(directory, 'stat'), 'utf8'), fsImpl.stat(directory)]);
      const row = parseLinuxProcStat(text);
      if (row.pid !== pid || !Number.isSafeInteger(status.uid) || status.uid < 0) throw control('POSIX_PROC_STAT_INVALID');
      const milliseconds = context.bootSeconds * 1000 + Number(BigInt(row.startTicks) * 1000n / BigInt(context.ticks));
      if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) throw control('POSIX_PROC_STAT_INVALID');
      return {
        ...row, uid: status.uid, running: row.state !== 'Z' && row.state !== 'X',
        startTime: new Date(milliseconds).toISOString(),
        processStartToken: `linux-proc:${context.token}:${row.startTicks}`, startTimePrecision: 'clock-ticks'
      };
    } catch (error) {
      if (gone(error)) return null;
      if (error?.controlChannel) throw error;
      throw control('POSIX_PROC_READ_FAILED');
    }
  }

  async function textField(pid, field, options) {
    const result = await run(PS, ['-ww', '-p', String(pid), '-o', `${field}=`], options);
    if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return null;
    if (result.code !== 0 || result.stderr.trim()) throw control('POSIX_PS_FAILED');
    const value = result.stdout.replace(/\r?\n$/, '');
    if (!value || /[\0\r\n]/.test(value)) throw control('POSIX_PS_OUTPUT_INVALID');
    return value;
  }

  async function canonical(value) {
    if (typeof value !== 'string' || !path.posix.isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw control('POSIX_EXECUTABLE_PATH_UNVERIFIED');
    }
    try { return await fsImpl.realpath(value); }
    catch { throw control('POSIX_EXECUTABLE_PATH_UNVERIFIED'); }
  }

  async function readProcess(pid, { critical = false, includeCommandLine = true } = {}) {
    const options = { critical };
    const first = await readMetadata(pid, options);
    if (!first || !first.running) return first && { ...first, executablePath: null };
    if (platform === 'linux') {
      let executablePath;
      let argv = null;
      try {
        const directory = path.join(procRoot, String(pid));
        executablePath = await fsImpl.readlink(path.join(directory, 'exe'));
        if (!path.posix.isAbsolute(executablePath)) throw control('POSIX_EXECUTABLE_PATH_UNVERIFIED');
        if (includeCommandLine) {
          const raw = await fsImpl.readFile(path.join(directory, 'cmdline'));
          if (raw.length > 1024 * 1024) throw control('POSIX_COMMAND_LINE_TOO_LARGE');
          argv = raw.toString('utf8').split('\0');
          if (argv.at(-1) === '') argv.pop();
        }
        const second = await readMetadata(pid, options);
        if (!second || !second.running) return second && { ...second, executablePath: null };
        const secondPath = await fsImpl.readlink(path.join(directory, 'exe'));
        if (!sameBirth(first, second) || executablePath !== secondPath) throw control('POSIX_PROCESS_CHANGED');
        return { ...second, executablePath, ...(argv ? { argv, commandLine: argv.join(' ') } : {}) };
      } catch (error) {
        if (gone(error)) {
          const remaining = await readMetadata(pid, options);
          if (!remaining || !remaining.running) return remaining && { ...remaining, executablePath: null };
        }
        if (error?.controlChannel) throw error;
        throw control('POSIX_PROCESS_READ_FAILED');
      }
    }

    const comm = await textField(pid, 'comm', options);
    if (comm === null) {
      const remaining = await readMetadata(pid, options);
      if (!remaining || !remaining.running) return remaining && { ...remaining, executablePath: null };
      throw control('POSIX_PROCESS_CHANGED');
    }
    const executablePath = await canonical(comm);
    const mapped = await run(LSOF, ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-F0pn'], options);
    if (mapped.code !== 0 || mapped.stderr.trim()) {
      const remaining = await readMetadata(pid, options);
      if (!remaining || !remaining.running) return remaining && { ...remaining, executablePath: null };
      throw control('POSIX_EXECUTABLE_PATH_UNVERIFIED');
    }
    const mappedNames = parseLsofNames(mapped.stdout, pid);
    let mappedMatch = false;
    for (const name of mappedNames) {
      try { if (await canonical(name) === executablePath) mappedMatch = true; }
      catch { /* unrelated inaccessible mappings do not prove the executable */ }
    }
    if (!mappedMatch) throw control('POSIX_EXECUTABLE_PATH_UNVERIFIED');
    const commandLine = includeCommandLine ? await textField(pid, 'args', options) : null;
    const finalComm = await textField(pid, 'comm', options);
    const second = await readMetadata(pid, options);
    if (!second || !second.running) return second && { ...second, executablePath: null };
    if (!sameBirth(first, second) || comm !== finalComm || (includeCommandLine && commandLine === null)) {
      throw control('POSIX_PROCESS_CHANGED');
    }
    return { ...second, executablePath, executableEvidence: 'comm-and-mapped-text', ...(includeCommandLine ? { commandLine } : {}) };
  }

  async function listProcesses({ critical = false } = {}) {
    const options = { critical };
    const context = await boot(options);
    if (platform === 'darwin') {
      const result = await run(PS, ['-A', '-ww', '-o', PS_FIELDS], options);
      if (result.code !== 0 || result.stderr.trim() || !result.stdout.trim()) throw control('POSIX_PS_FAILED');
      // ps -A may include kernel_task (pid/pgid zero); it is not a user process
      // and cannot belong to one of our positive session-owner process groups.
      // Other system processes may legitimately have pgid zero as well.
      const rows = result.stdout.trim().split('\n').filter(line => !/^\s*0\s/.test(line))
        .map(line => parseDarwinPsRow(line, context.token));
      if (new Set(rows.map(row => row.pid)).size !== rows.length) throw control('POSIX_PS_OUTPUT_INVALID');
      return rows;
    }
    let entries;
    try { entries = await fsImpl.readdir(procRoot); }
    catch { throw control('POSIX_PROC_LIST_FAILED'); }
    const rows = [];
    for (const entry of entries) {
      if (!/^[1-9]\d*$/.test(entry)) continue;
      const row = await readMetadata(Number(entry), options);
      if (row) rows.push(row);
    }
    return rows;
  }

  async function listGroup(pgid, options = {}) {
    assertPid(pgid, 'PGID');
    return (await listProcesses(options)).filter(row => row.pgid === pgid);
  }

  async function listeners(pid, { critical = false } = {}) {
    const options = { critical };
    const first = await readMetadata(pid, options);
    if (!first || !first.running) return [];
    let observed;
    if (platform === 'darwin') {
      const result = await run(LSOF, ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-F0pn'], options);
      if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) observed = [];
      else {
        if (result.code !== 0 || result.stderr.trim()) throw control('POSIX_LISTENER_READ_FAILED');
        observed = uniqueListeners(parseLsofNames(result.stdout, pid).map(name => listenerFromAddress(name, pid)));
      }
    } else {
      try {
        const directory = path.join(procRoot, String(pid));
        const socketInodes = new Set();
        const descriptors = await fsImpl.readdir(path.join(directory, 'fd'));
        for (const descriptor of descriptors) {
          if (!/^\d+$/.test(descriptor)) continue;
          try {
            const link = await fsImpl.readlink(path.join(directory, 'fd', descriptor));
            const match = link.match(/^socket:\[(\d+)\]$/);
            if (match) socketInodes.add(match[1]);
          } catch (error) { if (!gone(error)) throw error; }
        }
        observed = [];
        for (const protocol of ['tcp', 'tcp6']) {
          try {
            const table = await fsImpl.readFile(path.join(directory, 'net', protocol), 'utf8');
            observed.push(...parseLinuxTcpListeners(table, socketInodes, pid));
          } catch (error) {
            if (protocol === 'tcp6' && gone(error)) continue;
            throw error;
          }
        }
        observed = uniqueListeners(observed);
      } catch (error) {
        if (gone(error)) {
          const remaining = await readMetadata(pid, options);
          if (!remaining || !remaining.running) return [];
        }
        if (error?.controlChannel) throw error;
        throw control('POSIX_LISTENER_READ_FAILED');
      }
    }
    const second = await readMetadata(pid, options);
    if (!second || !second.running) return [];
    if (!sameBirth(first, second)) throw control('POSIX_PROCESS_CHANGED');
    return observed;
  }

  return { platform, readProcess, listProcesses, listGroup, listeners };
}
