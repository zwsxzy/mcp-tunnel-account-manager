import fs from 'node:fs';
import { assertStoppedConnectionReceipt } from './mcp-registry-policy.mjs';
import { decideTunnelClientAction } from './tunnel-client-lifecycle.mjs';
import { assertVerifiedReceipt } from './switch-core.mjs';
import { verifyCarrierConfirmation } from './carrier-confirmation.mjs';
import { missingReferenceDisposition } from './work-item-routing.mjs';

export const TERMINAL_STOP_STATES = new Set(['SUCCEEDED', 'REJECTED', 'NEEDS_ATTENTION']);
export const TERMINAL_ACTION_STATES = TERMINAL_STOP_STATES;

function safeCode(err, defaultCode = 'STOP_FAILED') {
  if (err && typeof err.code === 'string' && /^[A-Z_]{1,48}$/.test(err.code)) {
    return err.code;
  }
  return defaultCode;
}

async function getPublicAction(repo, actionId) {
  if (typeof repo.publicAction === 'function') {
    return await repo.publicAction(actionId);
  }
  if (typeof repo.publicOperation === 'function') {
    return await repo.publicOperation(actionId);
  }
  if (typeof repo.loadAction === 'function') {
    return await repo.loadAction(actionId);
  }
  return await repo.load(actionId);
}

async function markAttention(repo, actionId, code) {
  if (typeof repo.markActionAttention === 'function') {
    return await repo.markActionAttention(actionId, code);
  }
  if (typeof repo.transitionAction === 'function') {
    return await repo.transitionAction(actionId, { state: 'NEEDS_ATTENTION', errorCode: code });
  }
  if (typeof repo.finishRollback === 'function') {
    return await repo.finishRollback(actionId, 'NEEDS_ATTENTION');
  }
  if (typeof repo.phase === 'function') {
    return await repo.phase(actionId, 'NEEDS_ATTENTION', code);
  }
}

async function markRejected(repo, actionId, code) {
  if (typeof repo.transitionAction === 'function') {
    return await repo.transitionAction(actionId, { state: 'REJECTED', errorCode: code });
  }
  if (typeof repo.phase === 'function') {
    return await repo.phase(actionId, 'REJECTED', code);
  }
}

async function finishSuccess(repo, actionId, receipt, meta = {}) {
  if (typeof repo.finishLifecycleAction === 'function') {
    return await repo.finishLifecycleAction(actionId, receipt, meta);
  }
  if (typeof repo.registry?.finishLifecycleAction === 'function') {
    return await repo.registry.finishLifecycleAction(actionId, receipt, meta);
  }
  if (typeof repo.finishStoppedAction === 'function') {
    return await repo.finishStoppedAction(actionId, receipt);
  }
  if (typeof repo.registry?.finishStoppedAction === 'function') {
    return await repo.registry.finishStoppedAction(actionId, receipt);
  }
  if (typeof repo.transitionAction === 'function') {
    return await repo.transitionAction(actionId, { state: 'SUCCEEDED', receipt });
  }
  if (typeof repo.commitSuccess === 'function') {
    return await repo.commitSuccess(actionId);
  }
}

/**
 * Runs a single tunnel client lifecycle action (start, stop, restart) for an MCP service.
 * Enforces the GPT-approved core policy under the runner's exclusive mutation lock before effects.
 *
 * @param {object} params
 * @param {object} params.repo - Store repository
 * @param {Function|object} params.adapterProvider - Provider returning adapter for (opLike, serviceId)
 * @param {string} params.actionId - Identifier of the action
 * @param {object} [params.vault] - Vault instance for carrier token / credentials
 * @returns {Promise<object>} Public action DTO
 */
