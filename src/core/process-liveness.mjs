/**
 * Liveness reconciliation for persisted instance records.
 *
 * An `instance_runtime` row is a CLAIM written once a lifecycle effect was
 * verified; it is not a live observation. When the process disappears (the
 * console is killed, the machine sleeps, tunnel-client is terminated externally)
 * the row keeps saying `running` until the lifecycle writes a newer state — which
 * never happens if nobody runs another lifecycle action. Publishing that claim
 * made the console render a phantom running instance, and made "parallel start"
 * skip an account that was in fact down.
 *
 * A dead pid can never mean "running", so these helpers only ever DOWNGRADE a
 * state; they never invent a running process. The persisted row is deliberately
 * left untouched: the lifecycle owns state transitions and writes them only after
 * a verified effect (see src/core/instance-lifecycle.mjs).
 *
 * Known limitation: pid EXISTENCE is not pid IDENTITY. Windows recycles pids, so
 * after a reboot an old pid can land on an unrelated process and be reported
 * alive. Shelling out to read the boot time (WMI) costs ~1s and would stall the
 * dashboard read path; `os.uptime()` cannot be used either, because on Windows it
 * excludes sleep time and would therefore mis-date the boot instant after any
 * suspend. Proving identity requires the async `processController.verify()` path
 * the lifecycle already uses. Until that is wired into a probe, a recycled pid
 * remains a residual (safe-direction) gap: the worst case is the pre-existing
 * phantom row, which the action layer still catches with ALREADY_RUNNING.
 */

const RUNNING = 'running';

/**
 * Existence probe. `process.kill(pid, 0)` only checks existence; EPERM means the
 * process exists but is owned by someone else, which still counts as alive.
 */
export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * Reconciles one public instance record against the live process table.
 *
 * @param {object} record public instance record (store DTO or observer merge)
 * @param {Date} [now] timestamp stamped on the downgrade
 * @returns {object} the same record when it is not a `running` claim or its pid is
 *   alive, otherwise a copy downgraded to `stopped` / `process_not_found`
 */
export function reconcileStaleRunning(record, now = new Date()) {
  if (!record || typeof record !== 'object') return record;
  const state = record.state ?? record.runtimeState;
  if (state !== RUNNING) return record;
  if (isProcessAlive(record.pid)) return record;
  return {
    ...record,
    state: 'stopped',
    pid: null,
    // Ownership and management both describe evidence about a LIVE process. A
    // downgraded row must not keep claiming either (store.mjs keeps
    // `managed === owned`; leaving managed true published
    // `{state:'stopped', owned:false, managed:true}`).
    owned: false,
    managed: false,
    identityVerified: false,
    reasonCode: 'process_not_found',
    observedAt: now.toISOString()
  };
}
