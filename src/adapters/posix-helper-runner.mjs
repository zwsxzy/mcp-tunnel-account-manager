import { spawn } from 'node:child_process';
import path from 'node:path';
import { SwitchFault } from '../core/switch-core.mjs';
import { createHelperBudget } from './ps-worker-pool.mjs';

// ps/lsof are short-lived control helpers, not service processes. Their budget
// is shared by every reader in this manager, with the same reserved stop lane as
// the Windows helper budget. A public timeout never frees a physical slot.
let sharedBudget = null;

export function getSharedPosixHelperBudget(options = {}) {
  if (!sharedBudget) sharedBudget = createHelperBudget(options);
  return sharedBudget;
}

export function posixControlFault(code, helperCode, extra = {}) {
  return Object.assign(new SwitchFault(code), {
    controlChannel: true,
    ...(helperCode ? { helperCode } : {}),
    ...extra
  });
}

const CONTROL_ENV = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC'
});

/**
 * Returns runCommand(executable, argv, {critical}), resolving to
 * {code, signal, stdout, stderr}. No shell, inherited application credentials,
 * user PATH lookup, or retry is involved. Only 'close' (or proven non-creation)
 * returns the physical lease; late close still releases an already timed-out
 * call's lease. Injectable child/timers make these failure paths testable.
 */
export function createPosixCommandRunner({
  helperBudget = null,
  helperBudgetOptions = {},
  spawnHelper = spawn,
  helperExecutionTimeoutMs = 12000,
  helperKillGraceMs = 5000,
  maxOutputBytes = 1024 * 1024,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  for (const [name, value] of Object.entries({ helperExecutionTimeoutMs, helperKillGraceMs, maxOutputBytes })) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  }
  let usedBudget = helperBudget;

  const runCommand = async (executable, argv = [], { critical = false } = {}) => {
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0') ||
        !Array.isArray(argv) || argv.some(value => typeof value !== 'string' || value.includes('\0')) ||
        Buffer.byteLength(JSON.stringify(argv), 'utf8') > 262144) {
      throw posixControlFault('PROCESS_CONTROL_UNAVAILABLE', 'POSIX_HELPER_INVALID_ARGUMENTS');
    }
    usedBudget ||= getSharedPosixHelperBudget(helperBudgetOptions);
    let release;
    try {
      release = await usedBudget.acquire({ critical: critical === true });
    } catch (error) {
      throw posixControlFault('PROCESS_CONTROL_CONGESTED', error?.code || 'POSIX_HELPER_QUEUE_FAILED');
    }
    let released = false;
    const releaseLease = () => {
      if (released) return;
      released = true;
      release();
    };

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnHelper(executable, argv, {
          // A supervisor inventories its own group during stop. The observer
          // must not keep that group nonempty merely by inspecting it.
          env: { ...CONTROL_ENV }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true, windowsHide: true
        });
      } catch (error) {
        releaseLease();
        reject(posixControlFault('PROCESS_CONTROL_UNAVAILABLE', 'POSIX_HELPER_SPAWN_FAILED', {
          systemCode: typeof error?.code === 'string' ? error.code : null, dispatched: false
        }));
        return;
      }

      let settled = false;
      let spawnConfirmed = false;
      let exited = false;
      let timer = null;
      let graceTimer = null;
      let failure = null;
      let outputBytes = 0;
      const stdout = [];
      const stderr = [];
      const missingPipes = [];
      const field = name => {
        try { return child?.[name]; } catch { return undefined; }
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeoutFn(timer);
        if (graceTimer !== null) clearTimeoutFn(graceTimer);
        timer = graceTimer = null;
        fn(value);
      };
      const outputFault = () => posixControlFault('PROCESS_CONTROL_UNCONFIRMED', 'POSIX_HELPER_OUTPUT_UNAVAILABLE', {
        dispatched: true, missingPipes: [...missingPipes]
      });
      const requestKill = () => {
        // Never signal a numeric PID. This is our unreaped helper child, and an
        // observed exit forbids even child.kill() while its pipes are draining.
        if (exited) return;
        try { child.kill('SIGTERM'); } catch { /* absence is still unproven */ }
      };
      const failAndBoundExit = nextFailure => {
        if (failure || settled) return;
        failure = nextFailure;
        requestKill();
        if (settled) return;
        graceTimer = setTimeoutFn(() => {
          graceTimer = null;
          finish(reject, Object.assign(failure, { exitUnconfirmed: true }));
        }, helperKillGraceMs);
      };
      const onClose = (code, signal = null) => {
        exited = true;
        releaseLease();
        if (failure) return finish(reject, failure);
        if (missingPipes.length) return finish(reject, outputFault());
        finish(resolve, {
          code, signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8')
        });
      };
      const onError = error => {
        let readablePid = false;
        let pid;
        try { pid = child.pid; readablePid = true; } catch { /* hold lease */ }
        if (!spawnConfirmed && readablePid && !pid) {
          releaseLease();
          return finish(reject, posixControlFault('PROCESS_CONTROL_UNAVAILABLE', 'POSIX_HELPER_SPAWN_FAILED', {
            systemCode: typeof error?.code === 'string' ? error.code : null, dispatched: false
          }));
        }
        failAndBoundExit(posixControlFault('PROCESS_CONTROL_UNAVAILABLE', 'POSIX_HELPER_CHANNEL_ERROR', {
          dispatched: true
        }));
      };

      // Register exit evidence before inspecting any optional stream fields. A
      // malformed returned object is not proof that no helper was created.
      try {
        if (typeof child?.on !== 'function') throw new TypeError('unobservable child');
        child.on('spawn', () => { spawnConfirmed = true; });
        child.on('exit', () => { exited = true; });
        child.on('close', onClose);
        child.on('error', onError);
      } catch {
        finish(reject, posixControlFault('PROCESS_CONTROL_UNCONFIRMED', 'POSIX_HELPER_UNOBSERVABLE', {
          dispatched: Boolean(field('pid')), exitUnconfirmed: true
        }));
        return;
      }

      for (const [name, chunks] of [['stdout', stdout], ['stderr', stderr]]) {
        const stream = field(name);
        try {
          if (typeof stream?.on !== 'function') throw new TypeError('missing pipe');
          stream.on('data', chunk => {
            if (settled || failure) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            outputBytes += bytes.length;
            if (outputBytes > maxOutputBytes) {
              failAndBoundExit(posixControlFault('PROCESS_CONTROL_UNCONFIRMED', 'POSIX_HELPER_OUTPUT_LIMIT', {
                dispatched: true
              }));
              return;
            }
            chunks.push(bytes);
          });
          stream.on('error', () => failAndBoundExit(outputFault()));
        } catch {
          missingPipes.push(name);
        }
      }
      if (settled) return;
      timer = setTimeoutFn(() => {
        timer = null;
        failAndBoundExit(missingPipes.length ? outputFault() :
          posixControlFault('PROCESS_CONTROL_TIMEOUT', 'POSIX_HELPER_TIMEOUT', { dispatched: true }));
      }, helperExecutionTimeoutMs);
    });
  };

  runCommand.getStats = () => usedBudget?.getStats() || null;
  return runCommand;
}
