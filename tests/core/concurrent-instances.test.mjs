/**
 * Unit tests: concurrent multi-profile tunnel instances (pure core).
 *
 * Target module: src/core/concurrent-instances.mjs
 * Contract: docs/analysis/concurrent-instances-contract.md §1 / §6
 *
 * These tests are PURE: no filesystem, no network, no processes. They pin the
 * instance namespace, the per-instance lifecycle decision matrix, and the
 * public DTO redaction behaviour.
 *
 * The headline invariant of the whole feature is asserted in
 * "sibling running profiles never block a different profile":
 * a running sibling must never produce reject/noop for another profile.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  INSTANCE_SEPARATOR,
  MAX_INSTANCES_PER_SERVICE,
  INSTANCE_FAILURE_CODES,
  InstanceFault,
  sanitizeProfileSegment,
  buildInstanceId,
  parseInstanceId,
  isValidInstanceId,
  assertInstanceTarget,
  instanceProfileStem,
  profileYamlFileName,
  instanceRecordFileName,
  instanceProfileDir,
  decideInstanceAction,
  publicInstanceDTO
} from '../../src/core/concurrent-instances.mjs';

const NOW = 1_000_000;

/** Baseline "server-verified facts" for a stopped, absent instance. */
function baseCtx(overrides = {}) {
  return {
    serviceId: 'antigravity-mcp',
    profileId: 'userA',
    snapshot: { state: 'stopped', absenceVerified: true, observedAt: NOW },
    serviceEnabled: true,
    controlCarrier: false,
    carrierConfirmationVerified: false,
    eligibleProfileIds: ['userA', 'userB', 'userC'],
    binaryAvailable: true,
    pendingOperationId: null,
    siblingRunningProfileIds: [],
    nowMs: NOW,
    ...overrides
  };
}

function withSnapshot(overrides = {}, ctxOverrides = {}) {
  return baseCtx({
    snapshot: { state: 'stopped', absenceVerified: true, observedAt: NOW, ...overrides },
    ...ctxOverrides
  });
}

/** A verified, owned, live instance snapshot. */
function liveSnapshot(overrides = {}) {
  return {
    state: 'running',
    owned: true,
    identityVerified: true,
    pid: 4321,
    startedAt: '2026-11-09T00:00:00.000Z',
    executablePath: 'C:\\isolated\\tunnel-client.exe',
    absenceVerified: false,
    externalProcessPresent: false,
    observedAt: NOW,
    ...overrides
  };
}

function liveCtx(overrides = {}, snapshotOverrides = {}) {
  return baseCtx({ snapshot: liveSnapshot(snapshotOverrides), ...overrides });
}

const LIVE_CTX = () => liveCtx();

// ===========================================================================
describe('1. Namespace constants', () => {
  test('exposes the frozen separator and per-service cap', () => {
    assert.equal(INSTANCE_SEPARATOR, '__');
    assert.equal(MAX_INSTANCES_PER_SERVICE, 8);
  });

  test('INSTANCE_FAILURE_CODES is a frozen, unique, bounded code list', () => {
    assert.ok(Object.isFrozen(INSTANCE_FAILURE_CODES), 'codes must be frozen');
    assert.ok(Array.isArray(INSTANCE_FAILURE_CODES));
    assert.equal(new Set(INSTANCE_FAILURE_CODES).size, INSTANCE_FAILURE_CODES.length, 'codes must be unique');
    for (const code of INSTANCE_FAILURE_CODES) {
      assert.match(code, /^[A-Z_]{1,48}$/, `code ${code} must be an upper-snake bounded code`);
    }
    // Every code this decision matrix can emit must be declared.
    for (const required of [
      'INVALID_ACTION',
      'INVALID_INSTANCE',
      'INVALID_PROFILE',
      'OPERATION_IN_PROGRESS',
      'STATE_REFRESH_REQUIRED',
      'EXTERNAL_CLIENT_NOT_MANAGED',
      'STATE_UNVERIFIED',
      'PROCESS_IDENTITY_MISMATCH',
      'ALREADY_RUNNING',
      'ALREADY_STOPPED',
      'CARRIER_CONFIRMATION_REQUIRED',
      'SERVICE_DISABLED',
      'PROFILE_NOT_CONFIGURED',
      'EXECUTABLE_NOT_FOUND',
      'INSTANCE_LIMIT_REACHED'
    ]) {
      assert.ok(INSTANCE_FAILURE_CODES.includes(required), `missing declared code ${required}`);
    }
  });

  test('InstanceFault normalizes unknown codes to INVALID_INSTANCE', () => {
    const known = new InstanceFault('INSTANCE_LIMIT_REACHED');
    assert.equal(known.name, 'InstanceFault');
    assert.equal(known.code, 'INSTANCE_LIMIT_REACHED');
    assert.ok(known instanceof Error);

    const unknown = new InstanceFault('something_lowercase');
    assert.equal(unknown.code, 'INVALID_INSTANCE');

    const custom = new InstanceFault('INVALID_PROFILE', 'profile is unusable');
    assert.equal(custom.message, 'profile is unusable');
  });
});

