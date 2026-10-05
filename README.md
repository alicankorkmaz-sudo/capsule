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
caps catalog create review -k skill --from-dir ~/.claude/skills/review
caps catalog sync           # refresh skills/instructions from their linked sources
caps plugins sync           # pull installed Claude Code plugins into the catalog
caps import scan            # find importable capabilities in existing configs
caps backups list           # every backup Capsule has taken
caps doctor                 # audit catalog, profiles and assignments
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

### Skills and source links

A skill is more than its `SKILL.md`: import and `caps catalog create/edit --from-dir <dir>`
also capture every other text file in the skill directory (recursively) and write them
back next to `SKILL.md` when a profile is applied. Dotfiles, dot-directories and
`node_modules` are ignored; binary files and files over 512 KiB are skipped with a
warning. `caps catalog get <skill>` lists the captured files.

Catalog entries are snapshots: applying a profile always uses the stored copy. Skills
and instructions remember where they came from in `sourcePath` (the skill directory,
or the instruction file). Import, `--from-dir` and `--content-file` set it
automatically; `--source <path>` sets it explicitly and `--no-source` removes it.
Entries created before source links existed have none until you add one.

```bash
caps catalog sync                 # every linked skill/instruction
caps catalog sync review --dry-run
caps catalog edit review --source ~/.claude/skills/review
```

`sync` re-reads each source and reports it as updated, unchanged or source missing;
updated capabilities mark the profiles using them pending re-apply. A missing source is
only reported — sync never deletes a capability. It exits non-zero only when every
requested capability failed to sync (missing source, or nothing linked).

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

### Backup retention

Each backup is one file in `~/.capsule/backups`. Retention works per source file:
after every new backup, Capsule keeps the newest 20 of that file and deletes the
rest. Set `CAPSULE_BACKUP_KEEP=<n>` to change the limit, or `0`/`off` to turn
automatic pruning off. If automatic pruning fails, Capsule prints a warning and
the write that triggered it still goes through.

```bash
caps backups prune --dry-run              # show what would go, delete nothing
caps backups prune --keep 5 --yes         # keep the newest 5 per file
caps backups prune --older-than 30 --yes  # only delete backups older than 30 days
```

Capsule never prunes the original backups it took when it first adopted a project
(`caps profiles deactivate` restores those). They also don't count towards the
limit. Retention counts each file on its own, so it can delete one half of a
`restore-group` set and keep the other. `prune` lists any group that ends up
split, and `restore-group` then restores only the backups that are left.
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
