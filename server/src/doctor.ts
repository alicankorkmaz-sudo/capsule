import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type {
  Capability,
  HookCapability,
  McpCapability,
  Profile,
  ProfileStore,
  RuntimeContext,
  SkillCapability
} from "./types";
import { effectiveCapabilityIds } from "./profileInheritance";
import { customPluginsRoot, readProfileStore } from "./profileStorage";
import { backupsDir, pathExists } from "./storage";

/**
 * `caps doctor`: a read-only audit of the catalog, profiles and assignments.
 *
 * Severity rule of thumb: `error` means a launch with an affected profile will
 * fail (or a capability in use is gone); `warn` means something is broken but
 * the launch still goes ahead (a hook that fails on every event, a skill that
 * points at files it does not ship); `info` is housekeeping. A broken
 * capability that no profile uses is downgraded one level (error to warn,
 * warn to info), since nothing launches with it.
 */

export type DoctorSeverity = "error" | "warn" | "info";

export interface DoctorIssue {
  severity: DoctorSeverity;
  code: string;
  capabilityId?: string;
  profileId?: string;
  projectPath?: string;
  message: string;
  hint: string;
}

export interface DoctorOptions {
  /** Environment used for PATH lookups. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Override for Claude's installed-plugin inventory file. */
  installedPluginsPath?: string;
}

const SEVERITY_ORDER: Record<DoctorSeverity, number> = { error: 0, warn: 1, info: 2 };

export async function runDoctor(ctx: RuntimeContext, options: DoctorOptions = {}): Promise<DoctorIssue[]> {
  const env = options.env ?? process.env;
  const store = await readProfileStore(ctx);
  const audit = new Audit(ctx, store, env);
  const issues: DoctorIssue[] = [];

  issues.push(...checkReferences(audit));
  issues.push(...(await checkInstalledPlugins(audit, options.installedPluginsPath)));
  issues.push(...(await checkCustomPlugins(audit)));
  issues.push(...(await checkMcpCommands(audit)));
  issues.push(...(await checkAssignments(audit)));
  issues.push(...(await checkHooks(audit)));
  issues.push(...(await checkSkillFiles(audit)));
  issues.push(...(await checkSkillCrossReferences(audit)));
  issues.push(...checkExtends(audit));
  issues.push(...checkUnused(audit));
  issues.push(...(await checkBackups(ctx)));

  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((left, right) => SEVERITY_ORDER[left.issue.severity] - SEVERITY_ORDER[right.issue.severity] || left.index - right.index)
    .map(({ issue }) => issue);
}

/** Shared lookups over one snapshot of the profile store. */
class Audit {
  readonly capabilities: Capability[];
  /** Profiles whose capability lists matter; Vanilla ignores its list. */
  readonly activeProfiles: Profile[];

  constructor(
    readonly ctx: RuntimeContext,
    readonly store: ProfileStore,
    readonly env: Record<string, string | undefined>
  ) {
    this.capabilities = Object.values(store.capabilities);
    this.activeProfiles = Object.values(store.profiles).filter((profile) => profile.system !== "vanilla");
  }

  /** Own plus inherited capabilities; broken `extends` edges are skipped here
   *  and reported by checkExtends. */
  effectiveIds(profile: Profile): string[] {
    return effectiveCapabilityIds(this.store.profiles, profile.id, { strict: false });
  }

  profilesUsing(capabilityId: string): Profile[] {
    return this.activeProfiles.filter((profile) => this.effectiveIds(profile).includes(capabilityId));
  }

  /** Projects assigned directly to one of the given profiles. */
  projectsFor(profiles: Profile[]): Array<{ projectPath: string; profile: Profile }> {
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    return Object.values(this.store.assignments)
      .filter((assignment) => byId.has(assignment.profileId))
      .map((assignment) => ({ projectPath: assignment.projectPath, profile: byId.get(assignment.profileId)! }))
      .sort((left, right) => left.projectPath.localeCompare(right.projectPath));
  }

