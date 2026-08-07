import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Capability,
  Profile,
  ProfileStore,
  ProjectAssignment,
  RuntimeContext
} from "./types";
import { backupFile, ensureDir, pathExists, readJsonFile, writeJsonFileSafe } from "./storage";

const STORE_VERSION = 1 as const;

export function profileStorePath(ctx: RuntimeContext): string {
  return path.join(ctx.appDir, "profiles.json");
}

export function catalogRoot(ctx: RuntimeContext): string {
  return path.join(ctx.appDir, "catalog");
}

export function customPluginsRoot(ctx: RuntimeContext): string {
  return path.join(catalogRoot(ctx), "plugins");
}

export function runtimeRoot(ctx: RuntimeContext): string {
  return path.join(ctx.appDir, "runtime");
}

export async function readProfileStore(ctx: RuntimeContext): Promise<ProfileStore> {
  const now = new Date().toISOString();
  const initial: ProfileStore = {
    version: STORE_VERSION,
    capabilities: {},
    profiles: {
      vanilla: {
        id: "vanilla",
        name: "Vanilla",
        description: "Claude Code with every user customization disabled.",
        capabilityIds: [],
        system: "vanilla",
        createdAt: now,
        updatedAt: now
      },
      personal: {
        id: "personal",
        name: "Personal",
        description: "A clean personal profile.",
        capabilityIds: [],
        createdAt: now,
        updatedAt: now
      }
    },
    assignments: {}
  };
  const store = await readJsonFile<ProfileStore>(profileStorePath(ctx), initial);
  if (store.version !== STORE_VERSION) {
    throw new Error(`Unsupported profile store version: ${String(store.version)}`);
  }
  store.capabilities ??= {};
  store.profiles ??= {};
  store.assignments ??= {};
  if (!store.profiles.vanilla) store.profiles.vanilla = initial.profiles.vanilla;
  if (!store.profiles.personal) store.profiles.personal = initial.profiles.personal;
  deduplicateCapabilities(store);
  return store;
}

export async function writeProfileStore(
  ctx: RuntimeContext,
  store: ProfileStore,
  reason: string
): Promise<void> {
  await ensureDir(ctx.appDir);
  await writeJsonFileSafe(ctx, profileStorePath(ctx), store, reason);
}

export function createId(prefix: string): string {
  return `${slug(prefix)}-${randomUUID()}`;
}

export function assignmentKey(projectPath: string): string {
  return Buffer.from(path.resolve(projectPath)).toString("base64url");
}

export function findAssignment(
  store: ProfileStore,
  projectPath: string
): ProjectAssignment | undefined {
  return store.assignments[assignmentKey(projectPath)];
}

export function listProfiles(store: ProfileStore): Profile[] {
  return Object.values(store.profiles).sort((left, right) => {
    if (left.system && !right.system) return -1;
    if (!left.system && right.system) return 1;
    return left.name.localeCompare(right.name);
  });
}

export function listCapabilities(store: ProfileStore): Capability[] {
  return Object.values(store.capabilities).sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind);
    return kind || left.name.localeCompare(right.name);
  });
}

/**
 * Returns a source-independent identity for a capability. Import paths,
 * descriptions and timestamps are deliberately excluded so copies discovered
 * in different projects collapse into one catalog entry.
 */
export function capabilityFingerprint(item: Capability): string {
  const name = item.name.trim().toLowerCase();
  switch (item.kind) {
    case "mcp":
      return stableStringify({ kind: item.kind, name, config: normalizeMcpConfig(item.config) });
    case "installed-plugin":
      return stableStringify({
        kind: item.kind,
        name,
        pluginId: item.pluginId,
        version: item.version,
        scope: item.scope,
        installPath: path.resolve(item.installPath)
      });
    case "custom-plugin":
      return stableStringify({ kind: item.kind, name, rootPath: path.resolve(item.rootPath) });
    case "skill":
      return stableStringify({
        kind: item.kind,
        name,
        content: normalizeText(item.content),
        files: Object.fromEntries(
          Object.entries(item.files ?? {}).map(([filePath, content]) => [filePath, normalizeText(content)])
        )
      });
    case "hook":
      return stableStringify({
        kind: item.kind,
        event: item.event,
        matcher: item.matcher,
        handlers: item.handlers
      });
    case "instruction":
      return stableStringify({
        kind: item.kind,
        name: normalizeInstructionName(name),
        content: normalizeText(item.content)
      });
  }
}

