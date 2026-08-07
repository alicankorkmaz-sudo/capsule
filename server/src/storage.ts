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
}

export async function restoreBackupGroup(
  ctx: RuntimeContext,
  groupId: string,
  allowElevated = false
): Promise<void> {
  const entries = (await listBackups(ctx)).filter((entry) => entry.groupId === groupId);
  if (!entries.length) throw new Error(`Backup group not found: ${groupId}`);
  for (const entry of entries.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))) {
    await restoreBackup(ctx, entry.id, allowElevated);
  }
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