// ===========================================================================
describe('2. Profile segment sanitization (deterministic, filename-safe)', () => {
  test('ordinary ids and UUIDs survive unchanged', () => {
    assert.equal(sanitizeProfileSegment('userA'), 'userA');
    assert.equal(sanitizeProfileSegment('profile-1'), 'profile-1');
    assert.equal(sanitizeProfileSegment('acct_2026.11'), 'acct_2026.11');
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    assert.equal(sanitizeProfileSegment(uuid), uuid);
  });

  test('is deterministic across repeated calls', () => {
    const inputs = ['userA', '..\\..\\evil', 'a b c', '用户A', 'x'.repeat(200), 'UPPER/lower'];
    for (const input of inputs) {
      const first = sanitizeProfileSegment(input);
      const second = sanitizeProfileSegment(input);
      const third = sanitizeProfileSegment(input);
      assert.equal(first, second);
      assert.equal(second, third);
    }
  });

  test('folds path separators so the segment can never traverse directories', () => {
    assert.equal(sanitizeProfileSegment('a/b'), 'a_b');
    assert.equal(sanitizeProfileSegment('a\\b'), 'a_b');
    assert.equal(sanitizeProfileSegment('..\\..\\windows\\system32'), 'windows_system32');
    assert.equal(sanitizeProfileSegment('../../etc/passwd'), 'etc_passwd');
    assert.ok(!sanitizeProfileSegment('../../etc/passwd').includes('/'));
    assert.ok(!sanitizeProfileSegment('..\\..\\windows').includes('\\'));
  });

  test("folds a bare '..' (and other pure-dot inputs) to the empty segment", () => {
    assert.equal(sanitizeProfileSegment('..'), '');
    assert.equal(sanitizeProfileSegment('.'), '');
    assert.equal(sanitizeProfileSegment('...'), '');
    assert.equal(sanitizeProfileSegment('../..'), '');
  });

  test('folds spaces, unicode and control characters to underscores', () => {
    assert.equal(sanitizeProfileSegment('a b c'), 'a_b_c');
    assert.equal(sanitizeProfileSegment('user\u0000A'), 'user_A');
    // NFKD + ASCII folding: every non [A-Za-z0-9._-] run becomes one underscore,
    // and leading/trailing separators are trimmed.
    assert.equal(sanitizeProfileSegment('用户A'), 'A');
    assert.equal(sanitizeProfileSegment('café'), 'cafe'); // NFKD splits e + combining accent
  });

  test('collapses separator runs and trims leading/trailing separators', () => {
    assert.equal(sanitizeProfileSegment('__a__b__'), 'a_b');
    assert.equal(sanitizeProfileSegment('..a..'), 'a');
    assert.equal(sanitizeProfileSegment('---a---'), 'a');
  });

  test('a segment never contains the instance separator `__` (collision safety)', () => {
    // Sanitization collapses every `_` run to a single `_`, so a profile segment
    // can never contain `__`. That keeps `service__profile` unambiguous: exactly
    // one separator exists in every instance id.
    for (const profileId of ['a__b', '__lead', 'a___b', 'x__y__z', 'a/b__c']) {
      const segment = sanitizeProfileSegment(profileId);
      assert.ok(!segment.includes(INSTANCE_SEPARATOR), `${profileId} -> ${segment} must not contain __`);

      const instanceId = buildInstanceId('antigravity-mcp', profileId);
      assert.equal(instanceId.split(INSTANCE_SEPARATOR).length, 2, `${instanceId} must contain exactly one __`);
      assert.equal(parseInstanceId(instanceId).profileSegment, segment);
    }
  });

  test('is bounded to 64 characters for very long ids', () => {
    const long = 'a'.repeat(500);
    assert.equal(sanitizeProfileSegment(long).length, 64);
    assert.equal(sanitizeProfileSegment(long), 'a'.repeat(64));
    assert.ok(sanitizeProfileSegment('b'.repeat(65)).length === 64);
  });

  test('returns empty string for null/undefined/blank input', () => {
    assert.equal(sanitizeProfileSegment(null), '');
    assert.equal(sanitizeProfileSegment(undefined), '');
    assert.equal(sanitizeProfileSegment(''), '');
    assert.equal(sanitizeProfileSegment('   '), '');
  });

  test('accepts non-string input by stringifying it first', () => {
    assert.equal(sanitizeProfileSegment(12345), '12345');
  });
});

