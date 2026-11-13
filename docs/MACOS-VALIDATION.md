# macOS port — validation and runtime design

This document describes the `mac` branch. Its Windows source baseline is `final` commit
`2bb5b2ef565263c5178348b3b3f4bc4e50f05658`; the Windows branch is maintained separately.

## Reproduce the default unit suite

Use Node.js 22.14.0 or newer from the repository root:

```bash
mkdir -p "$PWD/artifacts/mac-port-20261113/unit/tmp"
TEST_ARTIFACT_ROOT="$PWD/artifacts/mac-port-20261113/unit" \
TMPDIR="$PWD/artifacts/mac-port-20261113/unit/tmp" \
TEMP="$PWD/artifacts/mac-port-20261113/unit/tmp" \
TMP="$PWD/artifacts/mac-port-20261113/unit/tmp" \
node scripts/run-tests.mjs --unit \
  --report "$PWD/artifacts/mac-port-20261113/unit/report.json"
```

The default test enumeration is retained. Light files keep the 60 second deadline;
heavy files keep the 150 second deadline. The native Windows process file retains
its existing 240 second deadline on Windows. No retry mode, relaxed assertions or
increased test timeout is needed to accept the port.

Tests and downloaded fixtures use the designated artifact directory. Unix domain
socket endpoints on macOS require a short path and use an owned, private directory
under `/tmp`; tests clean those endpoints after use. They are not publishable artifacts.

## Platform coverage

### Local complete-unit result, 2026-11-13

The complete default unit run on Linux / Node.js 24.22.1 passed **68 of 68 files**
(65 light, 3 heavy), with **0 failed files**, exit code **0**, in **18.506 seconds**.
The report is `artifacts/mac-port-20261113/unit-native-exit-fix/report.json`; the full output
is alongside it as `full-unit.log`. Platform skips described below are explicit.
This is local evidence; native macOS results must be read from Actions.

| Check | Execution environment | What it establishes |
| --- | --- | --- |
| Default unit suite | Local Linux workspace; native Mac CI on both architectures | Application contracts, HTTP/auth flows, store, UI, adapters and platform behavior |
| POSIX process lifecycle | Real child processes; Mac Unix sockets / isolated Linux loopback transport | Launch ownership, listeners, sibling isolation, reconnect, stale identity rejection, descendant cleanup and uncertain-state handling |
| Mac process reader | Native Mac commands in CI; explicit Darwin fixtures locally | `ps` / `lsof` parsing, mapped executable checks, boot/start identity and helper failure semantics |
| Mac installer | Isolated fixtures and actual distribution downloads | Integrity, paths, retries, retained user files, read-only verification and failure reporting |
| MCP stdio smoke | Isolated home, no credentials or business tool invocation | `initialize` and `tools/list` for installed Overleaf and Antigravity |
| Windows native process protocol | Separate Windows CI job | All seven original PowerShell / Win32 handle tests |

Seven Win32 tests are explicitly not applicable on macOS/Linux; the Windows CI job
executes them. The existing Windows 8.3-name and junction checks also report their
platform availability. Portable unit tests remain enabled. The new POSIX lifecycle
tests run against actual processes rather than being replaced by Windows mocks.

The local Linux sandbox does not permit Unix domain sockets. Linux lifecycle tests
therefore explicitly inject authenticated loopback TCP control. The production Mac
controller and Mac CI use private Unix sockets. A Linux pass is not evidence that a
Mac executable, Finder, or Unix socket was exercised.

## Native CI

[macOS validation workflow](../.github/workflows/mac.yml) runs on pushes to `mac`:

- `macos-15` — Apple Silicon / `arm64`.
- `macos-15-intel` — Intel / `x64`.
- `windows-latest` — the original Windows native process protocol regression.

Mac jobs verify the actual runner architecture, check every shell entry point,
execute the complete default unit suite, install real components in an isolated
home, perform read-only verification and complete both MCP handshakes. Tests use
Node.js **22.14.0**, the declared minimum. Workflow dependencies are pinned to commit
SHAs and the job token has read-only repository permissions.

