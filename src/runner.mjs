import path from 'node:path';
import { executeOperation } from './core/switch-core.mjs';
import { acquireDaemonLock } from './core/daemon-lock.mjs';
import { runMcpLifecycleAction, runMcpStopAction } from './core/mcp-lifecycle.mjs';
import { runInstanceLifecycleAction } from './core/instance-lifecycle.mjs';
import {
  loadWorkRecord,
  withStartupRollback,
  rollbackOwnedResources
} from './core/runner-startup.mjs';
import { classifyQueuedWork, missingReferenceDisposition } from './core/work-item-routing.mjs';
import { createResourcePolicy } from './core/resource-policy.mjs';
import * as adaptersModule from './adapters/index.mjs';

export function createRunner({
  repo,
  adapters,
  adapterProvider,
  instanceAdapterProvider,
  dataDir,
  vault,
  resourcePolicy = null,
  resourcePolicyOptions = {}
}) {
  if (!repo || typeof repo !== 'object') {
    throw new TypeError('A valid repo object is required to create a runner');
  }

  const resolvedDataDir = dataDir
    ?? (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'McpTunnelAccountManager')
      : path.resolve('.data'));

  let resolvedAdapterProvider = adapterProvider;
  if (!resolvedAdapterProvider && adapters) {
    resolvedAdapterProvider = typeof adapters === 'function'
      ? adapters
      : Object.assign(
          async (_op, serviceId) => adapters[serviceId],
          { release: () => {} }
        );
  }

  if (!resolvedAdapterProvider) {
    if (typeof adaptersModule.createRegisteredAdapterProvider === 'function') {
      try {
        resolvedAdapterProvider = adaptersModule.createRegisteredAdapterProvider({
          dataDir: resolvedDataDir,
          vault
        });
      } catch (_) {}
    }
  }

  if (!resolvedAdapterProvider) {
    throw new TypeError('A valid adapters map or adapterProvider is required to create a runner');
  }

  if (typeof resolvedAdapterProvider !== 'function') {
    if (typeof resolvedAdapterProvider.getAdapter === 'function') {
      const orig = resolvedAdapterProvider;
      resolvedAdapterProvider = Object.assign(
        (op, serviceId) => orig.getAdapter(op, serviceId),
        { release: (id) => orig.release?.(id) }
      );
    } else {
      const map = resolvedAdapterProvider;
      resolvedAdapterProvider = Object.assign(
        async (_op, serviceId) => map[serviceId],
        { release: (id) => map.release?.(id) }
      );
    }
  }

  let started = false;
  let stopping = false;
  let startPromise = null;
  let daemonLock = null;
  let currentOperationId = null;
  let drainPromise = null;
  let pendingNotify = false;
  let lastError = null;
  let recoveryItems = null;
  let recoveryTask = null;
  let recoveryState = {
    status: 'idle',
    pending: false,
    failed: false,
    mode: 'sync',
    total: 0,
    done: 0,
    error: null
  };

  // ONE shared admission policy per manager. Every start entry point (legacy
  // action, registry action, instance action, switch) reserves from this same
  // object, so N concurrent starts cannot each be admitted against the same
  // free-memory reading.
  if (resourcePolicy && (typeof resourcePolicy.admitStart !== 'function' || typeof resourcePolicy.release !== 'function')) {
    throw new TypeError('A valid resourcePolicy with admitStart/release is required');
  }
  const policy = resourcePolicy || createResourcePolicy(resourcePolicyOptions);

  // Mutual exclusion chain for switch-core executeOperation and stop actions
  let exclusiveLockChain = Promise.resolve();
  function withExclusiveLock(fn) {
    const next = exclusiveLockChain.then(async () => {
      return await fn();
    });
    exclusiveLockChain = next.catch(() => {});
    return next;
  }

  const deps = {
    repo,
    adapters: adapters || {},
    adapterProvider: resolvedAdapterProvider,
    withExclusiveLock,
    resourcePolicy: policy,
    vault
  };

  /**
   * Provider for CONCURRENT PROFILE INSTANCES, kept strictly separate from the
   * legacy service-level provider. An instance action must never be served by a
   * legacy `ServiceAdapter`: that adapter has no `instanceId` and its configPath
   * points at the production `%APPDATA%\tunnel-client\<service>.yaml`.
   *
   * Returns null when no instance provider is available, which makes the
   * instance lifecycle reject with a safe code instead of mutating anything.
   */
  let resolvedInstanceAdapterProvider = instanceAdapterProvider || null;
  if (!resolvedInstanceAdapterProvider &&
      typeof adaptersModule.createInstanceAdapterProvider === 'function') {
    try {
      resolvedInstanceAdapterProvider = adaptersModule.createInstanceAdapterProvider({
        dataDir: resolvedDataDir,
        vault,
        resolveDefinition: async (serviceId) => {
          try {
            if (typeof repo?.getDefinition === 'function') return await repo.getDefinition(serviceId);
            if (typeof repo?.registry?.getDefinition === 'function') return await repo.registry.getDefinition(serviceId);
            if (typeof repo?.getMcp === 'function') return await repo.getMcp(serviceId);
            if (typeof repo?.registry?.getMcp === 'function') return await repo.registry.getMcp(serviceId);
          } catch (_) {}
          return null;
        }
      });
    } catch (_) {
      // Production data dirs are refused by the instance adapter's isolation
      // guard; run without an instance provider rather than risking a write.
      resolvedInstanceAdapterProvider = null;
    }
  }

  async function fetchWorkQueue() {
    if (typeof repo.getWorkQueue === 'function') {
      return await repo.getWorkQueue();
    }
    if (typeof repo.pendingOperationIds === 'function') {
      return await repo.pendingOperationIds();
    }
    return [];
  }

  async function checkLifecycleExists(id) {
    if (typeof repo.registry?.isActionId === 'function') {
      try {
        const res = await repo.registry.isActionId.call(repo.registry, id);
        if (typeof res === 'boolean') return res;
      } catch (err) {
        if (err && err.code !== 'NOT_FOUND' && err.code !== 'ACTION_NOT_FOUND') throw err;
      }
    }
    if (typeof repo.isActionId === 'function') {
      try {
        const res = await repo.isActionId.call(repo, id);
        if (typeof res === 'boolean') return res;
      } catch (err) {
        if (err && err.code !== 'NOT_FOUND' && err.code !== 'ACTION_NOT_FOUND') throw err;
      }
    }
    return false;
  }

  async function checkSwitchExists(id) {
    if (typeof repo.isOperationId === 'function') {
      try {
        const res = await repo.isOperationId.call(repo, id);
        if (typeof res === 'boolean') return res;
      } catch (err) {
        if (err && err.code !== 'NOT_FOUND') throw err;
      }
    }
    if (typeof repo.load === 'function') {
      try {
        const item = await repo.load.call(repo, id);
        return Boolean(item);
      } catch (err) {
        if (err && err.code !== 'NOT_FOUND') throw err;
        return false;
      }
    }
    return false;
  }

  async function classifyWork(id, rawItem = null) {
    let queueKind = null;
    if (rawItem && typeof rawItem === 'object') {
      if (rawItem.queueKind === 'lifecycle' || rawItem.queueKind === 'switch') {
        queueKind = rawItem.queueKind;
      } else if (rawItem.kind === 'lifecycle' || rawItem.kind === 'switch') {
        queueKind = rawItem.kind;
      } else if (rawItem.kind === 'stop' || rawItem.kind === 'start' || rawItem.kind === 'restart' || rawItem.action) {
        queueKind = 'lifecycle';
      } else if (rawItem.targets) {
        queueKind = 'switch';
      }
    }

    const [lifecycleExists, switchExists] = await Promise.all([
      checkLifecycleExists(id),
      checkSwitchExists(id)
    ]);

    return classifyQueuedWork({ queueKind, lifecycleExists, switchExists });
  }

  async function dispatchTask(id, rawItem = null) {
    const workKind = await classifyWork(id, rawItem);
    currentOperationId = id;
    try {
      if (workKind === 'lifecycle') {
        // A lifecycle action that carries a composite instanceId targets ONE
        // concurrent profile instance, not the whole service: it must go through
        // the instance policy so a running sibling profile never blocks it.
        // Legacy whole-service actions carry no instanceId and keep the exact
        // pre-existing path below.
        let instanceAction = null;
        try {
          instanceAction = typeof repo.loadAction === 'function'
            ? await repo.loadAction(id)
            : (typeof repo.registry?.loadAction === 'function' ? await repo.registry.loadAction(id) : null);
        } catch (_) {
          instanceAction = null;
        }
        const instanceScoped = instanceAction != null &&
          typeof (instanceAction.instanceId || instanceAction.instance_id) === 'string' &&
          Boolean(instanceAction.instanceId || instanceAction.instance_id);

        if (instanceScoped) {
          const instanceId = instanceAction.instanceId || instanceAction.instance_id;
          try {
            await withExclusiveLock(async () => {
              await runInstanceLifecycleAction({
                repo,
                // Deliberately NOT resolvedAdapterProvider: a legacy service
                // adapter must never be driven by an instance action.
                adapterProvider: resolvedInstanceAdapterProvider,
                resourcePolicy: policy,
                actionId: id,
                vault
              });
            });
          } finally {
            // The instance provider caches by instanceId. Releasing it here (on
            // success AND failure) drops only the cached adapter object; it never
            // terminates the process. The legacy provider below is released with
            // the ACTION id, which is what registry-provider.release expects.
            if (typeof resolvedInstanceAdapterProvider?.release === 'function') {
              try {
                resolvedInstanceAdapterProvider.release(instanceId);
              } catch (_) {}
            }
          }
        } else {
          await withExclusiveLock(async () => {
            await runMcpLifecycleAction({
              repo,
              adapterProvider: resolvedAdapterProvider,
              resourcePolicy: policy,
              actionId: id,
              vault
            });
          });
        }
      } else if (workKind === 'switch') {
        await executeOperation(id, deps);
      }
    } finally {
      currentOperationId = null;
      if (typeof resolvedAdapterProvider?.release === 'function') {
        try {
          resolvedAdapterProvider.release(id);
        } catch (_) {}
      }
    }
  }

  async function drainQueue() {
    if (drainPromise) return drainPromise;

    drainPromise = (async () => {
      try {
        while (started) {
          pendingNotify = false;
          let items;
          try {
            items = await fetchWorkQueue();
          } catch (err) {
            lastError = err;
            break;
          }

          if (!Array.isArray(items) || items.length === 0) {
            if (pendingNotify) continue;
            break;
          }

          let progressMade = false;

          for (const rawItem of items) {
            if (!started) break;
            const id = typeof rawItem === 'string' ? rawItem : (rawItem?.id || rawItem?.operationId);
            if (!id) continue;

            let workKind;
            try {
              workKind = await classifyWork(id, rawItem);
            } catch (err) {
              lastError = err;
              progressMade = false;
              return;
            }

            let work;
            try {
              work = await loadWorkRecord({ repo, id, kind: workKind });
            } catch (err) {
              // Storage or unknown-state failure stops draining / gates; no spin
              lastError = err;
              progressMade = false;
              return;
            }

            if (work.terminal) {
              // Terminal items (including NEEDS_ATTENTION) never execute again; ignore
              continue;
            }

            try {
              await dispatchTask(id, rawItem);
              progressMade = true;
            } catch (err) {
              // Contain execution error without writing or logging sensitive data
              lastError = err;
              progressMade = false;
              break;
            }
          }

          // Break when none runnable or no progress made, even with stale injected queue
          if (!progressMade) {
            break;
          }

          if (!pendingNotify) {
            let checkAgain;
            try {
              checkAgain = await fetchWorkQueue();
            } catch (err) {
              lastError = err;
              break;
            }
            if (!Array.isArray(checkAgain) || checkAgain.length === 0) {
              break;
            }
          }
        }
      } finally {
        drainPromise = null;
      }
    })();

    return drainPromise;
  }

  async function runRecovery(items) {
    recoveryState.status = 'running';
    recoveryState.pending = true;
    try {
      for (const item of items) {
        if (!started) break;
        await dispatchTask(item.id, item.rawItem);
        recoveryState.done += 1;
      }
      recoveryState.status = 'ready';
      recoveryState.pending = false;
      recoveryState.failed = false;
      recoveryState.error = null;
      if (pendingNotify && started && !stopping) {
        pendingNotify = false;
        notify();
      }
    } catch (error) {
      lastError = error;
      // Fail-closed: the gate stays shut (mutations answered 503) instead of
      // letting new work race an unverified partial recovery.
      recoveryState.status = 'failed';
      recoveryState.pending = false;
      recoveryState.failed = true;
      recoveryState.error = error?.message ? String(error.message) : String(error);
      throw error;
    }
  }

  function beginBackgroundRecovery() {
    if (recoveryTask) return recoveryTask;
    if (!recoveryItems || recoveryItems.length === 0) return Promise.resolve();
    const items = recoveryItems;
    recoveryItems = null;
    recoveryState.mode = 'background';
    recoveryTask = runRecovery(items)
      .catch(() => {})
      .finally(() => { recoveryTask = null; });
    return recoveryTask;
  }

  function getRecoveryState() {
    // `ready` is the affirmative readiness bit a health check can consume; the
    // console keeps reading `gated` (the safety gate). Both answers stay
    // available so readiness never has to be inferred from the absence of a gate.
    const gated = recoveryState.pending || recoveryState.status === 'running' || recoveryState.failed;
    return {
      ...recoveryState,
      gated,
      ready: !gated && recoveryState.status === 'ready'
    };
  }

  function whenRecoverySettled() {
    return recoveryTask || Promise.resolve();
  }

  async function start({ backgroundRecovery = false } = {}) {
    if (started) return;
    if (startPromise) return await startPromise;

    const runStartup = async () => {
      const releases = [];
      await withStartupRollback(async () => {
        // 1. Obtain cross-process daemon lock tied to dataDir
        daemonLock = await acquireDaemonLock(resolvedDataDir);
        releases.push(async () => {
          if (daemonLock) {
            try {
              await daemonLock.release();
            } finally {
              daemonLock = null;
            }
          }
        });

        started = true;
        stopping = false;
        lastError = null;

        // 2. Foreground: storage validation and classification of every pending
        //    recovery item. The actual recovery (which may launch/stop clients)
        //    is what can be deferred until after `listen` in background mode.
        const pendingItems = await fetchWorkQueue();
        const items = [];
        if (Array.isArray(pendingItems)) {
          for (const rawItem of pendingItems) {
            const id = typeof rawItem === 'string' ? rawItem : (rawItem?.id || rawItem?.operationId);
            if (!id) continue;

            const workKind = await classifyWork(id, rawItem);

            // loadWorkRecord validates state, awaits sync/async loader, and propagates storage errors
            const work = await loadWorkRecord({ repo, id, kind: workKind });

            // Recover nonQUEUED nonterminal before queued new work
            if (work.needsRecovery) items.push({ id, rawItem });
          }
        }

        recoveryState = {
          status: items.length === 0 ? 'ready' : 'pending',
          pending: items.length > 0,
          failed: false,
          mode: backgroundRecovery ? 'background' : 'sync',
          total: items.length,
          done: 0,
          error: null
        };

        if (items.length > 0) {
          if (backgroundRecovery) {
            // The caller (main) invokes beginBackgroundRecovery() after listen.
            recoveryItems = items;
          } else {
            await runRecovery(items);
          }
        }
      }, async () => {
        // Direct, idempotent rollback: reset started/drain flags and release acquired kernel lease
        started = false;
        drainPromise = null;
        pendingNotify = false;
        currentOperationId = null;
        recoveryItems = null;
        recoveryState = {
          status: 'idle', pending: false, failed: false,
          mode: recoveryState.mode, total: 0, done: 0, error: null
        };
        await rollbackOwnedResources(releases);
      });
    };

    startPromise = runStartup();
    try {
      await startPromise;
    } finally {
      startPromise = null;
    }
  }

  function notify() {
    if (!started || stopping) return;
    // Unified recovery gate: while startup recovery is pending/running/failed no
    // NEW work is dispatched. Read-only routes still answer from storage.
    if (recoveryState.pending || recoveryState.status === 'running' || recoveryState.failed) {
      pendingNotify = true;
      return;
    }
    if (drainPromise) {
      pendingNotify = true;
      return;
    }
    // Launch tracked drain queue
    drainQueue().catch(() => {});
  }

  async function stop() {
    if (!started) {
      if (daemonLock) {
        try {
          await daemonLock.release();
        } finally {
          daemonLock = null;
        }
      }
      return;
    }
    stopping = true;

    // A deferred recovery may still be launching/stopping clients. Await it so
    // close cannot race an owned side effect, then reclaim our own budget.
    if (recoveryTask) {
      try { await recoveryTask; } catch (_) {}
      recoveryTask = null;
    }
    recoveryItems = null;

    // Drain existing queued operations cleanly (do not await startPromise)
    if (drainPromise) {
      try {
        await drainPromise;
      } catch (_) {}
    } else {
      try {
        await drainQueue();
      } catch (_) {}
    }

    started = false;
    stopping = false;
    try { policy.close?.('POLICY_CLOSED'); } catch (_) {}

    // Release daemon lock
    if (daemonLock) {
      try {
        await daemonLock.release();
      } finally {
        daemonLock = null;
      }
    }
  }

  function getStatus() {
    return {
      status: started ? (stopping ? 'STOPPING' : 'RUNNING') : 'STOPPED',
      running: started && !stopping,
      started,
      stopping,
      locked: Boolean(daemonLock),
      currentOperationId,
      dataDir: resolvedDataDir,
      recovery: getRecoveryState(),
      resourcePolicy: typeof policy.getStats === 'function' ? policy.getStats() : null,
      lastError: lastError ? lastError.message : null
    };
  }

  return {
    start,
    notify,
    stop,
    getStatus,
    beginBackgroundRecovery,
    getRecoveryState,
    whenRecoverySettled,
    deps
  };
}