// ===========================================================================
describe('3. buildInstanceId / parseInstanceId round-trip', () => {
  test('builds `<serviceId>__<segment>` and round-trips through parse', () => {
    const cases = [
      ['antigravity-mcp', 'userA', 'antigravity-mcp__userA'],
      ['overleaf-mcp', 'profile-1', 'overleaf-mcp__profile-1'],
      ['mcp_test_stdio', 'acct_2026.11', 'mcp_test_stdio__acct_2026.11'],
      ['svc', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'svc__3f2504e0-4f89-11d3-9a0c-0305e82c3301']
    ];

    for (const [serviceId, profileId, expected] of cases) {
      const instanceId = buildInstanceId(serviceId, profileId);
      assert.equal(instanceId, expected);

      const parsed = parseInstanceId(instanceId);
      assert.ok(parsed, `parseInstanceId(${instanceId}) must not be null`);
      assert.deepEqual(parsed, {
        instanceId,
        serviceId,
        profileSegment: sanitizeProfileSegment(profileId)
      });
      // Round-trip reconstruction from the parsed parts.
      assert.equal(`${parsed.serviceId}${INSTANCE_SEPARATOR}${parsed.profileSegment}`, instanceId);
    }
  });

  test('buildInstanceId sanitizes the profile segment', () => {
    assert.equal(buildInstanceId('antigravity-mcp', ' user A '), 'antigravity-mcp__user_A');
  });

  test('buildInstanceId rejects hostile or unusable input', () => {
    assert.throws(() => buildInstanceId('', 'userA'), { code: 'INVALID_SERVICE' });
    assert.throws(() => buildInstanceId(null, 'userA'), { code: 'INVALID_SERVICE' });
    assert.throws(() => buildInstanceId('UPPER', 'userA'), { code: 'INVALID_SERVICE' });
    assert.throws(() => buildInstanceId('has space', 'userA'), { code: 'INVALID_SERVICE' });
    assert.throws(() => buildInstanceId('antigravity-mcp', '..'), { code: 'INVALID_PROFILE' });
    assert.throws(() => buildInstanceId('antigravity-mcp', ''), { code: 'INVALID_PROFILE' });
    assert.throws(() => buildInstanceId('antigravity-mcp', null), { code: 'INVALID_PROFILE' });
  });

  test('buildInstanceId output is always a parseable instance id', () => {
    for (const profileId of ['userA', 'a/b', '..\\evil', '用户A', 'x'.repeat(200)]) {
      const instanceId = buildInstanceId('antigravity-mcp', profileId);
      assert.ok(isValidInstanceId(instanceId), `${instanceId} must be valid`);
      assert.equal(parseInstanceId(instanceId).serviceId, 'antigravity-mcp');
    }
  });

  test('parseInstanceId returns null for malformed ids (never throws)', () => {
    const malformed = [
      null,
      undefined,
      42,
      '',
      'nounderscoreshere',
      '__profileOnly',
      'antigravity-mcp__',              // empty segment
      'antigravity-mcp__a b',           // space in segment
      'antigravity-mcp__a/b',           // separator in segment
      'Antigravity-MCP__userA',         // uppercase service id
      'antigravity-mcp__' + 'a'.repeat(65), // segment too long
      'a'.repeat(161)                   // whole id too long
    ];
    for (const candidate of malformed) {
      assert.equal(parseInstanceId(candidate), null, `expected null for ${String(candidate).slice(0, 40)}`);
      assert.equal(isValidInstanceId(candidate), false);
    }
  });
});

