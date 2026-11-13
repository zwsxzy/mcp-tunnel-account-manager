/**
 * DOM-level contract: does the rendered instance panel actually contain a usable
 * row with ENABLED stop/restart buttons for a running, owned instance?
 *
 * This closes the last untested hop: store -> DTO -> sanitizeMcpDto -> renderMcpInstanceSection.
 * renderMcpInstanceSection had zero test coverage (grep found none in ui-registry.test.mjs),
 * yet it is what the user actually sees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderMcpInstanceSection,
  getMcpInstances,
  countRunningInstances,
  getInstanceActionGating,
  appState
} from '../public/app.js';

const SERVICE = 'mcp_rendersvc';
const PROFILE = 'userA';
const INSTANCE = `${SERVICE}__${PROFILE}`;

// renderMcpInstanceSection resolves profile eligibility from appState, so seed the
// account this service is configured for (otherwise restart/start are legitimately
// disabled with "未找到包含该服务凭证的可用账号").
appState.profiles = [{
  id: PROFILE,
  label: 'Account A',
  services: { [SERVICE]: { tunnelId: 'tunnel_render', hasApiKey: true } }
}];

/** Build the mcp + runtime.instances shape the server now actually delivers. */
function mcpWith(instances) {
  return {
    id: SERVICE,
    label: 'render test',
    enabled: true,
    runtime: { state: instances.length ? 'running' : 'stopped', instances }
  };
}

function ownedRow(overrides = {}) {
  return {
    instanceId: INSTANCE,
    serviceId: SERVICE,
    profileId: PROFILE,
    profileLabel: 'Account A',
    state: 'running',
    managed: true,
    owned: true,
    identityVerified: true,
    pid: 4321,
    startedAt: '2026-11-10T00:00:00.000Z',
    healthURL: 'http://127.0.0.1:5555',
    localPort: 5555,
    maskedTunnelId: 'smo...1111',
    ...overrides
  };
}

// Minimal DOM shim: renderMcpInstanceSection reads appState/dom for eligibility.
test('a running owned instance renders a row with ENABLED stop and restart buttons', () => {
  const html = renderMcpInstanceSection(mcpWith([ownedRow()]));

  assert.match(html, /隧道客户端进程 \(1\)/, 'panel must report one instance');
  assert.match(html, /运行中 1/, 'running badge must appear');

  // The stop button for this row must be present and NOT disabled.
  const stopBtn = html.match(/<button[^>]*data-action="stop"[^>]*>/);
  assert.ok(stopBtn, 'a stop button must be rendered');
  assert.ok(!/\sdisabled(\s|>)/.test(stopBtn[0]), `stop must not be disabled, got: ${stopBtn[0]}`);

  const restartBtn = html.match(/<button[^>]*data-action="restart"[^>]*>/);
  assert.ok(restartBtn, 'a restart button must be rendered');
  assert.ok(!/\sdisabled(\s|>)/.test(restartBtn[0]), `restart must not be disabled, got: ${restartBtn[0]}`);

  // Start must be disabled while running.
  const startBtn = html.match(/<button[^>]*data-action="start"[^>]*>/);
  assert.ok(startBtn, 'a start button must be rendered');
  assert.ok(/\sdisabled(\s|>)/.test(startBtn[0]), 'start must be disabled while running');
});

test('an instance without ownership evidence renders DISABLED stop/restart', () => {
  const html = renderMcpInstanceSection(mcpWith([
    ownedRow({ owned: false, identityVerified: false })
  ]));

  const stopBtn = html.match(/<button[^>]*data-action="stop"[^>]*>/);
  assert.ok(stopBtn, 'stop button must still render');
  assert.ok(/\sdisabled(\s|>)/.test(stopBtn[0]), 'an unverified process must not be stoppable');

  const restartBtn = html.match(/<button[^>]*data-action="restart"[^>]*>/);
  assert.ok(restartBtn);
  assert.ok(/\sdisabled(\s|>)/.test(restartBtn[0]));
});

test('a service with no instances renders the empty state, not a broken panel', () => {
  const html = renderMcpInstanceSection(mcpWith([]));
  assert.match(html, /隧道客户端进程 \(0\)/);
  assert.match(html, /该服务暂无 tunnel-client 记录/);
  assert.ok(!/data-action="stop"/.test(html), 'no stop buttons when there are no rows');
});

test('the rendered row shows masked tunnel id only, never masked secrets unescaped', () => {
  const html = renderMcpInstanceSection(mcpWith([ownedRow()]));
  assert.match(html, /smo\.\.\.1111/, 'masked tunnel id should be displayed');
  assert.ok(!/apikey|api_key|secret\.yaml/i.test(html), 'no credential or production path may appear');
});

test('two concurrent instances both render (the whole point of the feature)', () => {
  const rows = [
    ownedRow(),
    ownedRow({ instanceId: `${SERVICE}__userB`, profileId: 'userB', profileLabel: 'Account B', pid: 4322 })
  ];
  const html = renderMcpInstanceSection(mcpWith(rows));
  assert.match(html, /隧道客户端进程 \(2\)/);
  assert.match(html, /运行中 2/);
  const stopButtons = html.match(/data-action="stop"/g) || [];
  assert.equal(stopButtons.length, 2, 'each row must get its own stop button');
});

test('helpers agree with the rendered counts', () => {
  const mcp = mcpWith([ownedRow()]);
  assert.equal(getMcpInstances(mcp).length, 1);
  assert.equal(countRunningInstances(getMcpInstances(mcp)), 1);
  const gating = getInstanceActionGating({ id: SERVICE, enabled: true }, getMcpInstances(mcp)[0], [PROFILE]);
  assert.equal(gating.stop.disabled, false);
  assert.equal(gating.restart.disabled, false);
});