/** Merges legacy duplicate entries and rewrites profile references in-place. */
export function deduplicateCapabilities(store: ProfileStore): boolean {
  const capabilities = Object.values(store.capabilities).sort(compareCapabilitySurvivors);
  const survivorByFingerprint = new Map<string, Capability>();
  const replacements = new Map<string, string>();

  for (const capability of capabilities) {
    const fingerprint = capabilityFingerprint(capability);
    const survivor = survivorByFingerprint.get(fingerprint);
    if (survivor) replacements.set(capability.id, survivor.id);
    else survivorByFingerprint.set(fingerprint, capability);
  }
  if (!replacements.size) return false;

  for (const duplicateId of replacements.keys()) delete store.capabilities[duplicateId];
  for (const profile of Object.values(store.profiles)) {
    profile.capabilityIds = [
      ...new Set(profile.capabilityIds.map((id) => replacements.get(id) ?? id))
    ];
  }
  return true;
}

function compareCapabilitySurvivors(left: Capability, right: Capability): number {
  const priority = capabilityIdPriority(left.id) - capabilityIdPriority(right.id);
  if (priority) return priority;
  const created = left.createdAt.localeCompare(right.createdAt);
  return created || left.id.localeCompare(right.id);
}

function capabilityIdPriority(id: string): number {
  if (id.startsWith("installed-plugin-")) return 0;
  return id.startsWith("import-") ? 2 : 1;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function normalizeInstructionName(value: string): string {
  const imported = /^(claude(?:\.local)?\.md|agents\.md) \([^)]+\)$/.exec(value);
  return imported?.[1] ?? value;
}

function normalizeMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...config };
  const implicitStdio = typeof normalized.command === "string" && normalized.type === "stdio";
  const implicitHttp = typeof normalized.url === "string" && normalized.type === "http";
  if (implicitStdio || implicitHttp) delete normalized.type;
  return normalized;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)])
  );
}

export async function createCustomPluginWorkspace(
  ctx: RuntimeContext,
  id: string,
  name: string,
  sourcePath?: string
): Promise<string> {
  const root = path.join(customPluginsRoot(ctx), safeSegment(id));
  await ensureDir(root);
  if (sourcePath) {
    const resolvedSource = path.resolve(sourcePath);
    if (!(await pathExists(resolvedSource))) throw new Error("Plugin source no longer exists.");
    await fs.cp(resolvedSource, root, {
      recursive: true,
      errorOnExist: false,
      force: false,
      filter: (source) => !isUnsafePluginSource(source)
    });
  }
  const manifestDir = path.join(root, ".claude-plugin");
  const manifestPath = path.join(manifestDir, "plugin.json");
  if (!(await pathExists(manifestPath))) {
    await ensureDir(manifestDir);
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ name: slug(name), version: "0.1.0", description: "Managed by Capsule" }, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
  return root;
}

export async function listWorkspaceFiles(rootPath: string): Promise<string[]> {
  const root = path.resolve(rootPath);
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        result.push(path.relative(root, fullPath));
      }
    }
  }
  await visit(root);
  return result.sort();
}

export function resolveWorkspaceFile(rootPath: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error("Plugin file path must be relative.");
  }
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Plugin file path escapes its workspace.");
  }
  return resolved;
}

export async function readWorkspaceFile(rootPath: string, relativePath: string): Promise<string> {
  const filePath = resolveWorkspaceFile(rootPath, relativePath);
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Only regular plugin files can be read.");
  const content = await fs.readFile(filePath);
  if (content.includes(0)) throw new Error("Binary plugin files cannot be edited.");
  return content.toString("utf8");
}

export async function writeWorkspaceFile(
  ctx: RuntimeContext,
  rootPath: string,
  relativePath: string,
  content: string
): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > 1024 * 1024) {
    throw new Error("Plugin text files are limited to 1 MB.");
  }
  const filePath = resolveWorkspaceFile(rootPath, relativePath);
  await ensureDir(path.dirname(filePath));
  const parent = await fs.realpath(path.dirname(filePath));
  const root = await fs.realpath(path.resolve(rootPath));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
    throw new Error("Plugin file parent escapes its workspace.");
  }
  await writeJsonOrText(ctx, filePath, content, `edit custom plugin ${relativePath}`);
}

export async function removeWorkspaceFile(
  ctx: RuntimeContext,
  rootPath: string,
  relativePath: string
): Promise<void> {
  const filePath = resolveWorkspaceFile(rootPath, relativePath);
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Only regular plugin files can be removed.");
  const realRoot = await fs.realpath(path.resolve(rootPath));
  const realFile = await fs.realpath(filePath);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("Plugin file escapes its workspace.");
  }
  await backupFile(ctx, filePath, `delete custom plugin ${relativePath}`);
  await fs.rm(filePath);
}

async function writeJsonOrText(
  ctx: RuntimeContext,
  filePath: string,
  content: string,
  reason: string
): Promise<void> {
  const { writeTextFileSafe } = await import("./storage");
  await writeTextFileSafe(ctx, filePath, content, reason);
}

function isUnsafePluginSource(sourcePath: string): boolean {
  const name = path.basename(sourcePath);
  return name === ".git" || name === "node_modules";
}

function safeSegment(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_.-]/g, "-");
  if (!clean || clean === "." || clean === "..") throw new Error("Invalid path segment.");
  return clean;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "item";
}