export async function runMcpLifecycleAction({ repo, adapterProvider, actionId, vault, resourcePolicy = null }) {
  if (!repo || typeof repo !== 'object') {
    throw new TypeError('A valid repo object is required to run lifecycle action');
  }
  if (!actionId || typeof actionId !== 'string') {
    throw new TypeError('A valid actionId is required to run lifecycle action');
  }

  const action = typeof repo.loadAction === 'function'
    ? await repo.loadAction(actionId)
    : (typeof repo.registry?.loadAction === 'function' ? await repo.registry.loadAction(actionId) : await repo.load(actionId));

  if (!action) {
    throw new Error(`Lifecycle action ${actionId} not found`);
  }

  const opId = action.operationId || action.id || actionId;
  const state = action.state || action.status;
  const actionKind = action.kind || action.action || 'stop';

  // 1. Checks if action is already in terminal state (SUCCEEDED, REJECTED, NEEDS_ATTENTION)
  if (TERMINAL_ACTION_STATES.has(state)) {
    return await getPublicAction(repo, actionId);
  }

  // 2. Interrupted crash recovery: if action is already non-QUEUED (e.g. APPLYING), side-effects are uncertain
  if (state !== 'QUEUED') {
    await markAttention(repo, actionId, 'INTERRUPTED');
    return await getPublicAction(repo, actionId);
  }

  let sideEffectsInitiated = false;
  let admission = null;
  try {
    if (!action.serviceId) {
      const err = new Error('Missing serviceId');
      err.code = 'INVALID_TARGETS';
      throw err;
    }

    const opLike = {
      operationId: opId,
      id: opId,
      ...action
    };

    // Resolve adapter
    let adapter = null;
    if (typeof adapterProvider === 'function') {
      adapter = await adapterProvider(opLike, action.serviceId);
    } else if (adapterProvider && typeof adapterProvider === 'object') {
      if (typeof adapterProvider.getAdapter === 'function') {
        adapter = await adapterProvider.getAdapter(opLike, action.serviceId);
      } else {
        adapter = adapterProvider[action.serviceId];
      }
    }

    // Gather server-verified facts via OS / controller inspect
    let inspected = null;
    let inspectError = false;
    if (adapter?.processController && typeof adapter.processController.inspect === 'function') {
      try {
        inspected = await adapter.processController.inspect(action.serviceId);
      } catch (_) {
        inspectError = true;
      }
    }

    let recordedProc = null;
    if (adapter?.processPath && fs.existsSync(adapter.processPath)) {
      try {
        recordedProc = JSON.parse(fs.readFileSync(adapter.processPath, 'utf8'));
      } catch (_) {}
    }

    const inspectionSuccessful = !inspectError && inspected != null && typeof inspected === 'object';
    const live = Boolean(inspectionSuccessful && inspected.running && inspected.pid > 0);
    const owned = Boolean(live && recordedProc && recordedProc.pid === inspected?.pid);
    let identityVerified = false;
    if (live && owned) {
      if (typeof adapter?.processController?.verify === 'function') {
        try {
          const v = await adapter.processController.verify(recordedProc);
          identityVerified = Boolean(v?.valid);
        } catch (_) {
          identityVerified = false;
        }
      } else {
        // No verifier means no proof of identity. Treating the absence of a
        // verifier as success published a `running` snapshot for a pid that was
        // merely alive, so a recycled pid (or a foreign process) could be driven
        // as if it were this service's tunnel.
        identityVerified = false;
      }
    }

    // Absence verified ONLY if authoritative OS/controller inspection succeeded and reported running === false with no external conflict
    const absenceVerified = Boolean(inspectionSuccessful && inspected.running === false && !live);

    let snapState = 'unmanaged';
    if (live) {
      snapState = (owned && identityVerified) ? 'running' : 'unmanaged';
    } else if (absenceVerified) {
      snapState = 'stopped';
    }

    const snapshot = {
      state: snapState,
      owned,
      identityVerified,
      pid: live ? inspected.pid : null,
      startedAt: live ? (inspected.startedAt || inspected.startTime) : null,
      executablePath: live ? (inspected.executablePath || inspected.executable) : null,
      profileId: recordedProc?.profileId || null,
      observedAt: inspectionSuccessful ? Date.now() : 0,
      absenceVerified,
      externalProcessPresent: live && !owned
    };

    // Service definition lookup
    let serviceDef = null;
    if (repo?.registry && typeof repo.registry.getDefinition === 'function') {
      try { serviceDef = await repo.registry.getDefinition(action.serviceId); } catch (_) {}
    }
    const serviceEnabled = serviceDef ? (serviceDef.enabled !== false) : (action.serviceEnabled ?? true);
    const controlCarrier = serviceDef ? Boolean(serviceDef.controlCarrier) : Boolean(action.controlCarrier);

    // Eligible profile IDs
    let eligibleProfileIds = [];
    if (typeof repo.listProfiles === 'function') {
      try {
        const profs = await repo.listProfiles();
        for (const p of profs) {
          if (typeof repo.hasServiceCredential === 'function') {
            if (await repo.hasServiceCredential(p.id, action.serviceId)) {
              eligibleProfileIds.push(p.id);
            }
          } else {
            eligibleProfileIds.push(p.id);
          }
        }
      } catch (_) {}
    }
    if (action.eligibleProfileIds && Array.isArray(action.eligibleProfileIds)) {
      eligibleProfileIds = action.eligibleProfileIds;
    }

    // Check executable binary existence
    let binaryAvailable = true;
    if (adapter?.paths?.tunnelClientBin) {
      binaryAvailable = fs.existsSync(adapter.paths.tunnelClientBin);
    }

    // Pending operation check: must exclude current action and represent actual other ACTUALLY EXECUTING/mutating work, not future queued actions
    let pendingOperationId = null;
    if (typeof repo?.registry?.getActiveActionForService === 'function') {
      pendingOperationId = await repo.registry.getActiveActionForService(action.serviceId, opId);
    } else if (typeof repo?.getActiveActionForService === 'function') {
      pendingOperationId = await repo.getActiveActionForService(action.serviceId, opId);
    } else if (typeof repo?.registry?.listPendingActionIds === 'function' && typeof repo?.registry?.loadAction === 'function') {
      const pendingIds = repo.registry.listPendingActionIds();
      for (const pid of pendingIds) {
        if (pid !== opId && pid !== actionId) {
          const pendingAct = await repo.registry.loadAction(pid);
          if (pendingAct && pendingAct.serviceId === action.serviceId && (pendingAct.state === 'APPLYING' || pendingAct.status === 'APPLYING')) {
            pendingOperationId = pid;
            break;
          }
        }
      }
    } else if (typeof repo?.listPendingActionIds === 'function' && typeof repo?.loadAction === 'function') {
      const pendingIds = repo.listPendingActionIds();
      for (const pid of pendingIds) {
        if (pid !== opId && pid !== actionId) {
          const pendingAct = await repo.loadAction(pid);
          if (pendingAct && pendingAct.serviceId === action.serviceId && (pendingAct.state === 'APPLYING' || pendingAct.status === 'APPLYING')) {
            pendingOperationId = pid;
            break;
          }
        }
      }
    }

    // Carrier confirmation verification under runner exclusive lock
    let carrierConfirmationVerified = false;
    if (controlCarrier) {
      if (vault && typeof vault.unseal === 'function' && action.carrierToken) {
        const freshProcIdentity = live ? {
          pid: inspected.pid,
          startedAt: inspected.startedAt || inspected.startTime || recordedProc?.startedAt,
          executablePath: inspected.executablePath || inspected.executable || recordedProc?.executablePath || recordedProc?.executable,
          verified: identityVerified
        } : null;

        const sessionBinding = action.carrierContext?.sessionBinding || action.sessionBinding;
        const idempotencyKey = action.carrierContext?.idempotencyKey || action.idempotencyKey;
        const serviceRevision = serviceDef ? serviceDef.revision : (action.carrierContext?.serviceRevision || 1);

        const verifyCtx = {
          action: actionKind,
          serviceId: action.serviceId,
          serviceRevision,
          profileId: action.profileId || null,
          sessionBinding,
          idempotencyKey,
          identity: freshProcIdentity,
          absenceVerified
        };

        try {
          carrierConfirmationVerified = await verifyCarrierConfirmation(vault, action.carrierToken, verifyCtx);
        } catch (_) {
          carrierConfirmationVerified = false;
        }
      }
    }

    const ctx = {
      serviceId: action.serviceId,
      registeredAdapter: Boolean(adapter),
      pendingOperationId,
      snapshot,
      requestedProfileId: action.profileId || null,
      serviceEnabled,
      controlCarrier,
      carrierConfirmationVerified,
      eligibleProfileIds,
      binaryAvailable,
      nowMs: Date.now()
    };

    // Run decision inside runner exclusive lock
    const decision = decideTunnelClientAction(actionKind, ctx);

    if (decision.decision === 'reject') {
      await markRejected(repo, actionId, decision.code);
      return await getPublicAction(repo, actionId);
    }

    if (decision.decision === 'noop') {
      /*
       * ALREADY_STOPPED is the one noop that proves the service has no live
       * client: decideTunnelClientAction only reaches it when the snapshot says
       * `stopped` AND `absenceVerified === true`, i.e. the authoritative
       * inspection succeeded and reported no process.
       *
       * The legacy `active_profiles` pointer is what remove() reads, and this
       * path never went through finishLifecycleAction, so nothing cleared it.
       * A tunnel that died outside the console therefore kept reading as
       * `running`: removal failed 409 MCP_RUNNING, the UI advised "stop it
       * first", that advice returned ALREADY_STOPPED, and the pointer survived
       * the advice. Clearing it here breaks that loop.
       *
       * Scope guard: ONLY a stop noop with verified absence. An ALREADY_RUNNING
       * noop must never drop the pointer, and an unverified `stopped` claim is
       * not absence (decideTunnelClientAction rejects it as STATE_UNVERIFIED
       * before reaching here).
       */
      if (actionKind === 'stop' && decision.code === 'ALREADY_STOPPED'
          && snapshot.absenceVerified === true) {
        try {
          if (typeof repo.registry?.handleClearActiveService === 'function') {
            repo.registry.handleClearActiveService(action.serviceId);
          } else if (typeof repo.clearActiveService === 'function') {
            repo.clearActiveService(action.serviceId);
          }
        } catch (_) {}
        const noopObserver = typeof repo.getObserver === 'function'
          ? repo.getObserver()
          : (typeof repo.registry?.getObserver === 'function' ? repo.registry.getObserver() : null);
        try {
          if (noopObserver && typeof noopObserver.setTunnelClient === 'function') {
            noopObserver.setTunnelClient(action.serviceId, {
              state: 'stopped',
              managed: true,
              pid: null,
              startedAt: null,
              profileId: null,
              operationId: null,
              observedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 90000).toISOString(),
              reasonCode: 'process_stopped',
              lastExitCode: null,
              absenceVerified: true
            });
          }
        } catch (_) {}
      }
      await repo.transitionAction(actionId, { state: 'SUCCEEDED' });
      return await getPublicAction(repo, actionId);
    }

    // decision === 'enqueue' -> execute!
    //
    // RESOURCE ADMISSION comes before every effect, and specifically before a
    // restart stops its old process: refusing here leaves the existing client
    // running, while checking after the stop would leave the service down.
    if ((actionKind === 'start' || actionKind === 'restart') && typeof resourcePolicy?.admitStart === 'function') {
      try {
        admission = await resourcePolicy.admitStart({
          serviceId: action.serviceId,
          // Trusted server-side carrier flag; an HTTP body cannot set this.
          carrier: controlCarrier === true,
          kind: actionKind
        });
      } catch (admissionError) {
        await markRejected(repo, actionId, admissionError?.code || 'RESOURCE_ADMISSION_FAILED');
        return await getPublicAction(repo, actionId);
      }
    }

    if (typeof repo.transitionAction === 'function') {
      await repo.transitionAction(actionId, { state: 'APPLYING' });
    } else if (typeof repo.phase === 'function') {
      await repo.phase(actionId, 'APPLYING');
    }

    const obs = typeof repo.getObserver === 'function'
      ? repo.getObserver()
      : (typeof repo.registry?.getObserver === 'function' ? repo.registry.getObserver() : null);

    if (actionKind === 'stop') {
      if (!adapter || typeof adapter.stopConnection !== 'function') {
        const err = new Error(`Adapter for ${action.serviceId} is unavailable`);
        err.code = 'MCP_ADAPTER_UNAVAILABLE';
        throw err;
      }
      sideEffectsInitiated = true;
      const receipt = await adapter.stopConnection({
        operationId: opId,
        serviceId: action.serviceId,
        originalRuntime: action.originalRuntime
      });
      assertStoppedConnectionReceipt(receipt, opId, action.serviceId);
      if (obs && typeof obs.invalidate === 'function') {
        obs.invalidate(action.serviceId);
      }
      if (obs && typeof obs.setTunnelClient === 'function') {
        obs.setTunnelClient(action.serviceId, {
          state: 'stopped',
          managed: true,
          pid: null,
          startedAt: null,
          profileId: null,
          operationId: null,
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 90000).toISOString(),
          reasonCode: 'process_stopped',
          lastExitCode: null,
          // Proven absence: stopConnection's receipt was asserted above
          // (assertStoppedConnectionReceipt). This is the only place a VERIFIED
          // stop may claim absence, and it is what the ALREADY_STOPPED guard and
          // removal decision consume.
          absenceVerified: true
        });
      }
      await finishSuccess(repo, actionId, receipt, { action: 'stop' });
    } else if (actionKind === 'start' || actionKind === 'restart') {
      if (!adapter || typeof adapter.prepare !== 'function' || typeof adapter.applyIfUnchanged !== 'function') {
        const err = new Error(`Adapter for ${action.serviceId} is unavailable`);
        err.code = 'MCP_ADAPTER_UNAVAILABLE';
        throw err;
      }

      // Fetch credentials for selected profile before effects
      let credential = null;
      if (typeof repo.getProfileCredentials === 'function' && decision.profileId) {
        credential = await repo.getProfileCredentials(decision.profileId, action.serviceId);
      } else if (typeof repo.rawCredentials === 'function' && decision.profileId) {
        const raw = await repo.rawCredentials(decision.profileId);
        credential = raw?.[action.serviceId] || null;
      }
      if (!credential && action.credential) {
        credential = action.credential;
      }

      const preparedSnap = await adapter.prepare({
        operationId: opId,
        credential,
        profileId: decision.profileId || action.profileId || null
      });

      // If restart and process is currently live, stop verified owned process first
      if (actionKind === 'restart' && live && recordedProc) {
        sideEffectsInitiated = true;
        await adapter.processController.stop(recordedProc);
      }

      sideEffectsInitiated = true;
      await adapter.applyIfUnchanged({ operationId: opId, snapshot: preparedSnap });

      let receipt = { started: true, operationId: opId, service: action.serviceId };
      if (typeof adapter.verifyDesired === 'function') {
        receipt = await adapter.verifyDesired({ operationId: opId, snapshot: preparedSnap });
        assertVerifiedReceipt(receipt, opId, action.serviceId, preparedSnap);
      }

      if (obs && typeof obs.invalidate === 'function') {
        obs.invalidate(action.serviceId);
      }
      if (obs && typeof obs.setTunnelClient === 'function') {
        const identity = receipt?.identity || preparedSnap?.identity || {};
        obs.setTunnelClient(action.serviceId, {
          state: 'running',
          managed: true,
          pid: identity.pid || null,
          startedAt: identity.startedAt || identity.startTime || new Date().toISOString(),
          profileId: decision.profileId || action.profileId || null,
          operationId: opId,
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 90000).toISOString(),
          reasonCode: 'process_verified_running',
          lastExitCode: null,
          // A running client is the opposite of proven absence. State it
          // explicitly so a stale `absenceVerified: true` can never survive a
          // restart and let the ALREADY_STOPPED guard fire on a live tunnel.
          absenceVerified: false
        });
      }

      await finishSuccess(repo, actionId, receipt, { action: actionKind, profileId: decision.profileId });
    }

    return await getPublicAction(repo, actionId);
  } catch (err) {
    const code = safeCode(err, sideEffectsInitiated ? 'ACTION_FAILED' : 'ACTION_REJECTED');
    const evidence = {
      phase: sideEffectsInitiated ? 'APPLYING' : 'PREPARING',
      mayMutate: sideEffectsInitiated,
      intentWritten: false,
      processEffectObserved: false,
      configChanged: false,
      rollbackUncertain: sideEffectsInitiated
    };
    const disposition = missingReferenceDisposition(evidence);
    if (disposition === 'REJECTED') {
      await markRejected(repo, actionId, code);
    } else {
      await markAttention(repo, actionId, code);
    }
    return await getPublicAction(repo, actionId);
  } finally {
    // Success or failure, the budget acquired for this action is returned; a
    // leaked reservation would eventually refuse every new normal start.
    if (admission && typeof resourcePolicy?.release === 'function') {
      try { resourcePolicy.release(admission); } catch (_) {}
    }
  }
}

/**
 * Runs a single stop connection action for an MCP service.
 * Legacy wrapper forwarding to runMcpLifecycleAction.
 *
 * @param {object} params
 * @returns {Promise<object>} Public action DTO
 */
export async function runMcpStopAction(params) {
  return await runMcpLifecycleAction({ ...params, actionKind: 'stop' });
}