// ===========================================================================
describe('4. File naming (isolated profile + runtime records)', () => {
  test('profileYamlFileName yields exactly `antigravity_profile_userA.yaml`', () => {
    assert.equal(profileYamlFileName('antigravity-mcp', 'userA'), 'antigravity_profile_userA.yaml');
    assert.equal(profileYamlFileName('overleaf-mcp', 'profile-1'), 'overleaf_profile_profile-1.yaml');
  });

  test('instanceProfileStem strips the -mcp suffix / mcp_ prefix', () => {
    assert.equal(instanceProfileStem('antigravity-mcp'), 'antigravity');
    assert.equal(instanceProfileStem('mcp_test_stdio'), 'test_stdio');
    assert.equal(instanceProfileStem('service'), 'service');
    assert.throws(() => instanceProfileStem('Bad Id'), { code: 'INVALID_SERVICE' });
  });

  test('profileYamlFileName never contains a path separator', () => {
    const name = profileYamlFileName('antigravity-mcp', '../../evil/yaml');
    assert.ok(!name.includes('/'), name);
    assert.ok(!name.includes('\\'), name);
    assert.match(name, /^[A-Za-z0-9._-]+\.yaml$/);
    assert.throws(() => profileYamlFileName('antigravity-mcp', '..'), { code: 'INVALID_PROFILE' });
  });

  test('instanceRecordFileName names process/intent/health records per instance', () => {
    assert.equal(instanceRecordFileName('antigravity-mcp', 'userA'), 'antigravity-mcp__userA-process.json');
    assert.equal(instanceRecordFileName('antigravity-mcp', 'userA', 'process'), 'antigravity-mcp__userA-process.json');
    assert.equal(instanceRecordFileName('antigravity-mcp', 'userA', 'intent'), 'antigravity-mcp__userA-intent.json');
    assert.equal(instanceRecordFileName('antigravity-mcp', 'userA', 'health'), 'antigravity-mcp__userA-health.json');
    assert.throws(() => instanceRecordFileName('antigravity-mcp', 'userA', 'bogus'), { code: 'INVALID_INSTANCE' });
  });

  test('instanceProfileDir normalizes trailing separators and rejects blanks', () => {
    assert.equal(instanceProfileDir('C:\\iso\\profiles'), 'C:\\iso\\profiles');
    assert.equal(instanceProfileDir('C:\\iso\\profiles\\'), 'C:\\iso\\profiles');
    assert.equal(instanceProfileDir('/tmp/profiles//'), '/tmp/profiles');
    assert.throws(() => instanceProfileDir(''), { code: 'INVALID_INSTANCE' });
    assert.throws(() => instanceProfileDir(null), { code: 'INVALID_INSTANCE' });
  });

  test('assertInstanceTarget accepts the matching id and rejects a mismatched one', () => {
    const ok = assertInstanceTarget({
      serviceId: 'antigravity-mcp',
      profileId: 'userA',
      instanceId: 'antigravity-mcp__userA'
    });
    assert.deepEqual(ok, {
      instanceId: 'antigravity-mcp__userA',
      serviceId: 'antigravity-mcp',
      profileId: 'userA',
      profileSegment: 'userA'
    });

    // instanceId omitted -> derived, not an error.
    assert.equal(
      assertInstanceTarget({ serviceId: 'antigravity-mcp', profileId: 'userA' }).instanceId,
      'antigravity-mcp__userA'
    );

    assert.throws(
      () => assertInstanceTarget({
        serviceId: 'antigravity-mcp',
        profileId: 'userA',
        instanceId: 'antigravity-mcp__userB'
      }),
      { code: 'INVALID_INSTANCE' }
    );
    assert.throws(() => assertInstanceTarget({ serviceId: 'nope nope', profileId: 'userA' }), { code: 'INVALID_SERVICE' });
    assert.throws(() => assertInstanceTarget({ serviceId: 'antigravity-mcp', profileId: '..' }), { code: 'INVALID_PROFILE' });
  });
});

// ===========================================================================
describe('5. decideInstanceAction — input validation and staleness', () => {
  test('rejects an invalid action name', () => {
    assert.deepEqual(decideInstanceAction('pause', baseCtx()), { decision: 'reject', code: 'INVALID_ACTION' });
    assert.deepEqual(decideInstanceAction(undefined, baseCtx()), { decision: 'reject', code: 'INVALID_ACTION' });
    assert.deepEqual(decideInstanceAction(null, baseCtx()), { decision: 'reject', code: 'INVALID_ACTION' });
  });

  test('rejects a missing/invalid ctx', () => {
    assert.deepEqual(decideInstanceAction('start', null), { decision: 'reject', code: 'INVALID_INSTANCE' });
    assert.deepEqual(decideInstanceAction('start', 'nope'), { decision: 'reject', code: 'INVALID_INSTANCE' });
    assert.deepEqual(decideInstanceAction('start', 42), { decision: 'reject', code: 'INVALID_INSTANCE' });
  });

  test('rejects an invalid service id', () => {
    for (const serviceId of [undefined, null, '', 'UPPER CASE', 'has space', 123]) {
      assert.deepEqual(
        decideInstanceAction('start', baseCtx({ serviceId })),
        { decision: 'reject', code: 'INVALID_SERVICE' },
        `serviceId ${String(serviceId)} must be rejected`
      );
    }
  });

  test('rejects an unusable profile id', () => {
    for (const profileId of [undefined, null, '', '   ', '..', '../..']) {
      assert.deepEqual(
        decideInstanceAction('start', baseCtx({ profileId })),
        { decision: 'reject', code: 'INVALID_PROFILE' },
        `profileId ${String(profileId)} must be rejected`
      );
    }
  });

  test('requires a fresh observation (staleness window is 10s, clock skew 5s)', () => {
    assert.deepEqual(
      decideInstanceAction('start', withSnapshot({ observedAt: NOW - 10_001 })),
      { decision: 'reject', code: 'STATE_REFRESH_REQUIRED' }
    );
    assert.deepEqual(
      decideInstanceAction('start', withSnapshot({ observedAt: NOW + 5_001 })),
      { decision: 'reject', code: 'STATE_REFRESH_REQUIRED' }
    );
    // Missing/unparseable observedAt is treated as stale, never as fresh.
    assert.deepEqual(
      decideInstanceAction('start', baseCtx({ snapshot: { state: 'stopped', absenceVerified: true } })),
      { decision: 'reject', code: 'STATE_REFRESH_REQUIRED' }
    );
    assert.deepEqual(
      decideInstanceAction('start', baseCtx({ snapshot: { state: 'stopped', absenceVerified: true, observedAt: 'not-a-date' } })),
      { decision: 'reject', code: 'STATE_REFRESH_REQUIRED' }
    );
    // Inside the window it is accepted.
    assert.equal(
      decideInstanceAction('start', withSnapshot({ observedAt: NOW - 9_000 })).decision,
      'enqueue'
    );
    // ISO timestamps are accepted for recently observed snapshots.
    assert.equal(
      decideInstanceAction('start', withSnapshot({ observedAt: new Date(NOW).toISOString() })).decision,
      'enqueue'
    );
  });

  test('reports a pending operation on the SAME instance as busy', () => {
    assert.deepEqual(
      decideInstanceAction('start', baseCtx({ pendingOperationId: 'op-777' })),
      {
        decision: 'busy',
        code: 'OPERATION_IN_PROGRESS',
        operationId: 'op-777',
        instanceId: 'antigravity-mcp__userA'
      }
    );
  });
});