  /** error when a profile uses the capability, warn when nothing does. */
  severityFor(capabilityId: string): DoctorSeverity {
    return this.profilesUsing(capabilityId).length ? "error" : "warn";
  }

  /** warn when a profile uses the capability, info when nothing does. */
  softSeverityFor(capabilityId: string): DoctorSeverity {
    return this.profilesUsing(capabilityId).length ? "warn" : "info";
  }

  usedByText(capabilityId: string): string {
    const names = this.profilesUsing(capabilityId).map((profile) => profile.name);
    return names.length ? `used by: ${names.join(", ")}` : "not used by any profile";
  }
}

// ---------------------------------------------------------------------------
// Store integrity

function checkExtends(audit: Audit): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  for (const profile of audit.activeProfiles) {
    try {
      effectiveCapabilityIds(audit.store.profiles, profile.id, { strict: true });
    } catch (error) {
      issues.push({
        severity: "error",
        code: "profile-extends-invalid",
        profileId: profile.id,
        message: `Profile "${profile.name}" has a broken extends chain: ${error instanceof Error ? error.message : String(error)}`,
        hint: `caps profiles edit ${shellArg(profile.name)} --remove-extends <profile>`
      });
    }
  }
  return issues;
}

function checkReferences(audit: Audit): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  for (const profile of audit.activeProfiles) {
    const mcpNames = new Map<string, number>();
    for (const capabilityId of profile.capabilityIds) {
      const item = audit.store.capabilities[capabilityId];
      if (!item) {
        issues.push({
          severity: "error",
          code: "profile-capability-missing",
          capabilityId,
          profileId: profile.id,
          message: `Profile "${profile.name}" references capability ${capabilityId}, which is not in the catalog.`,
          hint: `caps profiles edit ${shellArg(profile.name)} --remove ${capabilityId}`
        });
        continue;
      }
      if (item.kind === "mcp") mcpNames.set(item.name, (mcpNames.get(item.name) ?? 0) + 1);
    }
    for (const [name, count] of mcpNames) {
      if (count < 2) continue;
      issues.push({
        severity: "error",
        code: "duplicate-mcp-name",
        profileId: profile.id,
        message: `Profile "${profile.name}" has ${count} MCP servers named "${name}"; launch refuses duplicates.`,
        hint: `caps profiles edit ${shellArg(profile.name)} --remove <id>  (keep one "${name}")`
      });
    }
  }
  for (const assignment of Object.values(audit.store.assignments)) {
    if (audit.store.profiles[assignment.profileId]) continue;
    issues.push({
      severity: "error",
      code: "assignment-profile-missing",
      profileId: assignment.profileId,
      projectPath: assignment.projectPath,
      message: `${assignment.projectPath} is assigned to profile ${assignment.profileId}, which no longer exists.`,
      hint: `caps -C ${shellArg(assignment.projectPath)} profiles deactivate`
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 1. Installed plugins

interface InstalledPluginEntry {
  id: string;
  installPath?: string;
}

export async function readInstalledPluginIds(filePath: string): Promise<InstalledPluginEntry[] | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
  const plugins = isRecord(parsed) && isRecord(parsed.plugins) ? parsed.plugins : undefined;
  if (!plugins) return undefined;
  const result: InstalledPluginEntry[] = [];
  for (const [id, value] of Object.entries(plugins)) {
    // v2 stores a list of installations (one per scope); v1 stored one object.
    const installs = Array.isArray(value) ? value : [value];
    const first = installs.find(isRecord);
    result.push({ id, installPath: typeof first?.installPath === "string" ? first.installPath : undefined });
  }
  return result;
}

async function checkInstalledPlugins(audit: Audit, overridePath?: string): Promise<DoctorIssue[]> {
  const plugins = audit.capabilities.filter((item) => item.kind === "installed-plugin");
  if (!plugins.length) return [];
  const inventoryPath =
    overridePath ?? path.join(audit.ctx.homeDir, ".claude", "plugins", "installed_plugins.json");
  const installed = await readInstalledPluginIds(inventoryPath);
  if (!installed) {
    return [
      {
        severity: "info",
        code: "installed-plugins-unreadable",
        message: `Could not read ${inventoryPath}; skipped the installed-plugin check.`,
        hint: "Run `claude plugin list` to confirm Claude Code's plugin inventory."
      }
    ];
  }
  const installedIds = new Set(installed.map((plugin) => plugin.id));
  const issues: DoctorIssue[] = [];
  for (const item of plugins) {
    if (installedIds.has(item.pluginId)) continue;
    issues.push({
      severity: audit.severityFor(item.id),
      code: "plugin-not-installed",
      capabilityId: item.id,
      message: `Plugin "${item.pluginId}" is no longer installed in Claude Code (${audit.usedByText(item.id)}).`,
      hint: audit.profilesUsing(item.id).length
        ? `claude plugin install ${item.pluginId}, or remove it from its profiles and run caps catalog rm ${item.id}`
        : `caps catalog rm ${item.id}`
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 7. Custom plugins

async function checkCustomPlugins(audit: Audit): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const managedRoot = path.resolve(customPluginsRoot(audit.ctx));
  for (const item of audit.capabilities) {
    if (item.kind !== "custom-plugin") continue;
    const resolved = path.resolve(item.rootPath);
    if (!(await pathExists(resolved))) {
      issues.push({
        severity: audit.severityFor(item.id),
        code: "custom-plugin-missing",
        capabilityId: item.id,
        message: `Custom plugin "${item.name}" points at ${item.rootPath}, which does not exist (${audit.usedByText(item.id)}).`,
        hint: removeHint(audit, item)
      });
    } else if (!resolved.startsWith(`${managedRoot}${path.sep}`)) {
      issues.push({
        severity: audit.severityFor(item.id),
        code: "custom-plugin-unmanaged",
        capabilityId: item.id,
        message: `Custom plugin "${item.name}" lives outside ${managedRoot}; launch refuses it (${audit.usedByText(item.id)}).`,
        hint: `Move it under ${managedRoot}, or ${removeHint(audit, item)}`
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 2. MCP stdio commands

async function checkMcpCommands(audit: Audit): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  for (const item of audit.capabilities) {
    if (item.kind !== "mcp") continue;
    const command = mcpCommand(item);
    if (!command) continue;
    const expanded = expandHome(command, audit.ctx.homeDir);
    if (expanded.includes("$")) continue; // unresolvable variable; don't guess
    let problem: string | undefined;
    if (expanded.includes("/")) {
      const cwd = typeof item.config.cwd === "string" ? expandHome(item.config.cwd, audit.ctx.homeDir) : undefined;
      if (!path.isAbsolute(expanded) && !cwd) continue; // relative to an unknown working directory
      const resolved = path.resolve(cwd ?? "/", expanded);
      if (!(await pathExists(resolved))) problem = `${resolved} does not exist`;
      else if (!(await isExecutable(resolved))) problem = `${resolved} is not executable`;
    } else if (!(await findOnPath(expanded, audit.env))) {
      problem = `"${expanded}" is not on PATH`;
    }
    if (!problem) continue;
    issues.push({
      severity: audit.severityFor(item.id),
      code: "mcp-command-missing",
      capabilityId: item.id,
      message: `MCP server "${item.name}" cannot start: ${problem} (${audit.usedByText(item.id)}).`,
      hint: `Install the command, or fix it with caps catalog edit ${item.id} --config '<json>'`
    });
  }
  return issues;
}

function mcpCommand(item: McpCapability): string | undefined {
  const config = item.config;
  if (typeof config.url === "string" && config.url) return undefined;
  if (config.type && config.type !== "stdio") return undefined;
  return typeof config.command === "string" && config.command.trim() ? config.command.trim() : undefined;
}

// ---------------------------------------------------------------------------
// 3. Assignments

async function checkAssignments(audit: Audit): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const assignments = Object.values(audit.store.assignments).sort((left, right) =>
    left.projectPath.localeCompare(right.projectPath)
  );
  for (const assignment of assignments) {
    const profile = audit.store.profiles[assignment.profileId];
    if (!(await pathExists(assignment.projectPath))) {
      issues.push({
        severity: "warn",
        code: "assignment-path-missing",
        profileId: assignment.profileId,
        projectPath: assignment.projectPath,
        message: `Project ${assignment.projectPath} (profile "${profile?.name ?? assignment.profileId}") no longer exists.`,
        hint: `caps -C ${shellArg(assignment.projectPath)} profiles deactivate --yes`
      });
      continue;
    }
    if (assignment.state === "pending" && profile) {
      issues.push({
        severity: "info",
        code: "assignment-pending",
        profileId: assignment.profileId,
        projectPath: assignment.projectPath,
        message: `Profile "${profile.name}" changed since it was applied to ${assignment.projectPath}.`,
        hint: `caps -C ${shellArg(assignment.projectPath)} profiles apply ${shellArg(profile.name)}  (or just cx there)`
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 4. Hooks

const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "bun",
  "deno",
  "tsx",
  "ts-node",
  "osascript"
]);
const SCRIPT_EXTENSION = /\.(sh|bash|zsh|fish|js|mjs|cjs|ts|mts|py|rb|pl|php|applescript|scpt)$/i;
const PROJECT_DIR_VAR = /\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/;
const PROJECT_DIR_VAR_ALL = new RegExp(PROJECT_DIR_VAR.source, "g");

interface CommandTarget {
  /** The program that runs (interpreter or the script itself). */
  program: string;
  /** Script handed to an interpreter, when there is one. */
  script?: string;
}

/**
 * Pick out what a hook command runs. Only the first simple command is
 * inspected; quoting is honoured but variables are left for the caller.
 */
export function parseHookCommand(command: string): CommandTarget | undefined {
  const words = firstSimpleCommand(command);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
  while (index < words.length && (words[index] === "exec" || words[index] === "env" || words[index] === "command")) index++;
  const program = words[index];
  if (!program) return undefined;
  if (!INTERPRETERS.has(path.basename(program))) return { program };
  let rest = words.slice(index + 1);
  if ((path.basename(program) === "deno" || path.basename(program) === "bun") && rest[0] === "run") rest = rest.slice(1);
  for (const word of rest) {
    if (word === "-c" || word === "-e" || word === "--eval") return { program }; // inline code, no script file
    if (word.startsWith("-")) continue;
    return word.includes("/") || SCRIPT_EXTENSION.test(word) ? { program, script: word } : { program };
  }
  return { program };
}

function firstSimpleCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < command.length) {
      current += command[++i];
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else if (";&|<>()`".includes(char)) {
      break;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

async function checkHooks(audit: Audit): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  for (const item of audit.capabilities) {
    if (item.kind !== "hook") continue;
    const projects = audit.projectsFor(audit.profilesUsing(item.id));
    for (const handler of item.handlers) {
      if (handler.type !== "command" || typeof handler.command !== "string") continue;
      const target = parseHookCommand(handler.command);
      if (!target) continue;
      issues.push(...(await checkHookWord(audit, item, target.program, !target.script, projects)));
      if (target.script) issues.push(...(await checkHookWord(audit, item, target.script, false, projects)));
    }
  }
  return issues;
}

async function checkHookWord(
  audit: Audit,
  item: HookCapability,
  word: string,
  mustBeExecutable: boolean,
  projects: Array<{ projectPath: string; profile: Profile }>
): Promise<DoctorIssue[]> {
  const expanded = expandHome(word, audit.ctx.homeDir);
  const hookLabel = `Hook "${item.name}" (${item.event})`;
  if (!expanded.includes("/")) {
    if (expanded.includes("$") || (await findOnPath(expanded, audit.env))) return [];
    return [
      {
        severity: audit.softSeverityFor(item.id),
        code: "hook-command-missing",
        capabilityId: item.id,
        message: `${hookLabel} runs "${expanded}", which is not on PATH.`,
        hint: `Install ${expanded}, or fix the hook: caps catalog edit ${item.id} --command '<command>'`
      }
    ];
  }

  // Hooks run with the project as working directory, so a relative path and
  // $CLAUDE_PROJECT_DIR both depend on which project the profile launches in.
  const projectRelative = PROJECT_DIR_VAR.test(expanded) || !path.isAbsolute(expanded);
  const candidates = projectRelative
    ? projects.map(({ projectPath, profile }) => ({
        filePath: path.resolve(projectPath, expanded.replace(PROJECT_DIR_VAR_ALL, projectPath)),
        projectPath,
        profile
      }))
    : [{ filePath: expanded, projectPath: undefined, profile: undefined }];

  const issues: DoctorIssue[] = [];
  for (const candidate of candidates) {
    if (candidate.filePath.includes("$")) continue; // some other variable; can't resolve
    const where = candidate.projectPath
      ? ` in ${candidate.projectPath} (profile "${candidate.profile?.name}")`
      : "";
    let problem: string | undefined;
    if (!(await pathExists(candidate.filePath))) problem = `${candidate.filePath} does not exist`;
    else if (mustBeExecutable && !(await isExecutable(candidate.filePath))) problem = `${candidate.filePath} is not executable`;
    if (!problem) continue;
    issues.push({
      severity: candidate.projectPath ? "warn" : audit.softSeverityFor(item.id),
      code: "hook-script-missing",
      capabilityId: item.id,
      profileId: candidate.profile?.id,
      projectPath: candidate.projectPath,
      message: `${hookLabel}: ${problem}${where}.`,
      hint: candidate.projectPath
        ? `Add the script to that project, or caps profiles edit ${shellArg(candidate.profile!.name)} --remove ${item.id}`
        : `Restore the script, or fix the hook: caps catalog edit ${item.id} --command '<command>'`
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 5. Skill sibling files

/**
 * First path segments that point into the user's project rather than into the
 * skill folder. References under these are never treated as skill files.
 */
const PROJECT_DIRS = new Set([
  "docs",
  "doc",
  "src",
  "lib",
  "app",
  "apps",
  "packages",
  "test",
  "tests",
  "spec",
  "specs",
  "dist",
  "build",
  "out",
  "public",
  "node_modules",
  ".scratch",
  ".claude",
  ".codex",
  ".github",
  ".git",
  ".husky",
  ".out-of-scope"
]);

/** Well-known project-root files a skill may mention without shipping them. */
const PROJECT_FILES = new Set(
  [
    "AGENTS.md",
    "CLAUDE.md",
    "CLAUDE.local.md",
    "CONTEXT.md",
    "CONTEXT-MAP.md",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "package.json",
    "SKILL.md"
  ].map((name) => name.toLowerCase())
);

/** Folders skills conventionally ship next to SKILL.md. */
const SKILL_DIRS = new Set(["scripts", "references", "reference", "resources", "assets", "templates", "examples"]);

/**
 * Relative file paths a SKILL.md appears to ship alongside itself.
 *
 * Heuristic (deliberately conservative):
 * - fenced code blocks are ignored;
 * - markdown link targets (`[x](FOO.md)`, `[x](./scripts/a.sh)`) count;
 * - inline code spans count only when the whole span is a path that starts
 *   with `./` or with a conventional skill folder (`scripts/`, `references/`,
 *   `reference/`, `resources/`, `assets/`, `templates/`, `examples/`);
 * - a candidate must be relative, scheme-free, glob/placeholder-free and end in
 *   a file extension (so directories and words like `link` are skipped);
 * - paths whose first segment is a typical project folder (`docs/`, `src/`,
 *   `tests/`, `.claude/`, ...) or that name a well-known project-root file
 *   (`CONTEXT.md`, `AGENTS.md`, `README.md`, `package.json`, ...) are skipped.
 */
export function skillFileReferences(content: string): string[] {
  const text = stripFencedCode(content);
  const found = new Set<string>();
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const candidate = normalizeSkillReference(match[1]);
    if (candidate) found.add(candidate);
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1].trim();
    const firstSegment = span.replace(/^\.\//, "").split("/")[0];
    if (!span.startsWith("./") && !(span.includes("/") && SKILL_DIRS.has(firstSegment))) continue;
    const candidate = normalizeSkillReference(span);
    if (candidate) found.add(candidate);
  }
  return [...found].sort();
}

function normalizeSkillReference(raw: string): string | undefined {
  const target = raw.split("#")[0].split("?")[0].trim();
  if (!target) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined; // scheme: http:, mailto:, ...
  if (/^[/~$#<{]/.test(target) || target.startsWith("..")) return undefined;
  if (/[\s*?<>{}[\]|$@`'"]/.test(target)) return undefined; // globs, placeholders, prose
  const relative = target.replace(/^(\.\/)+/, "");
  if (!relative || relative.endsWith("/")) return undefined;
  const segments = relative.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) return undefined;
  if (!/\.[A-Za-z0-9]{1,10}$/.test(segments[segments.length - 1])) return undefined;
  if (segments.length > 1 && PROJECT_DIRS.has(segments[0])) return undefined;
  if (segments.length === 1 && PROJECT_FILES.has(relative.toLowerCase())) return undefined;
  return relative;
}

function stripFencedCode(content: string): string {
  return content.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, "");
}

async function checkSkillFiles(audit: Audit): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  for (const item of audit.capabilities) {
    if (item.kind !== "skill") continue;
    const shipped = new Set(Object.keys(item.files ?? {}).map((key) => key.replace(/^(\.\/)+/, "")));
    const projects = audit.projectsFor(audit.profilesUsing(item.id));
    const missing: string[] = [];
    for (const reference of skillFileReferences(item.content)) {
      if (shipped.has(reference)) continue;
      // A file that exists in a project the skill is launched in is most
      // likely a project file, not something the skill forgot to ship.
      if (await someExists(projects.map(({ projectPath }) => path.join(projectPath, reference)))) continue;
      missing.push(reference);
    }
    if (!missing.length) continue;
    issues.push({
      severity: audit.softSeverityFor(item.id),
      code: "skill-file-missing",
      capabilityId: item.id,
      message: `Skill "${item.name}" references ${missing.join(", ")}, but its files map does not include ${missing.length === 1 ? "it" : "them"}.`,
      hint: `Re-capture the skill with its files: caps catalog edit ${item.id} --from-dir <skill-dir>, or drop the reference: caps catalog edit ${item.id} --content-file <SKILL.md>`
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 6. Skills invoking other skills

/**
 * Skill names a SKILL.md invokes: `/name`, "the `name` skill", and
 * "use/run/invoke the name skill". Fenced code is ignored.
 */
export function skillInvocations(content: string): string[] {
  const text = stripFencedCode(content);
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s(`"'*[])\/([a-z0-9][a-z0-9-]*)(?![\w/-]|\.\w)/gim)) {
    found.add(match[1].toLowerCase());
  }
  for (const match of text.matchAll(/`\/?([a-z0-9][a-z0-9-]*)`\s+skills?\b/gi)) found.add(match[1].toLowerCase());
  for (const match of text.matchAll(/\b(?:use|run|invoke|load|call)\s+the\s+([a-z0-9][a-z0-9-]*)\s+skill\b/gi)) {
    found.add(match[1].toLowerCase());
  }
  return [...found].sort();
}

async function checkSkillCrossReferences(audit: Audit): Promise<DoctorIssue[]> {
  const skillsByName = new Map<string, SkillCapability>();
  for (const item of audit.capabilities) {
    if (item.kind === "skill") skillsByName.set(item.name.toLowerCase(), item);
  }
  const issues: DoctorIssue[] = [];
  for (const profile of audit.activeProfiles) {
    const members = audit
      .effectiveIds(profile)
      .map((id) => audit.store.capabilities[id])
      .filter((item): item is Capability => Boolean(item));
    const profileSkills = new Set(
      members.filter((item) => item.kind === "skill").map((item) => item.name.toLowerCase())
    );
    const pluginRoots = members.flatMap((item) =>
      item.kind === "installed-plugin" ? [item.installPath] : item.kind === "custom-plugin" ? [item.rootPath] : []
    );
    for (const skill of members) {
      if (skill.kind !== "skill") continue;
      const missing: string[] = [];
      for (const name of skillInvocations(skill.content)) {
        if (name === skill.name.toLowerCase() || !skillsByName.has(name) || profileSkills.has(name)) continue;
        if (await someExists(pluginRoots.map((root) => path.join(root, "skills", name, "SKILL.md")))) continue;
        missing.push(skillsByName.get(name)!.name);
      }
      if (!missing.length) continue;
      issues.push({
        severity: "warn",
        code: "skill-ref-not-in-profile",
        capabilityId: skill.id,
        profileId: profile.id,
        message: `Skill "${skill.name}" in profile "${profile.name}" invokes ${missing.map((name) => `/${name}`).join(", ")}, which ${missing.length === 1 ? "is" : "are"} in the catalog but not in this profile.`,
        hint: `caps profiles edit ${shellArg(profile.name)} --add ${missing.map(shellArg).join(" ")}`
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 8. Housekeeping

function checkUnused(audit: Audit): DoctorIssue[] {
  const used = new Set(audit.activeProfiles.flatMap((profile) => audit.effectiveIds(profile)));
  const unused = audit.capabilities
    .filter((item) => !used.has(item.id))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  if (!unused.length) return [];
  return [
    {
      severity: "info",
      code: "unused-capabilities",
      message: `${unused.length} ${unused.length === 1 ? "capability is" : "capabilities are"} not used by any profile: ${unused.map((item) => `${item.name} (${item.kind})`).join(", ")}.`,
      hint: "Add them to a profile with caps profiles edit <profile> --add <name>, or delete with caps catalog rm <id>"
    }
  ];
}

async function checkBackups(ctx: RuntimeContext): Promise<DoctorIssue[]> {
  const dir = backupsDir(ctx);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  let bytes = 0;
  for (const name of names) {
    try {
      bytes += (await fs.stat(path.join(dir, name))).size;
    } catch {
      // vanished mid-scan
    }
  }
  return [
    {
      severity: "info",
      code: "backups",
      message: `${names.length} backup${names.length === 1 ? "" : "s"} using ${formatBytes(bytes)} in ${dir}.`,
      hint: "Trim with caps backups prune (keeps the newest 20 per file; --dry-run to preview)"
    }
  ];
}

// ---------------------------------------------------------------------------
// Output

export function formatDoctorReport(issues: DoctorIssue[]): string {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;
  const lines: string[] = [];
  const headings: Record<DoctorSeverity, string> = { error: "Errors", warn: "Warnings", info: "Info" };
  for (const severity of ["error", "warn", "info"] as const) {
    const group = issues.filter((issue) => issue.severity === severity);
    if (!group.length) continue;
    lines.push(`${headings[severity]} (${group.length})`);
    for (const issue of group) {
      lines.push(`  [${issue.code}] ${issue.message}`);
      lines.push(`      fix: ${issue.hint}`);
    }
    lines.push("");
  }
  if (!counts.error && !counts.warn) lines.push("No problems found.");
  lines.push(
    `${counts.error} error${counts.error === 1 ? "" : "s"}, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.info} info`
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Helpers

function removeHint(audit: Audit, item: Capability): string {
  const profiles = audit.profilesUsing(item.id);
  const removals = profiles.map((profile) => `caps profiles edit ${shellArg(profile.name)} --remove ${item.id}`);
  return [...removals, `caps catalog rm ${item.id}`].join(" && ");
}

function expandHome(value: string, homeDir: string): string {
  return value
    .replace(/^~(?=\/|$)/, homeDir)
    .replace(/\$\{HOME\}|\$HOME\b/g, homeDir);
}

async function findOnPath(command: string, env: Record<string, string | undefined>): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function someExists(filePaths: string[]): Promise<boolean> {
  for (const filePath of filePaths) {
    if (await pathExists(filePath)) return true;
  }
  return false;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
