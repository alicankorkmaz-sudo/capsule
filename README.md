# Capsule

[![CI](https://github.com/alicankorkmaz-sudo/capsule/actions/workflows/ci.yml/badge.svg)](https://github.com/alicankorkmaz-sudo/capsule/actions/workflows/ci.yml)

Profile-based capability manager for Claude Code and Codex.

Claude Code configuration is spread across several files, and every project wants a
different slice of it. Capsule bundles capabilities into named **profiles**, applies a
profile to a project in one command, and backs up whatever it overwrites.

## Capabilities

A profile enables any mix of six capability kinds:

| Kind | What it is |
| --- | --- |
| `mcp` | An MCP server entry |
| `installed-plugin` | A Claude Code plugin installed from a marketplace |
| `custom-plugin` | An installed plugin forked into an editable copy |
| `skill` | A Claude Code skill |
| `hook` | A Claude Code hook |
| `instruction` | CLAUDE.md / instruction content |

## Targets

Capabilities are written into six config targets, each detected and validated separately:

| Key | File |
| --- | --- |
| `codex` | `~/.codex/config.toml` |
| `codex-project` | `<project>/.codex/config.toml` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| `claude-code-user` | `~/.claude.json` |
| `claude-code-local` | `~/.claude.json` (project-local scope) |
| `claude-code-project` | `<project>/.mcp.json` |

## Install

```bash
npm install -g @alicankorkmaz-sudo/capsule
```

Or from source:

```bash
git clone https://github.com/alicankorkmaz-sudo/capsule.git
cd capsule
npm install
npm run build
npm link          # installs the `caps` and `cx` binaries
```

Requires Node 20 or newer.

## Usage

Two binaries:

- **`caps`** — the manager CLI.
- **`cx`** — launcher; starts Claude Code (or Codex, via `--target codex`) in the current directory, applying a profile if one is given or assigned.

Without `-p`, `cx` means *no profile override*: a project that already has an
assigned profile gets it, and a project with none launches with its own
existing setup, untouched — Capsule writes nothing and records nothing. Use
`cx -p vanilla` to explicitly launch in safe mode with customizations disabled.

```bash
cx                          # the project's assigned profile, or its own setup
cx -p personal              # launch with a named profile
cx -p vanilla               # explicitly disable all customizations
cx -p personal -- --resume  # pass arguments through to Claude Code
cx -t codex                 # start Codex instead of Claude Code
cx --yolo                   # skip every permission/approval prompt
cx -t codex --yolo          # same, for Codex

caps profiles list          # all profiles and their capabilities
caps profiles apply personal
caps profiles preview personal   # dry run — show what would change
caps profiles deactivate         # restore the project's original files

caps servers list           # MCP servers across every target
caps targets                # config files and their status
caps catalog list           # every known capability
caps catalog create autosave -k hook --event SessionEnd --command ./save.sh --timeout 30
caps plugins sync           # pull installed Claude Code plugins into the catalog
caps import scan            # find importable capabilities in existing configs
caps backups list           # every backup Capsule has taken
caps doctor                 # audit catalog, profiles and assignments
```

Global flags: `-C <path>` (project directory), `--json`, `-y`, `--elevated`.

Run `caps <command> --help` for the full surface.

### Doctor

`caps doctor` audits the catalog, profiles and assignments without writing
anything. Each finding has a severity and a one-line fix hint; `--json` prints
a list of `{severity, code, capabilityId?, profileId?, projectPath?, message, hint}`.
It exits 1 if there is any error, otherwise 0 (also available as `GET /api/doctor`).

| Code | Checks |
| --- | --- |
| `plugin-not-installed` | Installed-plugin capability missing from `~/.claude/plugins/installed_plugins.json` |
| `mcp-command-missing` | Stdio MCP command: absolute path missing or not executable, or bare command not on `PATH` |
| `assignment-path-missing`, `assignment-pending` | Assigned project directory is gone; profile changed since it was applied |
| `hook-script-missing`, `hook-command-missing` | Hook command or script it runs is missing (`$HOME`/`~` expanded; `$CLAUDE_PROJECT_DIR` and relative paths checked in every project assigned to a profile using the hook) |
| `skill-file-missing` | `SKILL.md` links to sibling files that the skill's `files` map does not contain |
| `skill-ref-not-in-profile` | A skill invokes `/other-skill` (or "the `other-skill` skill") that is in the catalog but not in the same profile |
| `custom-plugin-missing`, `custom-plugin-unmanaged` | Custom plugin root is missing or outside `~/.capsule/catalog/plugins` |
| `profile-capability-missing`, `assignment-profile-missing`, `duplicate-mcp-name` | Dangling references that make a launch fail |
| `unused-capabilities`, `backups` | Info: capabilities no profile uses; backup count and size |

Errors are problems that break a launch. A broken capability that no profile
uses is reported one level lower (error to warn, warn to info).

The skill-file check is a heuristic and stays conservative. It ignores fenced
code blocks. It counts markdown link targets, plus inline-code paths that start
with `./` or a usual skill folder (`scripts/`, `references/`, `reference/`,
`resources/`, `assets/`, `templates/`, `examples/`). It skips URLs, absolute
paths, `..`, globs, placeholders, directories, paths under typical project
folders (`docs/`, `src/`, `tests/`, `.claude/`, ...), and well-known project
files (`CONTEXT.md`, `AGENTS.md`, `README.md`, `package.json`, ...). It also
skips a file that exists in a project assigned to the skill's profile.

### Web UI

```bash
npm run dev     # API on :8787, Vite dev server on :5173
npm start       # built server on :8787, serves the built client
```

## Safety

Applying a profile rewrites managed files, so Capsule backs up their prior contents
first — `caps backups list`, then `caps backups restore <id>` or `restore-group <id>`.
### Skipping permission prompts

`--yolo` starts the agent with every confirmation turned off: it passes
`--dangerously-skip-permissions` to Claude Code and
`--dangerously-bypass-approvals-and-sandbox` to Codex. The agent can then run
commands without asking, so use it only where that blast radius is acceptable.
It is rejected with the `vanilla` profile, whose whole point is safe mode.

Codex reads MCP servers from `~/.codex/config.toml` (managed by `caps servers`)
rather than from a compiled profile, so `cx -t codex` applies the profile's
Claude-side files but warns that profile plugin directories are not passed to
Codex.

If a managed file was edited outside Capsule, apply refuses until you pass `--force`,
so hand edits are never silently clobbered.

## State

Profiles, the catalog, and backups live in `~/.capsule`. Set `CAPSULE_PROJECTS_DIR` to
change where `caps projects` looks for projects (default `~/Code`).

A pre-rebrand `~/.mcpmanager` directory is moved to `~/.capsule` automatically on first
run. If both exist, Capsule leaves them alone and warns — merge them yourself.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Note on naming: `mcp` throughout the code refers to the Model Context Protocol, not to
this tool. `McpManager` is the class that reads and writes MCP server entries across
targets, alongside `ProfileManager`.

## License

MIT — see [LICENSE](LICENSE).