// ===========================================================================
describe('6. decideInstanceAction — unmanaged / unverified / transitional states', () => {
  test('rejects an unmanaged or externally owned client', () => {
    assert.deepEqual(
      decideInstanceAction('start', withSnapshot({ state: 'unmanaged' })),
      { decision: 'reject', code: 'EXTERNAL_CLIENT_NOT_MANAGED' }
    );
    assert.deepEqual(
      decideInstanceAction('start', withSnapshot({ externalProcessPresent: true })),
      { decision: 'reject', code: 'EXTERNAL_CLIENT_NOT_MANAGED' }
    );
  });

  test('rejects every transitional state', () => {
    for (const state of ['starting', 'stopping', 'restarting']) {
      assert.deepEqual(
        decideInstanceAction('start', withSnapshot({ state, absenceVerified: false })),
        { decision: 'reject', code: 'OPERATION_IN_PROGRESS' },
        `state ${state} must be rejected`
      );
    }
  });

  test('rejects an unverifiable state', () => {
    assert.deepEqual(
      decideInstanceAction('start', withSnapshot({ state: 'unobserved', absenceVerified: false })),
      { decision: 'reject', code: 'STATE_UNVERIFIED' }
    );
    // `stopped` WITHOUT absence verification is not trusted as absent.
    assert.deepEqual(
      decideInstanceAction('start', withSnapshot({ state: 'stopped', absenceVerified: false })),
      { decision: 'reject', code: 'STATE_UNVERIFIED' }
    );
    // `failed` with verified absence is a trusted terminal-absent state.
    assert.equal(
      decideInstanceAction('start', withSnapshot({ state: 'failed', absenceVerified: true })).decision,
      'enqueue'
    );
  });

  test('rejects a live process whose identity cannot be verified', () => {
    const mismatches = [
      { owned: false },
      { identityVerified: false },
      { pid: 0 },
      { pid: -5 },
      { pid: 1.5 },
      { pid: '4321' },
      { pid: undefined },
      { startedAt: null },
      { executablePath: null }
    ];
    for (const snapshotOverrides of mismatches) {
      const snapshot = liveSnapshot(snapshotOverrides);
      assert.deepEqual(
        decideInstanceAction('stop', baseCtx({ snapshot })),
        { decision: 'reject', code: 'PROCESS_IDENTITY_MISMATCH' },
        `snapshot ${JSON.stringify(snapshotOverrides)} must be rejected`
      );
    }
  });
});

