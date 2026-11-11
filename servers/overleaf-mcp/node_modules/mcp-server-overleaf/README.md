# Overleaf MCP Server — Safe AI Editing for LaTeX Papers

[![npm version](https://img.shields.io/npm/v/mcp-server-overleaf?logo=npm&label=npm)](https://www.npmjs.com/package/mcp-server-overleaf)
[![Build](https://github.com/yangzichao/mcp-server-overleaf/actions/workflows/check.yml/badge.svg)](https://github.com/yangzichao/mcp-server-overleaf/actions/workflows/check.yml)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-listed-16A34A)](#find-it-in-the-mcp-registry)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Connect **Claude Code, Claude Desktop, Codex, ChatGPT, Cursor, VS Code, or any MCP client**
to Overleaf. Read, search, edit, compile, and review real LaTeX projects without
copy-pasting your paper into a chat window.

```bash
npx --yes mcp-server-overleaf@0.3.9 setup
```

Edits stay in a local clone until you explicitly publish them. Before every read and every
push, this Overleaf MCP server checks what your collaborators changed. If both of you touch
the same lines, it stops the push and shows both versions instead of choosing a winner.

With an optional Overleaf session cookie, edits can also arrive as tracked-change
suggestions for co-authors to accept or reject, and the existing review panel becomes
readable. A plain Git push cannot express either.

**[Download the one-click Claude Desktop bundle](https://github.com/yangzichao/mcp-server-overleaf/releases/latest/download/mcp-server-overleaf.mcpb)**
or use the setup command above for Claude Code, Codex, Cursor, and other local AI clients.

![A 22-second demonstration of mcp-server-overleaf detecting a collaborator conflict and refusing to overwrite the co-author's edit](docs/assets/collaborator-safety-demo.gif)

---

Independent community project; not affiliated with or endorsed by Overleaf.

## Why choose this Overleaf MCP server?

Several Overleaf MCP servers exist. Of the ones built on Overleaf's official Git bridge,
this is the most complete, and it is the only one that stops instead of overwriting when a
co-author has already changed the lines you are editing.

- **A conflict ends the push, not your co-author's paragraph.** Every read and every push
  first checks what changed on Overleaf. When two edits touch the same lines, `push_changes`
  refuses and shows you both versions.
- **18 tools, and nothing reaches Overleaf until you say so.** Read, search, and edit by
  section or by exact text, add, rename and remove files, compile locally, inspect the diff,
  then publish deliberately.
- **An edit can arrive as a suggestion, not as finished text.** Three optional tools talk to
  Overleaf's editor rather than the Git bridge, so a change lands in the review panel for a
  co-author to accept or reject. A Git push cannot express that.
  [Tracked changes](docs/tracked-changes.md)
- **No terminal, if you do not want one.** Claude Desktop installs it from a downloaded
  bundle; Claude Code and Codex install it as a plugin.
- **The token is written once, to one file, at mode 600.** No client configuration holds
  it, and the published plugin declares no environment variables at all.

[Related projects](docs/related-projects.md) compares the alternatives tool by tool, and is
equally direct about the things this server cannot do.

Common workflows include revising an academic paper by section, searching a large LaTeX
project, checking a bibliography, compiling before publication, reviewing the exact diff,
and sending an edit to Overleaf as a tracked suggestion.

## Where it installs

Every route below reaches the same server and the same 18 tools, and every one of them
keeps edits local until an explicit push. Pick the row for your client. The three
[tracked-changes tools](docs/tracked-changes.md) are extra, and appear only once a session
cookie is configured.

| Client | How to install it |
| --- | --- |
| Claude Desktop | Download the bundle and double-click it. [One click](#install-into-claude-desktop-with-one-click) |
| Claude Code | Add this repository as a plugin marketplace. [Two commands](#install-as-a-claude-code-or-codex-plugin) |
| Codex CLI, desktop, and IDE extension | The same, with the Codex commands. [Two commands](#install-as-a-claude-code-or-codex-plugin) |
| Cursor | `npx --yes mcp-server-overleaf setup`. [One command](#install-with-one-command) |
| Visual Studio Code | A `.vscode/mcp.json` entry. [Guide](docs/connect-local-mcp-clients.md#6-visual-studio-code) |
| ChatGPT on the web and desktop | An outbound-only Secure MCP Tunnel, no public endpoint and no open port. [Guide](docs/connect-chatgpt-with-secure-mcp-tunnel.md) |
| A catalogue that reads the MCP registry | Already listed as `io.github.yangzichao/mcp-server-overleaf`. [Details](#find-it-in-the-mcp-registry) |
| Any other MCP client | `npx --yes mcp-server-overleaf --stdio`, or Streamable HTTP. [By hand](#install-from-npm-by-hand) |
| A machine you are developing on | A source checkout. [From source](#install-from-a-source-checkout) |

Claude Desktop takes a packaged bundle; Claude Code and Codex each take a plugin.
Everywhere else `setup` does the equivalent. All four routes end the same way: the token is
verified against Overleaf, written to one file at mode 600, and no client configuration
holds the secret.

## Guides

- [Project configuration and efficient reads](docs/project-workflows.md) covers independent credentials,
  sparse checkout, revision reads, and guarded edits.
- [Related projects](docs/related-projects.md) describes existing alternatives and this
  project's focus on collaborator safety and recovery.
- [Release process and verification](docs/releasing.md) describes the tested artifact,
  provenance, first publication, and subsequent trusted publishing.
- [Install the Claude Desktop bundle](docs/install-claude-desktop-bundle.md) covers the
  one-click `.mcpb` extension: what is inside it, how to build it, and how to remove it.
- [Install the Claude Code and Codex plugins](docs/install-plugins.md) covers the two
  marketplace entries: what the plugin contains, how it gets a token without holding one,
  and how to update, remove, or build it.
- [Connect local MCP clients to Overleaf](docs/connect-local-mcp-clients.md) covers Codex
  desktop and CLI, Claude Code, Claude Desktop, Cursor, Visual Studio Code, local stdio,
  verification, and troubleshooting.
- [Connect ChatGPT to Overleaf with Secure MCP Tunnel](docs/connect-chatgpt-with-secure-mcp-tunnel.md)
  covers the complete private connection from a local stdio server to ChatGPT desktop and
  web, including workspace association, least-privilege credentials, validation, and
  troubleshooting.

## What you are installing

An MCP server exposing 18 tools over stdio or Streamable HTTP, plus 3 more when a session
cookie turns on [tracked changes](docs/tracked-changes.md). One core, two transports;
the tool implementations are identical and only the framing differs. `setup` connects it
to the AI clients on this computer and is the only command most people need.

Requires Node 22.14+ and git on PATH; Node 24 LTS is recommended. `compile_project` additionally needs `latexmk` and a TeX
distribution; every other tool works without them.

The release test matrix covers macOS and Linux. Windows Git and TeX workflows are not yet
validated. This server is a command-line application, not an importable JavaScript library.

Git integration has to be available for the project. Overleaf documents it as a premium
feature gated on the **project owner's** subscription, so a free account invited to a
project owned by someone with a subscription can still use it, and that subscription can be
individual, group, or institutional. Do not tell a user their own plan disqualifies them.
Verify it directly in step 3 instead.

## Install into Claude Desktop with one click

Download **[mcp-server-overleaf.mcpb](https://github.com/yangzichao/mcp-server-overleaf/releases/latest/download/mcp-server-overleaf.mcpb)**
and double-click it. Claude Desktop opens an install panel, asks for the two values below,
and starts the server itself. No terminal, no Node installation, no build.

- **Overleaf project address** — open the project in Overleaf and copy the whole URL from
  the address bar.
- **Overleaf Git token** — generate one at <https://www.overleaf.com/user/settings> under
  Git integration. Claude Desktop stores it in the operating system keychain.

The bundle carries the same server npm publishes, with its locked runtime dependencies and
nothing else. It is macOS and Windows only, because that is where Claude Desktop runs. For
any other client, use the command below. Details in
[Install the Claude Desktop bundle](docs/install-claude-desktop-bundle.md).

## Install as a Claude Code or Codex plugin

Store the token once:

```bash
npx --yes mcp-server-overleaf@0.3.9 setup --clients none
```

Then, in Claude Code:

```bash
claude plugin marketplace add yangzichao/mcp-server-overleaf
claude plugin install overleaf@mcp-server-overleaf
```

Or in Codex:

```bash
codex plugin marketplace add yangzichao/mcp-server-overleaf
codex plugin add overleaf@mcp-server-overleaf
```

Restart the client, then ask it to list the files in your project.

Until this local MCP server is accepted into a public directory, both clients install it
from this repository's marketplace: Claude Code reads `.claude-plugin/marketplace.json` and
Codex reads `.agents/plugins/marketplace.json`, and both point at the same
`plugins/overleaf` directory. That plugin holds no token and sets no environment variable,
because the first command writes the token to `~/.config/overleaf-mcp/projects.json` and the
server finds it there. Public directory review is separate from this repository-based
installation. Details in
[Install the Claude Code and Codex plugins](docs/install-plugins.md).

## Install with one command

```bash
npx --yes mcp-server-overleaf@0.3.9 setup
```

It checks Node and git, asks for the project and a token, proves the token reaches Overleaf
before writing anything, and registers the server with the clients it finds on this
computer: Claude Code, Codex, Claude Desktop and Cursor. A failed run leaves no
half-configuration behind, because nothing is written until Overleaf accepts the token.

Two things are needed, both from the browser:

- **The project address.** Open the project in Overleaf and copy the whole URL from the
  address bar. A read-only share link is a different thing, and setup says so rather than
  failing later.
- **A git authentication token**, generated at <https://www.overleaf.com/user/settings>
  under Git integration. It is not echoed as you type.

The token is written to `~/.config/overleaf-mcp/projects.json` at mode 600 and nowhere
else. The server finds that file on its own, so no client configuration holds the secret,
a path to it, or any environment variable. Clients are registered with an absolute Node
path and an absolute entry point rather than `npx`, because a desktop application starts
with a much smaller PATH than a terminal.

Restart Claude Desktop, Cursor, or Codex afterwards; Claude Code picks it up on the next
run. Then ask the assistant to list the files in the project.

Setup can also run unattended:

```bash
printf '%s' "$OVERLEAF_TOKEN" | npx --yes mcp-server-overleaf@0.3.9 setup \
  --project paper=https://www.overleaf.com/project/64a1b2c3d4e5f6a7b8c9d0e1 \
  --token-stdin --yes
```

`--clients claude-code,codex` limits which clients are touched, and `--clients none`
writes the configuration without registering anything. Run it again to add another
project or to replace an expired token; the previous file is kept alongside it.

## Find it in the MCP registry

The server is listed in the official Model Context Protocol registry as
`io.github.yangzichao/mcp-server-overleaf`. The listing names the npm package and the Claude
Desktop bundle, and clients and catalogues that read the registry pick it up from there. The
release workflow publishes the listing itself, so it can never point at a version npm does
not have.

Claude Code and Codex do not read that registry. They have their own plugin marketplaces,
which is the section above, or the server can be added by hand:

```bash
claude mcp add --transport stdio --scope user overleaf -- npx --yes mcp-server-overleaf@0.3.9 --stdio
codex mcp add overleaf -- npx --yes mcp-server-overleaf@0.3.9 --stdio
```

Both forms need `OVERLEAF_GIT_TOKEN` and `OVERLEAF_PROJECT_ID` in the environment, which is
why `setup` writes a `projects.json` instead and registers an absolute path.

## Install from npm by hand

Use this when you want to see every step, or to configure a client setup does not cover.
The commands below select version `0.3.9` explicitly so a client restart does not silently
upgrade the server. If that version has not been published yet, use the source installation
below. npm installs compiled JavaScript and locked runtime dependencies; no local build is needed.

```bash
npx --yes mcp-server-overleaf@0.3.9 --version
```

Keep configuration outside the npm installation and npx cache. Create a private file:

```bash
mkdir -p "$HOME/.config/overleaf-mcp"
touch "$HOME/.config/overleaf-mcp/env"
chmod 600 "$HOME/.config/overleaf-mcp/env"
```

Edit that file locally to contain your token and project ID:

```dotenv
OVERLEAF_GIT_TOKEN=olp_your_token_here
OVERLEAF_PROJECTS=paper=64a1b2c3d4e5f6a7b8c9d0e1
```

For clients using the `mcpServers` JSON format:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["--yes", "mcp-server-overleaf@0.3.9", "--stdio"],
      "env": {
        "OVERLEAF_MCP_ENV_FILE": "/absolute/path/to/.config/overleaf-mcp/env"
      }
    }
  }
}
```

Replace the file path with its actual absolute path; JSON does not expand `~` or `$HOME`.
Clients with another configuration format should launch the same command and arguments with
the same environment variable. If a desktop app cannot find `npx`, use its absolute path
from `command -v npx`. See the [client guide](docs/connect-local-mcp-clients.md) for source
installation examples and client-specific configuration locations.

Alternatively, set both `OVERLEAF_GIT_TOKEN` and `OVERLEAF_PROJECTS` in the client's `env`.
With `OVERLEAF_MCP_ENV_FILE`, environment variables override individual file values; an
unreadable or relative explicit file path is an error. Without it, the install's `.env` is
used only when the client supplies no project or credential settings (including file paths).
A JSON projects file can provide independent credentials; see the [configuration guide](docs/project-workflows.md).
The current working directory is never searched for configuration.

After restarting the client, call `list_projects` to check configuration and `list_files`
to verify access to the real project. Tool discovery alone does not prove Overleaf access.

## Install from a source checkout

## Step 1: build

```bash
npm ci && npm run build
```

Confirm `dist/index.js` exists before continuing. Record the absolute path of the
repository root; every client configuration below needs it, and relative paths will not
work because clients spawn the server from an arbitrary working directory.

## Step 2: collect two values from the user

**The git authentication token.** Generated at <https://www.overleaf.com/user/settings>,
under Git integration. One token covers all their projects and expires after a year. It
starts with `olp_`.

Ask the user to paste it into `.env` themselves rather than into the chat, using the
command in step 3. A token pasted into a conversation is in the transcript permanently and
has to be rotated. If they paste it anyway, tell them plainly to rotate it, and continue.

**One or more project ids.** The last path segment of a project URL:
`https://www.overleaf.com/project/<projectId>`. A project id is exactly 24 hexadecimal
characters. Anything else is not a project id, and you should ask again rather than guess.

## Step 3: write .env and verify the token works

```bash
cp .env.example .env && chmod 600 .env
```

Then have the user fill in:

```
OVERLEAF_GIT_TOKEN=olp_...
OVERLEAF_PROJECTS=paper=64a1b2c3d4e5f6a7b8c9d0e1
```

`OVERLEAF_PROJECTS` is a comma-separated list of `name=projectId` pairs. The names are
arbitrary labels the user picks. A bare project id with no name is also accepted and
registers under its own id. With exactly one project registered it becomes the default; with
several, set `OVERLEAF_DEFAULT_PROJECT`, use an alias named `default`, or name the project in each call.

Verify the credentials reach Overleaf before configuring any client:

```bash
git ls-remote https://git@git.overleaf.com/<projectId>
```

Git will prompt for a password. That is the token. Refs printed means it works. `403` or
`Repository not found` means either the token is wrong or that account's plan does not
include Git integration; resolve this before continuing, because every tool depends on it.

The server reads `.env` itself, because MCP clients spawn it without a shell. This keeps the
token in one file whose permissions the user controls, instead of copied into every client's
config. Anything the client sets in the environment explicitly still wins.

## Step 4: register with the client

Use the absolute path from step 1. Configure only the client the user actually asked for.
For client-specific configuration locations, verification, and troubleshooting, see the
[local MCP client guide](docs/connect-local-mcp-clients.md).

**Claude Code**

```bash
claude mcp add overleaf -s user -- node /absolute/path/to/mcp-server-overleaf/dist/index.js --stdio
```

Then run `claude mcp list` and confirm it reports `✔ Connected`. Do not report success
until you have seen that.

**Claude Desktop or Cursor** — add to the client's MCP config file. The file location and
restart steps differ by client; the local MCP client guide lists both.

```json
{
  "mcpServers": {
    "mcp-server-overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-overleaf/dist/index.js", "--stdio"]
    }
  }
}
```

**Codex desktop, CLI, or IDE extension** — the clients on one Codex host share
`~/.codex/config.toml`:

```toml
[mcp_servers.mcp-server-overleaf]
command = "node"
args = ["/absolute/path/to/mcp-server-overleaf/dist/index.js", "--stdio"]
```

Add `default_tools_approval_mode = "writes"` inside the server table if the user wants
reads to run freely while every write asks first.

**ChatGPT desktop local MCP settings** can start the same stdio command directly on the
computer that holds this repository. This local configuration is shared with Codex clients
on the same host; the local MCP client guide includes the UI and CLI paths.

**ChatGPT web or a workspace-shared ChatGPT app** — use OpenAI Secure MCP Tunnel without
exposing the server to the public internet. ChatGPT connects to an OpenAI-hosted tunnel
endpoint while `tunnel-client` forwards requests to `dist/index.js --stdio`. Follow the
[step-by-step Secure MCP Tunnel guide](docs/connect-chatgpt-with-secure-mcp-tunnel.md); it
includes the required Platform organization and ChatGPT workspace association, runtime key,
developer-mode app setup, and end-to-end verification.

**Remote clients over HTTP**

```bash
node dist/index.js --http --port 3017
```

`--http` refuses to start without `OVERLEAF_MCP_HTTP_AUTH_TOKEN`, since anyone who reaches
the port could otherwise read and rewrite the user's papers. `--allow-anonymous` overrides
this and should only be used when the port is genuinely unreachable from outside the
machine. Do not pass it to work around a missing token.

## Step 5: verify end to end

Call `list_files`. A file listing means the whole path works: configuration, token, clone,
and the client connection. If it fails, the error text says which.

## The tools

Every tool takes an optional `project`: a project's Overleaf address, its raw 24-character
id, or a name from `OVERLEAF_PROJECTS`. Omit it to use the default. The address is accepted
because it is the form you already have, so a paper that was never configured can be reached
by pasting it. An unregistered project requires a default Git token; registered ones use
their configured project credentials.

| Tool | What it does |
| --- | --- |
| `list_projects` | The projects this server can reach |
| `list_files` | Files grouped by kind; extension filter and optional new local files |
| `read_file` | Text or line ranges; optional revision-aware full/unchanged/delta reads |
| `list_sections` | Sectioning commands in a `.tex` file, with line ranges |
| `read_section` | The body of one section, found by title |
| `search_project` | Search tracked text files |
| `replace_text` | Replace an exact snippet, refusing ambiguous matches |
| `edit_section` | Replace one section wholesale |
| `write_file` | Overwrite or create a file |
| `delete_file` | Remove a file, local until pushed |
| `move_file` | Move or rename a file, refusing to overwrite the destination |
| `show_diff` | The diff of everything not yet pushed |
| `discard_local_changes` | Throw away unpushed edits and commits, back to Overleaf's version |
| `project_status` | Sync state, pending edits, recent history |
| `project_summary` | JSON file counts, main document, sections and pending changes |
| `sync_project` | Pull from Overleaf |
| `compile_project` | Compile with latexmk and report errors |
| `push_changes` | Commit and publish, with the collaborator check |

## How to use the tools safely

Edits are local until `push_changes`. This is the whole design, not an implementation
detail, and it is what lets a bad edit be thrown away instead of published.

Read `show_diff` before calling `push_changes`. Push once, with a real commit message; the
user sees it in Overleaf's history next to their co-authors' entries.

`push_changes` can return `conflict-with-collaborator`. This means someone edited the same
lines while you were working. Nothing was published and both versions are intact. Do not
retry, do not force, and do not attempt to merge the two yourself. Report the conflict and
let the user decide.

A refused push leaves its commit in the clone, so the clone is then both ahead of and
behind Overleaf and every later sync conflicts on the same lines. `discard_local_changes`
is the way out: it drops unpushed commits as well as uncommitted edits and returns the
clone to what Overleaf holds. Tell the user what is being thrown away before calling it,
because their edit is what goes.

`replace_text` refuses a snippet that appears more than once rather than silently changing
the first. Add surrounding context to make it unique, or pass `replaceAll` deliberately.

Prefer `replace_text` and `edit_section` over `write_file`. `write_file` replaces an entire
file, so a partial reconstruction of a document silently deletes the rest of it.

`delete_file` and `move_file` are local until `push_changes` like every other edit, so a
removal can be undone with `discard_local_changes` right up to the push. Neither rewrites
LaTeX references: after a move, `search_project` for the old path and fix any `\input`,
`\include` or `\includegraphics` that still names it, or the paper stops compiling. Before
deleting, check the file is genuinely unused — a co-author's `\input` is enough to break
their build.

For a read–edit cycle, request `read_file` with `mode: "full"` or `"smart"` and pass its
`revision` as `expectedRevision` to any edit tool. The edit then refuses to overwrite a
file changed by a collaborator or another client since that read. See the
[revision protocol](docs/project-workflows.md#revision-reads-and-guarded-edits).

Compilation is optional and is not a gate. `push_changes` never checks that the document
builds, so a broken document can be published if you do not check first.

## Configuration reference

| Variable | Meaning |
| --- | --- |
| `OVERLEAF_GIT_TOKEN` | Default credential; required unless supplied by a token file or per project. |
| `OVERLEAF_GIT_TOKEN_FILE` | Absolute path to a default token file. |
| `OVERLEAF_PROJECTS_CONFIG` | Absolute path to a JSON projects file with independent credentials. |
| `OVERLEAF_PROJECT_ID` / `OVERLEAF_PROJECT_NAME` | Single-project alternative to `OVERLEAF_PROJECTS`. |
| `OVERLEAF_MCP_ENV_FILE` | Absolute path to an external config file; recommended for npm/npx. |
| `OVERLEAF_PROJECTS` | `name=projectId` pairs; optional with JSON or raw-id access. |
| `OVERLEAF_DEFAULT_PROJECT` | Which registered name to use when a call omits `project`. |
| `OVERLEAF_MCP_CHECKOUT_MODE` | `full` (default) or `text-only`; see expansion behavior in the configuration guide. |
| `OVERLEAF_MCP_WORKSPACE_DIR` | Where clones live. Default `~/.overleaf-mcp/projects`. |
| `OVERLEAF_GIT_BASE_URL` | Default `https://git.overleaf.com`. |
| `OVERLEAF_MCP_COMPILE_TIMEOUT_MS` | Compile timeout. Must be a positive integer. |
| `OVERLEAF_MCP_HTTP_AUTH_TOKEN` | Bearer token required by `--http`. |
| `OVERLEAF_MCP_HTTP_PORT` | Port for `--http`. `--port` overrides it. |
| `OVERLEAF_SESSION_COOKIE` | Overleaf session cookie. Turns on the three [tracked-changes tools](docs/tracked-changes.md). |
| `OVERLEAF_SESSION_COOKIE_FILE` | Absolute path to a file holding the same value. Preferred over the variable. |
| `OVERLEAF_WEB_BASE_URL` | Overleaf's web address for those tools. Default `https://www.overleaf.com`. |

## Why it behaves the way it does

Overleaf's git bridge is not a general git remote. Each project has exactly one branch with
one linear history, force pushes are refused, and there are no tags, submodules or LFS.
Everything here stays inside that envelope.

The real risk is not a failed push, it is silently overwriting a co-author, so writing and
publishing are separate:

1. Every read and every edit synchronizes with Overleaf first. If local work prevents
   synchronization, the call fails and preserves that work. Review it with `show_diff`,
   then publish it or explicitly discard it before continuing; stale reads and edits
   are refused.
2. Edits land in the local clone only. Nothing reaches Overleaf until `push_changes`.
3. `push_changes` re-checks Overleaf immediately before pushing and rebases onto anything
   that landed in the meantime. If that cannot be applied cleanly the push is refused and
   the conflict reported, rather than resolved by guessing.

Git credentials are handed to git through a credential helper, so authentication tokens
are absent from argv and `.git/config`. Git diagnostics redact the selected credential;
tool errors redact every configured project credential. Keep secrets out of project files,
which are intentionally readable by the connected client.

Compilation writes outside the clone, so `.aux`, `.log` and `.pdf` files are never staged
and pushed back. Clones also carry a local exclude list, so a `.DS_Store` never reaches a
co-author's project.

Tool calls are serialized per project, first by an in-process queue and then by a lock
directory under the workspace, so a second server process, such as the same server
registered in two clients, waits instead of racing.

Client-supplied paths are checked twice: once as a path, and once against the filesystem
after symbolic links are resolved, so a link inside a clone cannot reach outside it or into
`.git`.

## Layout

```
src/
  config/      environment parsing, secret redaction
  overleaf/    git command runner, repository operations, project registry, path safety
  latex/       section parsing, file categorization
  workflow/    sync-before-edit, publish-with-conflict-check, compile
  tools/       MCP tool definitions
  transport/   stdio and Streamable HTTP
  server/      server factory shared by both transports
tests/
  config/ latex/ overleaf/  unit tests, run in-process
  features/                 Gherkin specifications, bound to the server over stdio
  integration/              spawn the built server and speak MCP to it over stdio or HTTP
```

## Development

```bash
npm run check
```

Runs the type checker, Biome, the build, and the tests in one pass.
The type checker includes test code. Every Vitest invocation builds the server first,
including focused runs and coverage, so the subprocess tests cannot use an old `dist`.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-check source, tests and Vitest configuration |
| `npm run lint` | Biome lint and format check |
| `npm run format` | Biome, applying fixes |
| `npm test` | Build, then Vitest, whole suite |
| `npm run package:check` | Build twice, compare tarballs, install as a user would, and test the installed server |
| `npm run check:release` | Source checks, package checks, and dependency audit |
| `npm run test:coverage` | Build, then Vitest with v8 coverage |

The suites cover the same tool contract over stdio and HTTP, including schemas, error
flags, reading, editing, reviewing and publishing. Recovery tests exercise dirty-tree
sync, conflict recovery, remote rejection and reconnection, process restarts, a killed
lock holder, and simultaneous clients. New files and unpushed commits must remain
visible in `show_diff`. Deterministic subprocess fixtures test Git and compiler timeouts
without needing a network connection or TeX installation.

`tests/features/` states the publishing contract as a Gherkin feature file: plain sentences
about what a co-author sees, each one bound to a real call against the server over stdio.
A sentence with no binding fails the run, so the document cannot drift away from the
behaviour it describes. Add a scenario by writing it in the `.feature` file and binding its
new steps in the `.test.ts` beside it; steps are shared across the scenarios of a feature,
so most new scenarios need no new bindings at all.

TeX-dependent tests share one availability check. Set `OVERLEAF_TEST_TEX=skip` to run
without TeX, or `OVERLEAF_TEST_TEX=required` to fail if `latexmk` or `pdflatex` is missing.
The default, `auto`, runs those tests when both executables are available. GitHub Actions
runs core checks on Linux and macOS with Node 22.14, 24, and 26, plus a Linux job that installs
TeX and requires the compilation tests to run.

`npm-shrinkwrap.json` is the canonical dependency lock. Update it with npm and commit it with
`package.json`. The copy inside the published package is the runtime half of that file:
`prepack` removes the development entries and `postpack` restores the full lock, because npm
builds a dependency's tree from the shipped lock and would otherwise install the compiler,
the linter and the test runner on every user's machine. The package check fails if the
shrinkwrap inside the tarball still describes development dependencies.
Release package tests reuse the integration suites against an installed tarball from an
unrelated working directory, covering stdio, HTTP, edits, conflicts, and recovery.

That install resolves the declared ranges freshly against the registry rather than reading
the archive's own shrinkwrap, so the tree it tests is the newest one those ranges allow, and
it is compared against the lock by shape rather than by version. A package in one tree and
not the other fails the check, and so does a major version apart (a minor, for a 0.x
package) — an unpinned peer dependency can put one there without any direct dependency
changing. A newer patch or minor is only printed, and `npm update` brings the lock level:
both trees are tested, and requiring the versions to match turned every upstream patch
release red on branches that had not touched a dependency.

Tests never touch the real Overleaf. `tests/integration/fakeOverleafRemote.ts` stands up a
bare git repository plus a second clone acting as a co-author, which reproduces everything
the safety contract depends on: fetch, rebase, and a rejected push.

Coverage under-reports. The integration tests spawn `node dist/index.js` as a separate
process, and v8 cannot instrument a child, so `src/tools/` and `src/server/` report 0% while
being driven end to end over the real MCP wire protocol.

## Frequently asked questions

### Can Claude Code or Claude Desktop edit an Overleaf project?

Yes. Claude Desktop can install the one-click `.mcpb` bundle, while Claude Code can install
the repository as a plugin or run the npm package over stdio. Both expose the same safe
read, edit, compile, diff, and push workflow.

### Can Codex, ChatGPT, Cursor, or VS Code connect to Overleaf?

Yes. Codex can install the included plugin, Cursor and other local clients can run the npm
package, VS Code can use `.vscode/mcp.json`, and ChatGPT can connect through an outbound-only
Secure MCP Tunnel. Start with [the client table](#where-it-installs) for the shortest route.

### Will an AI edit overwrite my co-author's work?

Not silently. The server synchronizes before reads and writes, keeps edits local until an
explicit `push_changes`, and checks Overleaf again immediately before publishing. If a
co-author changed the same lines, the push is refused and both versions are preserved.

### Does this work with a free Overleaf account?

The 16 Git-backed tools require Git integration on the project. Overleaf gates that feature
on the project owner's qualifying subscription, so an invited free account can use it when
the project owner has access through an individual, group, or institutional plan.

### Can it compile LaTeX and show tracked changes?

Yes. `compile_project` runs locally when `latexmk` and a TeX distribution are installed.
With an optional Overleaf session cookie, three additional review tools can create tracked
suggestions, list tracked changes and comments, and comment on selected text.

## Privacy Policy

The server runs entirely on your computer. It has no analytics, no telemetry, and no
service behind it. Its only outbound traffic is Git over HTTPS to Overleaf. Your token is
stored either in the operating system keychain, when Claude Desktop installs the bundle, or
in a mode `600` file written by `setup`, and it is redacted from error output.

Whatever a tool returns becomes part of the conversation with the MCP client you connected,
and is handled under that client's own policy.

Full text: [docs/privacy-policy.md](docs/privacy-policy.md).

## License

MIT