The report for each runner is uploaded as a GitHub Actions artifact. Consult the
[run for the relevant commit](https://github.com/zwsxzy/mcp-tunnel-account-manager/actions/workflows/mac.yml?query=branch%3Amac)
for its actual conclusion. A configured workflow alone does not mean a run passed.

## Process ownership on macOS

Each managed tunnel has a small Node supervisor that remains the leader of its own
POSIX session and process group. Its private control file has mode `0600`; its
control endpoint lives in a private directory. A separate random launch capability
authenticates stop requests and is never included in public runtime identities.

The manager verifies the executable, boot/start evidence and launch identity. macOS
`ps` start times have second precision, so a timestamp or numeric PID alone cannot
authorize termination. Only the authenticated, still-running supervisor signals its
own group. There is no `pkill`, `killall`, process-name kill or port-to-PID kill fallback.

A stop receipt requires observed absence of the owned group and any recorded escaped
descendants. Lost control, a failed OS query or surviving detached children produces
an unconfirmed result. The console retains its state instead of reporting success.
Managed stop-all uses the same adapter path and checks every target again before
converging stored state. External processes remain outside its stopping scope.

Short-lived `ps`/`lsof` helpers have a shared physical concurrency budget with a
reserved stop lane. A public timeout does not release the physical lease before
helper exit is observed. Stop retries remain inside the configured operation budget.

Exit proofs reread the same launch's private control record before and after OS
probes. Newly recorded escaped descendants cannot be omitted, and the final stopped
record retains the supervisor's escalation evidence. A changed launch or changed
descendant evidence yields an unconfirmed result instead of overwriting it.

Public admission, helper and observation deadlines retain an event-loop reference
until their result settles. Eight independent Node subprocess regressions check
timeouts, physical lease retention and cleanup without relying on test-runner
handles. Fake-service queue/recovery tests inject a fixed available-memory probe;
the production memory reserves, concurrency limits and timeout budgets are unchanged.

The default Mac console uses a dedicated `runtime/instances` scope for concurrent
instances, below its private data directory. Each account retains its own profile,
record and health endpoint. The Windows production-directory guard is preserved.

## Files and configuration

Mac defaults are resolved in `src/core/platform-paths.mjs`. The console data directory
is `~/Library/Application Support/McpTunnelAccountManager`; tunnel profiles are under
`${XDG_CONFIG_HOME:-~/.config}/tunnel-client`. Launches use explicit profile files.
Paths on POSIX keep their case. macOS directory reveal uses `/usr/bin/open` with an
argument array and checks the result.

Credentials retain the existing AES-256-GCM envelope and authentication format. User
data directories use mode `0700`; the master key and authentication files use `0600`.
Existing key files are checked for ownership, regular-file type and length without
following a final symlink. This port does not claim Apple Keychain integration.

## Component provenance

| Component | Source and verification |
| --- | --- |
| tunnel-client | Official Homebrew `openai/tools/tunnel-client`; record actual formula/CLI version, preserve full `libexec` resources |
| Overleaf | `mcp-server-overleaf@0.3.9`; fixed npm SHA512 SRI, staging installation and lock verification |
| Antigravity | User fork commit `02df3ed95aae0c5103f5db7b332d0c4e6f1eec50`; source SHA256 `1fec6740ac07a0202e92ba8bc657ce35de2b9726feb29d36ee9c15723b79a921` |

The Overleaf SRI and all download URLs are recorded in `SOURCES` in
`scripts/install-components-macos.mjs`. Antigravity is installed from `src/antigravity_mcp`
into `app/antigravity_mcp`; its venv uses a Python-computed relative `.pth` path.
Existing `workflow_settings.json`, YAML and additional user files are preserved.

The initial local distribution smoke used the real published packages and returned
**18 Overleaf tools** and **8 Antigravity tools**. It ran on Linux and invoked no tools;
its detailed results are in the designated installer artifact directory. Native Mac
installation and handshake results are provided by the corresponding CI run.

## What requires the user's environment

Automated validation does not create or authenticate a real OpenAI tunnel, access an
Overleaf account/project, or issue a task to a signed-in Antigravity IDE. Those flows
need the user's own credentials, project setup and IDE session. Finder interaction,
local security prompts, sleep/resume and a particular corporate proxy are also tied
to the user's Mac. These are separate from the unit/installation/protocol results.

## Primary references

- [tunnel-client Homebrew instructions](https://github.com/openai/tunnel-client#install-with-homebrew)
- [tunnel-client configuration](https://github.com/openai/tunnel-client/blob/v0.0.19/docs/configuration.md)
- [Homebrew formula snapshot](https://github.com/openai/homebrew-tools/blob/0f8bbcf96fb2f33f2eb370d7f40bff60f582acd4/Formula/tunnel-client.rb)
- [Antigravity source at the pinned commit](https://github.com/zwsxzy/antigravity-mcp-fork/tree/02df3ed95aae0c5103f5db7b332d0c4e6f1eec50)
- [Overleaf source at v0.3.9](https://github.com/yangzichao/mcp-server-overleaf/tree/v0.3.9)
- [GitHub hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