// ===========================================================================
describe('7. decideInstanceAction — noop / enqueue transitions', () => {
  test('ALREADY_RUNNING noop when THIS instance is already running', () => {
    assert.deepEqual(decideInstanceAction('start', LIVE_CTX()), {
      decision: 'noop',
      code: 'ALREADY_RUNNING',
      pid: 4321,
      instanceId: 'antigravity-mcp__userA'
    });
  });

  test('ALREADY_STOPPED noop when THIS instance is verifiably absent', () => {
    assert.deepEqual(decideInstanceAction('stop', withSnapshot()), {
      decision: 'noop',
      code: 'ALREADY_STOPPED',
      instanceId: 'antigravity-mcp__userA'
    });
    assert.deepEqual(
      decideInstanceAction('stop', withSnapshot({ state: 'failed' })),
      { decision: 'noop', code: 'ALREADY_STOPPED', instanceId: 'antigravity-mcp__userA' }
    );
  });

  test('start on an absent instance enqueues with a null expectedIdentity', () => {
    const decision = decideInstanceAction('start', baseCtx());
    assert.deepEqual(decision, {
      decision: 'enqueue',
      action: 'start',
      serviceId: 'antigravity-mcp',
      profileId: 'userA',
      instanceId: 'antigravity-mcp__userA',
      expectedIdentity: null,
      siblingProfileIds: []
    });
  });

  test('stop of a verified live instance enqueues with the verified identity', () => {
    const decision = decideInstanceAction('stop', LIVE_CTX());
    assert.equal(decision.decision, 'enqueue');
    assert.equal(decision.action, 'stop');
    assert.deepEqual(decision.expectedIdentity, {
      pid: 4321,
      startedAt: '2026-11-09T00:00:00.000Z',
      executablePath: 'C:\\isolated\\tunnel-client.exe'
    });
  });

  test('restart enqueues for both live and absent instances', () => {
    const liveDecision = decideInstanceAction('restart', LIVE_CTX());
    assert.equal(liveDecision.decision, 'enqueue');
    assert.equal(liveDecision.action, 'restart');
    assert.equal(liveDecision.expectedIdentity.pid, 4321);

    const absentDecision = decideInstanceAction('restart', baseCtx());
    assert.equal(absentDecision.decision, 'enqueue');
    assert.equal(absentDecision.expectedIdentity, null);
  });

  test('enqueue result carries exactly the contracted fields', () => {
    const decision = decideInstanceAction('start', baseCtx());
    assert.deepEqual(Object.keys(decision).sort(), [
      'action',
      'decision',
      'expectedIdentity',
      'instanceId',
      'profileId',
      'serviceId',
      'siblingProfileIds'
    ]);
    assert.equal(decision.profileId, 'userA');
  });
});

// ===========================================================================
describe('8. decideInstanceAction — carrier / enabled / profile / binary gates', () => {
  test('carrier confirmation is required for stop and restart on a controlCarrier', () => {
    for (const action of ['stop', 'restart']) {
      assert.deepEqual(
        decideInstanceAction(action, liveCtx({ controlCarrier: true, carrierConfirmationVerified: false })),
        { decision: 'reject', code: 'CARRIER_CONFIRMATION_REQUIRED' },
        `${action} must require carrier confirmation`
      );
    }
    // Verified confirmation unblocks it.
    assert.equal(
      decideInstanceAction('stop', liveCtx({ controlCarrier: true, carrierConfirmationVerified: true })).decision,
      'enqueue'
    );
    // start is not gated by carrier confirmation.
    assert.equal(
      decideInstanceAction('start', baseCtx({ controlCarrier: true, carrierConfirmationVerified: false })).decision,
      'enqueue'
    );
    // A non-carrier service never requires the token.
    assert.equal(
      decideInstanceAction('stop', liveCtx({ controlCarrier: false, carrierConfirmationVerified: false })).decision,
      'enqueue'
    );
  });

  test('rejects start when the service is disabled', () => {
    assert.deepEqual(
      decideInstanceAction('start', baseCtx({ serviceEnabled: false })),
      { decision: 'reject', code: 'SERVICE_DISABLED' }
    );
    // stop remains possible for cleanup even when the service is disabled.
    assert.equal(
      decideInstanceAction('stop', liveCtx({ serviceEnabled: false })).decision,
      'enqueue'
    );
  });

  test('rejects start when the profile is not configured for the service', () => {
    assert.deepEqual(
      decideInstanceAction('start', baseCtx({ eligibleProfileIds: ['userB'] })),
      { decision: 'reject', code: 'PROFILE_NOT_CONFIGURED' }
    );
    assert.deepEqual(
      decideInstanceAction('start', baseCtx({ eligibleProfileIds: undefined })),
      { decision: 'reject', code: 'PROFILE_NOT_CONFIGURED' }
    );
    assert.deepEqual(
      decideInstanceAction('start', baseCtx({ eligibleProfileIds: 'userA' })),
      { decision: 'reject', code: 'PROFILE_NOT_CONFIGURED' }
    );
  });

  test('rejects start when the tunnel executable is unavailable', () => {
    assert.deepEqual(
      decideInstanceAction('start', baseCtx({ binaryAvailable: false })),
      { decision: 'reject', code: 'EXECUTABLE_NOT_FOUND' }
    );
    assert.deepEqual(
      decideInstanceAction('start', baseCtx({ binaryAvailable: undefined })),
      { decision: 'reject', code: 'EXECUTABLE_NOT_FOUND' }
    );
  });
});

