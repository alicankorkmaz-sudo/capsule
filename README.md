# Capsule

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
npm install
npm run build
npm link          # installs the `caps` and `cx` binaries
```

## Usage

Two binaries:

- **`caps`** — the manager CLI.
- **`cx`** — launcher; applies a profile, then starts Claude Code in the current directory.

```bash
cx                          # launch with the Vanilla profile
cx -p personal              # launch with a named profile
cx -p personal -- --resume  # pass arguments through to Claude Code

caps profiles list          # all profiles and their capabilities
caps profiles apply personal
caps profiles preview personal   # dry run — show what would change
caps profiles deactivate         # restore the project's original files

caps servers list           # MCP servers across every target
caps targets                # config files and their status
caps catalog list           # every known capability
caps plugins sync           # pull installed Claude Code plugins into the catalog
caps import scan            # find importable capabilities in existing configs
caps backups list           # every backup Capsule has taken
```

Global flags: `-C <path>` (project directory), `--json`, `-y`, `--elevated`.

Run `caps <command> --help` for the full surface.

### Web UI

```bash
npm run dev     # API on :8787, Vite dev server on :5173
npm start       # built server on :8787, serves the built client
```

## Safety

Applying a profile rewrites managed files, so Capsule backs up their prior contents
first — `caps backups list`, then `caps backups restore <id>` or `restore-group <id>`.
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
