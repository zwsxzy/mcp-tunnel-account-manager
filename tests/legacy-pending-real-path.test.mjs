/**
 * Legacy lifecycle: does a pending action actually block the next one? (§34)
 *
 * These cases drive the REAL `runMcpLifecycleAction` with a repo double that exposes only
 * the two methods the fallback chain probes, so the verdict is decided by production code.
 * This is what the older `legacy-pending-action.test.mjs` could not do: that file
 * REPLICATED the selection rule, which is why mutant M16 survived (see §25.3).
 *
 * FINDING: the selection rule is correct, but `mcp-lifecycle.mjs` never handles the
 * `busy` decision it receives — `decision.decision === 'busy'` falls through to the
 * execute branch. The instance path (instance-lifecycle.mjs:654) handles it correctly.
 * Pre-existing (absent at 21efa72), recorded in §34, NOT fixed here.
 *
 * SEVERITY (§34.7): this is UNREACHABLE through the supported API. assertIdle() refuses to
 * create a legacy action whenever any other action is non-terminal (verified in all
 * directions: legacy→legacy, instance→legacy, legacy→instance all give BUSY), and legacy
 * and instance execution share the same withExclusiveLock. So pendingOperationId is
 * effectively always null on this path. The APPLYING case below reaches adapter.prepare()
 * only because the test sets that state directly, which the product cannot produce. It is
 * a latent inconsistency worth fixing, not an active concurrency hazard.
 *
 * The APPLYING case therefore asserts the CURRENT behaviour and is labelled as such, so the
 * suite stays honest: it documents a dead-branch bug rather than endorsing it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runMcpLifecycleAction } from '../src/core/mcp-lifecycle.mjs';

const SERVICE = 'mcp_lcprobe';

function makeRepo(pending) {
  const state = { action: null, rejected: [], attention: [] };
  const registry = {
    listPendingActionIds: () => pending.map(p => p.id),
    loadAction: async (id) => pending.find(p => p.id === id) || state.action
  };
  return {
    repo: {
      registry,
      loadAction: async () => state.action,
      listPendingActionIds: () => pending.map(p => p.id),
      markActionAttention: async (id, code) => {
        state.attention.push({ id, code });
        return { id, state: 'NEEDS_ATTENTION', errorCode: code };
      },
      transitionAction: async (id, patch) => {
        state.action = { ...state.action, ...patch };
        return state.action;
      },
      finishAction: async (id, patch) => {
        state.action = { ...state.action, ...patch };
        return state.action;
      },
      finishRollback: async () => state.action,
      rejectAction: async (id, code) => {
        state.rejected.push(code);
        state.action = { ...state.action, state: 'REJECTED', errorCode: code };
        return state.action;
      },
      phase: async () => state.action,
      getAction: async () => state.action,
      getProfileCredentials: async () => ({ tunnelId: 't', apiKey: 'k' })
    },
    state,
    setAction(a) { state.action = a; }
  };
}

function makeAdapter(token) {
  const observedAt = Date.now();
  return {
    paths: {},
    async observe() {
      return { state: 'stopped', observedAt, externalProcessPresent: false, managed: true, pid: null };
    },
    async prepare() { token.prepared = true; return { ok: true }; },
    async applyIfUnchanged() { token.applied = true; return { ok: true, receipt: { verified: true } }; }
  };
}

async function runWith(siblingState) {
  const token = { prepared: false, applied: false };
  const { repo, state, setAction } = makeRepo([
    { id: 'act_sib', state: siblingState, status: siblingState, serviceId: SERVICE, profileId: 'userB' }
  ]);
  setAction({
    id: 'act_target', operationId: 'op_target', kind: 'start', action: 'start',
    state: 'QUEUED', serviceId: SERVICE, profileId: 'userA'
  });
  await runMcpLifecycleAction({
    repo, adapterProvider: async () => makeAdapter(token), actionId: 'act_target', vault: null
  });
  return { token, state };
}

test('§34 BUG (documented, not fixed): an APPLYING action does NOT block a new legacy start', async () => {
  const { token, state } = await runWith('APPLYING');
  // These two assertions encode the DEFECT. When it is fixed, this test must be flipped
  // to assert that the action stays QUEUED / reports OPERATION_IN_PROGRESS.
  assert.equal(token.prepared, true,
    'current (defective) behaviour: the start reaches adapter.prepare() despite a conflicting APPLYING action');
  assert.equal(token.applied, true,
    'current (defective) behaviour: it even reaches applyIfUnchanged(), mutating the service concurrently');
  assert.equal(state.action?.errorCode ?? null, null,
    'current (defective) behaviour: it reports success rather than OPERATION_IN_PROGRESS');
});

test('a QUEUED sibling does not block either (queued is not executing)', async () => {
  const { state } = await runWith('QUEUED');
  const busy = state.rejected.includes('OPERATION_IN_PROGRESS');
  assert.equal(busy, false, 'queued work must never be reported as executing');
});

test('an APPLYING sibling on ANOTHER service does not interfere', async () => {
  const token = { prepared: false, applied: false };
  const { repo, state, setAction } = makeRepo([
    { id: 'act_other', state: 'APPLYING', status: 'APPLYING', serviceId: 'mcp_other', profileId: 'userZ' }
  ]);
  setAction({
    id: 'act_target', operationId: 'op_target', kind: 'start', action: 'start',
    state: 'QUEUED', serviceId: SERVICE, profileId: 'userA'
  });
  await runMcpLifecycleAction({
    repo, adapterProvider: async () => makeAdapter(token), actionId: 'act_target', vault: null
  });
  const busy = state.rejected.includes('OPERATION_IN_PROGRESS');
  assert.equal(busy, false, 'other services must not interfere');
});