// ===========================================================================
describe('9. decideInstanceAction — per-service instance cap', () => {
  const siblingIds = (count) => Array.from({ length: count }, (_, i) => `other${i}`);

  test('refuses a new instance at MAX_INSTANCES_PER_SERVICE running siblings', () => {
    const ctx = baseCtx({ siblingRunningProfileIds: siblingIds(MAX_INSTANCES_PER_SERVICE) });
    assert.deepEqual(
      decideInstanceAction('start', ctx),
      { decision: 'reject', code: 'INSTANCE_LIMIT_REACHED' }
    );
  });

  test('allows the last slot below the cap', () => {
    const ctx = baseCtx({ siblingRunningProfileIds: siblingIds(MAX_INSTANCES_PER_SERVICE - 1) });
    const decision = decideInstanceAction('start', ctx);
    assert.equal(decision.decision, 'enqueue');
    assert.equal(decision.siblingProfileIds.length, MAX_INSTANCES_PER_SERVICE - 1);
  });

  test('the cap never blocks stopping a running instance', () => {
    const ctx = liveCtx({ siblingRunningProfileIds: siblingIds(MAX_INSTANCES_PER_SERVICE + 3) });
    assert.equal(decideInstanceAction('stop', ctx).decision, 'enqueue');
  });

  test('ignores non-string siblings when counting toward the cap', () => {
    const ctx = baseCtx({
      siblingRunningProfileIds: [...siblingIds(7), null, 42, { id: 'x' }]
    });
    assert.equal(decideInstanceAction('start', ctx).decision, 'enqueue');
  });
});

// ===========================================================================
describe('10. KEY INVARIANT — a running sibling never blocks a different profile', () => {
  test('starting a DIFFERENT profile enqueues while siblings are running', () => {
    const ctx = baseCtx({
      profileId: 'userA',
      siblingRunningProfileIds: ['userB', 'userC']
    });

    const decision = decideInstanceAction('start', ctx);
    assert.equal(decision.decision, 'enqueue', 'a running sibling must never block another profile');
    assert.equal(decision.instanceId, 'antigravity-mcp__userA');
    assert.equal(decision.profileId, 'userA');
    assert.deepEqual(decision.siblingProfileIds, ['userB', 'userC']);
  });

  test('the same holds for restart and stop of a different profile', () => {
    const siblings = ['userB', 'userC', 'userD'];
    const restart = decideInstanceAction('restart', baseCtx({ siblingRunningProfileIds: siblings }));
    assert.equal(restart.decision, 'enqueue');
    assert.deepEqual(restart.siblingProfileIds, siblings);

    const stop = decideInstanceAction('stop', liveCtx({ siblingRunningProfileIds: siblings }));
    assert.equal(stop.decision, 'enqueue');
    assert.equal(stop.expectedIdentity.pid, 4321);
  });

  test('siblings never turn ALREADY_RUNNING/ALREADY_STOPPED into rejections', () => {
    // Same-profile running -> noop regardless of how many siblings run.
    const running = decideInstanceAction(
      'start',
      liveCtx({ siblingRunningProfileIds: ['userB', 'userC'] })
    );
    assert.equal(running.decision, 'noop');
    assert.equal(running.code, 'ALREADY_RUNNING');

    // Same-profile absent + stop -> noop regardless of siblings.
    const stopped = decideInstanceAction(
      'stop',
      baseCtx({ siblingRunningProfileIds: ['userB', 'userC'] })
    );
    assert.equal(stopped.decision, 'noop');
    assert.equal(stopped.code, 'ALREADY_STOPPED');
  });

  test('the deciding instance is excluded from its own sibling list', () => {
    const ctx = baseCtx({
      profileId: 'userA',
      siblingRunningProfileIds: ['userA', 'userB']
    });
    const decision = decideInstanceAction('start', ctx);
    assert.deepEqual(decision.siblingProfileIds, ['userB']);
  });

  test('two different profiles of the SAME service get DIFFERENT instance ids', () => {
    const a = decideInstanceAction('start', baseCtx({ profileId: 'userA' }));
    const b = decideInstanceAction('start', baseCtx({ profileId: 'userB' }));
    assert.notEqual(a.instanceId, b.instanceId);
    assert.equal(a.instanceId, 'antigravity-mcp__userA');
    assert.equal(b.instanceId, 'antigravity-mcp__userB');
    assert.equal(a.serviceId, b.serviceId);
  });

  test('decision is a pure function: inputs are never mutated', () => {
    const ctx = baseCtx({
      profileId: 'userA',
      siblingRunningProfileIds: ['userB', 'userA', 'userC']
    });
    const snapshotCopy = JSON.parse(JSON.stringify(ctx));
    const before = JSON.parse(JSON.stringify(ctx));
    decideInstanceAction('start', ctx);
    assert.deepEqual(ctx, before, 'decideInstanceAction must not mutate ctx');
    assert.deepEqual(ctx.snapshot, snapshotCopy.snapshot);
  });
});

