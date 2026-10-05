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
```

Global flags: `-C <path>` (project directory), `--json`, `-y`, `--elevated`.

Run `caps <command> --help` for the full surface.

### Profile inheritance

A profile can extend other profiles, so capabilities shared by several profiles
(say, two logging hooks) live in one place:

```bash
caps profiles create Logging -c log-tool-use log-session-end
caps profiles create Work -c work-mcp --extends Logging
caps profiles edit Work --add-extends Review     # also --remove-extends, --extends (replace), --no-extends
caps profiles list                               # inherited capabilities are marked "^ … (from Logging)"
```

- The effective capability list is each parent's effective list (depth-first, in
  `extends` order) followed by the profile's own capabilities; duplicates keep their
  first position. Inheritance only adds — a child cannot drop a parent's capability.
- Cycles and missing parents are rejected when editing and again when compiling.
- Changing a parent marks every project using a descendant profile as pending, and
  re-applying writes the new effective set.
- A profile that others extend cannot be deleted; remove it from their `extends` first.
- `vanilla` stays empty: it cannot be edited and cannot be extended.
- `--json` output includes `extends` and `effectiveCapabilityIds`.

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
