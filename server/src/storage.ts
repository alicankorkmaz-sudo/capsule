import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  BackupEntry,
  DisabledEntry,
  DisabledStore,
  RuntimeContext,
  ServerIdentity
} from "./types";
import { disabledStoreKey } from "./identity";

const execFileAsync = promisify(execFile);

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

export async function canWritePath(filePath: string): Promise<boolean> {
  if (await pathExists(filePath)) {
    await fs.access(filePath, fsConstants.W_OK);
    return true;
  }
  await ensureDir(path.dirname(filePath));
  await fs.access(path.dirname(filePath), fsConstants.W_OK);
  return true;
}

export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export async function readJsonFile<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  const text = await readTextIfExists(filePath);
  if (!text || !text.trim()) return fallback;
  return JSON.parse(text) as T;
}

export async function writeJsonFileSafe(
  ctx: RuntimeContext,
  filePath: string,
  value: unknown,
  reason: string,
  allowElevated = false
): Promise<void> {
  await writeTextFileSafe(
    ctx,
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    reason,
    allowElevated
  );
}

export async function writeTextFileSafe(
  ctx: RuntimeContext,
  filePath: string,
  content: string,
  reason: string,
  allowElevated = false
): Promise<void> {
  await backupFile(ctx, filePath, reason);
  try {
    await atomicWriteFile(filePath, content);
  } catch (err) {
    if (!allowElevated || !isPermissionError(err)) {
      throw err;
    }
    await elevatedWriteFile(ctx, filePath, content);
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, content, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function elevatedWriteFile(
  ctx: RuntimeContext,
  filePath: string,
  content: string
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Elevated writes are currently implemented for macOS only.");
  }
  await ensureDir(path.join(ctx.appDir, "tmp"));
  const tempPath = path.join(ctx.appDir, "tmp", `elevated-${Date.now()}-${path.basename(filePath)}`);
  await fs.writeFile(tempPath, content, { mode: 0o600 });
  const command = [
    "/bin/mkdir",
    "-p",
    shQuote(path.dirname(filePath)),
    "&&",
    "/bin/cp",
    shQuote(tempPath),
    shQuote(filePath),
    "&&",
    "/bin/chmod",
    "600",
    shQuote(filePath)
  ].join(" ");
  await execFileAsync("osascript", [
    "-e",
    `do shell script ${appleScriptQuote(command)} with administrator privileges`
  ]);
}

export async function backupFile(
  ctx: RuntimeContext,
  sourcePath: string,
  reason: string,
  groupId?: string
): Promise<BackupEntry> {
  await ensureDir(backupsDir(ctx));
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${slug(path.basename(sourcePath))}`;
  let existed = true;
  let contentBase64: string | undefined;
  try {
    contentBase64 = (await fs.readFile(sourcePath)).toString("base64");
  } catch (err) {
    if (isNotFound(err)) {
      existed = false;
    } else {
      throw err;
    }
  }
  const entry: BackupEntry = { id, groupId, createdAt, sourcePath, reason, existed, contentBase64 };
  await fs.writeFile(backupPath(ctx, id), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  await autoPruneBackups(ctx, sourcePath);
  return entry;
}

export async function listBackups(ctx: RuntimeContext): Promise<BackupEntry[]> {
  await ensureDir(backupsDir(ctx));
  const names = await fs.readdir(backupsDir(ctx));
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => readJsonFile<BackupEntry>(path.join(backupsDir(ctx), name), {} as BackupEntry))
  );
  return entries
    .filter((entry) => Boolean(entry.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** True when the backup record still exists on disk and is readable. */
export async function backupExists(ctx: RuntimeContext, backupId: string): Promise<boolean> {
  const entry = await readJsonFile<BackupEntry>(backupPath(ctx, backupId), {} as BackupEntry);
  return Boolean(entry.id);
}

export async function restoreBackup(
  ctx: RuntimeContext,
  backupId: string,
  allowElevated = false
): Promise<void> {
  const entry = await readJsonFile<BackupEntry>(backupPath(ctx, backupId), {} as BackupEntry);
  if (!entry.id) throw new Error(`Backup not found: ${backupId}`);
  // Restoring writes a fresh backup of the same file, which auto-prunes it;
  // never let that delete the backup being restored mid-operation.
  await withPinnedBackups([backupId], async () => {
    if (!entry.existed) {
      await backupFile(ctx, entry.sourcePath, `pre-restore ${backupId}`);
      await fs.rm(entry.sourcePath, { force: true });
      return;
    }
    if (!entry.contentBase64) throw new Error(`Backup has no content: ${backupId}`);
    await writeTextFileSafe(
      ctx,
      entry.sourcePath,
      Buffer.from(entry.contentBase64, "base64").toString("utf8"),
      `restore ${backupId}`,
      allowElevated
    );
  });
}

export async function restoreBackupGroup(
  ctx: RuntimeContext,
  groupId: string,
  allowElevated = false
): Promise<void> {
  const entries = (await listBackups(ctx)).filter((entry) => entry.groupId === groupId);
  if (!entries.length) throw new Error(`Backup group not found: ${groupId}`);
  await withPinnedBackups(
    entries.map((entry) => entry.id),
    async () => {
      for (const entry of entries.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))) {
        await restoreBackup(ctx, entry.id, allowElevated);
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Backup retention
//
// Every backup is a single self-contained file, `backups/<id>.json`, whose id
// is `<createdAt with ":" and "." replaced by "-">-<slug(basename(sourcePath))>`
// and whose body holds the metadata plus the base64 content. Deleting that one
// file removes the backup entirely.
//
// Retention is evaluated per source path. Protected backups — the pre-Capsule
// originals referenced by an assignment's `originalBackupIds` in profiles.json,
// plus ids pinned in-process while an operation still needs them — are never
// deleted and do not count towards the keep limit.
// ---------------------------------------------------------------------------

export const DEFAULT_BACKUP_KEEP = 20;
export const BACKUP_KEEP_ENV = "CAPSULE_BACKUP_KEEP";

export interface PruneBackupsOptions {
  /** Unprotected backups to keep per source path, newest first. */
  keep?: number;
  /** When set, only backups older than this many days are eligible for deletion. */
  olderThanDays?: number;
  /** Compute the plan without deleting anything. */
  dryRun?: boolean;
  /** Restrict pruning to backups of this one source path. */
  sourcePath?: string;
  /** Reference time for olderThanDays; defaults to now. */
  now?: Date;
}

export interface PrunedBackup {
  id: string;
  groupId?: string;
  createdAt: string;
  sourcePath: string;
  bytes: number;
}

export interface PruneSourceSummary {
  sourcePath: string;
  total: number;
  deleted: number;
  kept: number;
  protected: number;
  bytesFreed: number;
}

export interface PruneBackupsResult {
  dryRun: boolean;
  keep: number;
  olderThanDays?: number;
  scanned: number;
  deletedCount: number;
  keptCount: number;
  protectedCount: number;
  bytesFreed: number;
  deleted: PrunedBackup[];
  sources: PruneSourceSummary[];
  /** Groups that lost some members but not all; restore-group then restores only the survivors. */
  splitGroups: string[];
  /** Backup files that could not be parsed; they are left untouched. */
  unreadable: string[];
}

interface ScannedBackup extends PrunedBackup {
  fileName: string;
}

const pinnedBackupIds = new Map<string, number>();

/**
 * Shields backup ids from pruning while `run` executes — for backups an
 * in-flight operation still needs but that are not (yet) in profiles.json.
 */
export async function withPinnedBackups<T>(ids: string[], run: () => Promise<T>): Promise<T> {
  for (const id of ids) pinnedBackupIds.set(id, (pinnedBackupIds.get(id) ?? 0) + 1);
  try {
    return await run();
  } finally {
    for (const id of ids) {
      const count = (pinnedBackupIds.get(id) ?? 1) - 1;
      if (count > 0) pinnedBackupIds.set(id, count);
      else pinnedBackupIds.delete(id);
    }
  }
}

/** Ids referenced by any assignment's originalBackupIds, plus pinned ids. */
export async function protectedBackupIds(ctx: RuntimeContext): Promise<Set<string>> {
  const ids = new Set<string>(pinnedBackupIds.keys());
  // Read profiles.json raw: retention must not depend on the profile store's
  // own normalisation, and a store that cannot be parsed must abort pruning
  // rather than be treated as "nothing is protected".
  const text = await readTextIfExists(path.join(ctx.appDir, "profiles.json"));
  if (!text || !text.trim()) return ids;
  let store: { assignments?: Record<string, { originalBackupIds?: unknown } | null> };
  try {
    store = JSON.parse(text) as typeof store;
  } catch (err) {
    throw new Error(
      `cannot read protected backup ids from profiles.json ` +
        `(${err instanceof Error ? err.message : String(err)}); refusing to prune`
    );
  }
  for (const assignment of Object.values(store.assignments ?? {})) {
    const list = assignment?.originalBackupIds;
    if (!Array.isArray(list)) continue;
    for (const id of list) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * The automatic per-write keep limit from CAPSULE_BACKUP_KEEP. Unset means the
 * default; `0` or `off` disables auto-pruning (returns undefined).
 */
export function autoPruneKeepLimit(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[BACKUP_KEEP_ENV]?.trim();
  if (!raw) return DEFAULT_BACKUP_KEEP;
  if (raw.toLowerCase() === "off" || /^0+$/.test(raw)) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  process.stderr.write(
    `capsule: ignoring invalid ${BACKUP_KEEP_ENV}=${JSON.stringify(raw)} ` +
      `(expected a non-negative integer or "off"); keeping ${DEFAULT_BACKUP_KEEP} backups per file\n`
  );
  return DEFAULT_BACKUP_KEEP;
}

async function autoPruneBackups(ctx: RuntimeContext, sourcePath: string): Promise<void> {
  try {
    const keep = autoPruneKeepLimit();
    if (keep === undefined) return;
    await pruneBackups(ctx, { keep, sourcePath });
  } catch (err) {
    // Retention is housekeeping: it must never fail the write that triggered it.
    process.stderr.write(
      `capsule: warning: automatic backup pruning failed for ${sourcePath}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

/**
 * Deletes old backups, per source path: the newest `keep` unprotected backups
 * of each file survive, and with `olderThanDays` only backups older than that
 * are eligible. Protected backups are never deleted and never counted.
 */
export async function pruneBackups(
  ctx: RuntimeContext,
  options: PruneBackupsOptions = {}
): Promise<PruneBackupsResult> {
  const keep = options.keep ?? DEFAULT_BACKUP_KEEP;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(`keep must be a non-negative integer, got ${String(options.keep)}`);
  }
  const { olderThanDays } = options;
  if (olderThanDays !== undefined && (!Number.isFinite(olderThanDays) || olderThanDays < 0)) {
    throw new Error(`older-than must be a non-negative number of days, got ${String(olderThanDays)}`);
  }
  const dryRun = Boolean(options.dryRun);
  const cutoff =
    olderThanDays === undefined
      ? undefined
      : (options.now ?? new Date()).getTime() - olderThanDays * 24 * 60 * 60 * 1000;

  const protectedIds = await protectedBackupIds(ctx);
  const { backups, unreadable } = await scanBackups(ctx, options.sourcePath);

  const bySource = new Map<string, ScannedBackup[]>();
  for (const backup of backups) {
    const list = bySource.get(backup.sourcePath) ?? [];
    list.push(backup);
    bySource.set(backup.sourcePath, list);
  }

  const deleted: ScannedBackup[] = [];
  const sources: PruneSourceSummary[] = [];
  for (const [sourcePath, list] of bySource) {
    list.sort(newestFirst);
    const summary: PruneSourceSummary = {
      sourcePath,
      total: list.length,
      deleted: 0,
      kept: 0,
      protected: 0,
      bytesFreed: 0
    };
    let unprotectedSeen = 0;
    for (const backup of list) {
      if (protectedIds.has(backup.id)) {
        summary.protected += 1;
        continue;
      }
      unprotectedSeen += 1;
      const beyondKeep = unprotectedSeen > keep;
      const oldEnough = cutoff === undefined || Date.parse(backup.createdAt) < cutoff;
      if (beyondKeep && oldEnough) {
        deleted.push(backup);
        summary.deleted += 1;
        summary.bytesFreed += backup.bytes;
      } else {
        summary.kept += 1;
      }
    }
    sources.push(summary);
  }

  if (!dryRun) {
    for (const backup of deleted) {
      await fs.rm(path.join(backupsDir(ctx), backup.fileName), { force: true });
    }
  }

  const deletedFiles = new Set(deleted.map((backup) => backup.fileName));
  const touchedGroups = new Set(
    deleted.map((backup) => backup.groupId).filter((groupId): groupId is string => Boolean(groupId))
  );
  const splitGroups = [...touchedGroups]
    .filter((groupId) =>
      backups.some((backup) => backup.groupId === groupId && !deletedFiles.has(backup.fileName))
    )
    .sort();

  sources.sort(
    (left, right) => right.deleted - left.deleted || left.sourcePath.localeCompare(right.sourcePath)
  );
  const protectedCount = sources.reduce((sum, source) => sum + source.protected, 0);
  return {
    dryRun,
    keep,
    olderThanDays,
    scanned: backups.length,
    deletedCount: deleted.length,
    keptCount: backups.length - deleted.length - protectedCount,
    protectedCount,
    bytesFreed: deleted.reduce((sum, backup) => sum + backup.bytes, 0),
    deleted: deleted.map(({ fileName: _fileName, ...rest }) => rest),
    sources,
    splitGroups,
    unreadable
  };
}

async function scanBackups(
  ctx: RuntimeContext,
  sourcePath?: string
): Promise<{ backups: ScannedBackup[]; unreadable: string[] }> {
  let names: string[];
  try {
    names = await fs.readdir(backupsDir(ctx));
  } catch (err) {
    if (isNotFound(err)) return { backups: [], unreadable: [] };
    throw err;
  }
  // Ids end with the slugged basename, so pruning one source path only needs
  // to open the files sharing that suffix, not the whole directory.
  const suffix = sourcePath ? `-${slug(path.basename(sourcePath))}.json` : ".json";
  const backups: ScannedBackup[] = [];
  const unreadable: string[] = [];
  for (const fileName of names.filter((name) => name.endsWith(suffix))) {
    let entry: Partial<BackupEntry>;
    let bytes: number;
    try {
      const text = await fs.readFile(path.join(backupsDir(ctx), fileName), "utf8");
      bytes = Buffer.byteLength(text);
      entry = JSON.parse(text) as Partial<BackupEntry>;
    } catch (err) {
      if (isNotFound(err)) continue; // removed concurrently
      unreadable.push(fileName);
      continue;
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.id !== "string" ||
      typeof entry.sourcePath !== "string" ||
      typeof entry.createdAt !== "string" ||
      Number.isNaN(Date.parse(entry.createdAt))
    ) {
      unreadable.push(fileName);
      continue;
    }
    if (sourcePath && entry.sourcePath !== sourcePath) continue;
    backups.push({
      fileName,
      id: entry.id,
      groupId: typeof entry.groupId === "string" ? entry.groupId : undefined,
      createdAt: entry.createdAt,
      sourcePath: entry.sourcePath,
      bytes
    });
  }
  return { backups, unreadable };
}

function newestFirst(left: ScannedBackup, right: ScannedBackup): number {
  const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (byTime) return byTime;
  return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
}

export async function readDisabledStore(ctx: RuntimeContext): Promise<DisabledStore> {
  return readJsonFile<DisabledStore>(disabledStorePath(ctx), { version: 1, entries: {} });
}

export async function writeDisabledStore(
  ctx: RuntimeContext,
  store: DisabledStore
): Promise<void> {
  await ensureDir(ctx.appDir);
  await fs.writeFile(disabledStorePath(ctx), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export async function addDisabledEntry(
  ctx: RuntimeContext,
  entry: DisabledEntry
): Promise<void> {
  const store = await readDisabledStore(ctx);
  store.entries[disabledStoreKey(entry)] = entry;
  await writeDisabledStore(ctx, store);
}

export async function removeDisabledEntry(
  ctx: RuntimeContext,
  identity: ServerIdentity
): Promise<DisabledEntry | undefined> {
  const store = await readDisabledStore(ctx);
  const key = disabledStoreKey(identity);
  const entry = store.entries[key];
  delete store.entries[key];
  await writeDisabledStore(ctx, store);
  return entry;
}

export async function removeDisabledEntryById(
  ctx: RuntimeContext,
  id: string
): Promise<DisabledEntry | undefined> {
  const store = await readDisabledStore(ctx);
  const entry = store.entries[id];
  delete store.entries[id];
  await writeDisabledStore(ctx, store);
  return entry;
}

export function backupsDir(ctx: RuntimeContext): string {
  return path.join(ctx.appDir, "backups");
}

function backupPath(ctx: RuntimeContext, backupId: string): string {
  return path.join(backupsDir(ctx), `${backupId}.json`);
}

function disabledStorePath(ctx: RuntimeContext): string {
  return path.join(ctx.appDir, "disabled.json");
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function isPermissionError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "EACCES" || err.code === "EPERM")
  );
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "config";
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