// ===========================================================================
describe('11. publicInstanceDTO redaction', () => {
  const DTO_KEYS = [
    'healthURL',
    'identityVerified',
    'instanceId',
    'lastExitCode',
    'localPort',
    'managed',
    'maskedTunnelId',
    'observedAt',
    'operationId',
    'owned',
    'pid',
    'profileId',
    'profileLabel',
    'reasonCode',
    'serviceId',
    'startedAt',
    'state'
  ].sort();

  test('returns exactly the contracted field set (no extra fields leak)', () => {
    const dto = publicInstanceDTO({
      instanceId: 'antigravity-mcp__userA',
      serviceId: 'antigravity-mcp',
      profileId: 'userA',
      state: 'running'
    });
    assert.deepEqual(Object.keys(dto).sort(), DTO_KEYS);
  });

  test('drops raw tunnel ids, api keys, yaml and filesystem paths passed in', () => {
    const dto = publicInstanceDTO({
      instanceId: 'antigravity-mcp__userA',
      serviceId: 'antigravity-mcp',
      profileId: 'userA',
      state: 'running',
      maskedTunnelId: 'tunnel_ab****yz',
      // The following must never survive into the public DTO.
      tunnelId: 'tunnel_abcdef123456',
      tunnel_id: 'tunnel_abcdef123456',
      apiKey: 'sk-live-secret',
      api_key: 'sk-live-secret',
      configYaml: 'tunnel_id: tunnel_abcdef123456\napi_key: sk-live',
      executablePath: 'C:\\production\\tunnel-client.exe',
      configPath: 'C:\\Users\\prod\\AppData\\Roaming\\tunnel-client\\antigravity.yaml',
      profileYamlPath: 'C:\\secret\\antigravity_profile_userA.yaml',
      credential: { apiKey: 'sk-live' }
    });

    assert.deepEqual(Object.keys(dto).sort(), DTO_KEYS);
    assert.equal(dto.maskedTunnelId, 'tunnel_ab****yz');

    const serialized = JSON.stringify(dto);
    for (const leak of [
      'tunnel_abcdef123456',
      'sk-live-secret',
      'sk-live',
      'configYaml',
      'executablePath',
      'configPath',
      'profileYamlPath',
      'credential',
      'AppData',
      '.yaml'
    ]) {
      assert.ok(!serialized.includes(leak), `public DTO must not leak ${leak}`);
    }
  });

  test('passes a masked tunnel id through and defaults it to null', () => {
    assert.equal(
      publicInstanceDTO({ serviceId: 'antigravity-mcp', profileId: 'userA', maskedTunnelId: 'tun_****' }).maskedTunnelId,
      'tun_****'
    );
    assert.equal(publicInstanceDTO({ serviceId: 'antigravity-mcp', profileId: 'userA' }).maskedTunnelId, null);
    assert.equal(
      publicInstanceDTO({ serviceId: 'antigravity-mcp', profileId: 'userA', maskedTunnelId: 12345 }).maskedTunnelId,
      null
    );
  });

  test('normalizes invalid pid and localPort to null', () => {
    const invalid = [
      { pid: 0, localPort: 0 },
      { pid: -1, localPort: -1 },
      { pid: 1.5, localPort: 1.5 },
      { pid: '1234', localPort: '8080' },
      { pid: NaN, localPort: NaN },
      { pid: null, localPort: null },
      { pid: undefined, localPort: undefined }
    ];
    for (const overrides of invalid) {
      const dto = publicInstanceDTO({ serviceId: 'antigravity-mcp', profileId: 'userA', ...overrides });
      assert.equal(dto.pid, null, `pid ${String(overrides.pid)} must normalize to null`);
      assert.equal(dto.localPort, null, `localPort ${String(overrides.localPort)} must normalize to null`);
    }

    const valid = publicInstanceDTO({ serviceId: 'antigravity-mcp', profileId: 'userA', pid: 4321, localPort: 51234 });
    assert.equal(valid.pid, 4321);
    assert.equal(valid.localPort, 51234);
  });

  test('derives instanceId from service+profile when absent', () => {
    const dto = publicInstanceDTO({ serviceId: 'antigravity-mcp', profileId: 'userA' });
    assert.equal(dto.instanceId, 'antigravity-mcp__userA');
    assert.equal(dto.serviceId, 'antigravity-mcp');
    assert.equal(dto.profileId, 'userA');
  });

  test('an empty input yields a fully-null, non-leaking DTO with state `unobserved`', () => {
    const dto = publicInstanceDTO();
    assert.deepEqual(Object.keys(dto).sort(), DTO_KEYS);
    assert.equal(dto.instanceId, null);
    assert.equal(dto.serviceId, null);
    assert.equal(dto.profileId, null);
    assert.equal(dto.state, 'unobserved');
    assert.equal(dto.managed, false);
    assert.equal(dto.owned, false);
    assert.equal(dto.identityVerified, false);
    for (const key of ['pid', 'localPort', 'startedAt', 'healthURL', 'maskedTunnelId', 'operationId', 'reasonCode', 'lastExitCode', 'observedAt']) {
      assert.equal(dto[key], null, `${key} must default to null`);
    }
  });
});
