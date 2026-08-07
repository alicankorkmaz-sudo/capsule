import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectEntry, RuntimeContext, TargetKey, TargetStatus } from "./types";
import { canWritePath, pathExists } from "./storage";

const LEGACY_APP_DIR_NAME = ".mcpmanager";
const APP_DIR_NAME = ".capsule";

export function createRuntimeContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  const homeDir = overrides.homeDir ?? os.homedir();
  return {
    homeDir,
    cwd: overrides.cwd ?? process.cwd(),
    appDir: overrides.appDir ?? path.join(homeDir, APP_DIR_NAME),
    projectsDir:
      overrides.projectsDir ?? process.env.CAPSULE_PROJECTS_DIR ?? path.join(homeDir, "Code")
  };
}

/**
 * One-time move of the pre-rebrand ~/.mcpmanager directory to ~/.capsule.
 * No-op unless the context still points at the default app dir, so tests and
 * callers that supply their own appDir are never migrated into.
 */
export async function migrateLegacyAppDir(ctx: RuntimeContext): Promise<void> {
  const defaultAppDir = path.join(ctx.homeDir, APP_DIR_NAME);
  if (ctx.appDir !== defaultAppDir) return;

  const legacyDir = path.join(ctx.homeDir, LEGACY_APP_DIR_NAME);
  if (!(await pathExists(legacyDir))) return;

  if (await pathExists(defaultAppDir)) {
    process.stderr.write(
      `capsule: both ${legacyDir} and ${defaultAppDir} exist; leaving both untouched. ` +
        `Merge them manually and remove ${legacyDir}.\n`
    );
    return;
  }

  await fs.rename(legacyDir, defaultAppDir);
  process.stderr.write(`capsule: migrated ${legacyDir} to ${defaultAppDir}\n`);
}

export async function listProjects(ctx: RuntimeContext): Promise<ProjectEntry[]> {
  const entries = await fs.readdir(ctx.projectsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(ctx.projectsDir, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function codexConfigPath(ctx: RuntimeContext): string {
  return path.join(ctx.homeDir, ".codex", "config.toml");
}

export function codexProjectConfigPath(projectPath: string): string {
  return path.join(projectPath, ".codex", "config.toml");
}

export function claudeDesktopConfigPath(ctx: RuntimeContext): string {
  if (process.platform === "darwin" || process.env.NODE_ENV === "test") {
    return path.join(
      ctx.homeDir,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  }
  return path.join(ctx.homeDir, ".config", "Claude", "claude_desktop_config.json");
}

export function claudeCodeConfigPath(ctx: RuntimeContext): string {
  return path.join(ctx.homeDir, ".claude.json");
}

export function projectMcpPath(projectPath: string): string {
  return path.join(projectPath, ".mcp.json");
}

export function projectPathOrDefault(ctx: RuntimeContext, projectPath?: string): string {
  return path.resolve(projectPath || ctx.cwd);
}

export function labelForTarget(target: TargetKey): string {
  switch (target) {
    case "codex":
      return "Codex personal";
    case "codex-project":
      return "Codex team";
    case "claude-desktop":
      return "Claude Desktop";
    case "claude-code-user":
      return "Claude Code user";
    case "claude-code-local":
      return "Claude Code personal";
    case "claude-code-project":
      return "Claude Code team";
  }
}

export function scopeForTarget(target: TargetKey): string {
  switch (target) {
    case "codex":
      return "shared";
    case "codex-project":
      return "project";
    case "claude-desktop":
      return "desktop";
    case "claude-code-user":
      return "user";
    case "claude-code-local":
      return "local";
    case "claude-code-project":
      return "project";
  }
}

export async function getTargetStatuses(
  ctx: RuntimeContext,
  projectPath?: string
): Promise<TargetStatus[]> {
  const resolvedProject = projectPathOrDefault(ctx, projectPath);
  const targets: Array<{ key: TargetKey; path: string }> = [
    { key: "codex", path: codexConfigPath(ctx) },
    { key: "codex-project", path: codexProjectConfigPath(resolvedProject) },
    { key: "claude-desktop", path: claudeDesktopConfigPath(ctx) },
    { key: "claude-code-user", path: claudeCodeConfigPath(ctx) },
    { key: "claude-code-local", path: claudeCodeConfigPath(ctx) },
    { key: "claude-code-project", path: projectMcpPath(resolvedProject) }
  ];

  return Promise.all(
    targets.map(async (target) => {
      let error: string | undefined;
      const exists = await pathExists(target.path);
      let writable = false;
      try {
        writable = await canWritePath(target.path);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return {
        key: target.key,
        label: labelForTarget(target.key),
        scope: scopeForTarget(target.key),
        path: target.path,
        exists,
        writable,
        error
      };
    })
  );
}
