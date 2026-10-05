import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index";
import type { CliIO } from "../src/cli/output";
import { ProfileManager } from "../src/profileManager";
import {
  autoPruneKeepLimit,
  backupsDir,
  pruneBackups,
  type PruneBackupsResult,
  writeTextFileSafe
} from "../src/storage";
import type { BackupEntry, RuntimeContext } from "../src/types";
import { makeTempEnv } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T12:00:00.000Z");

/** Writes a backup record exactly as backupFile lays it out on disk. */
async function seedBackup(
  ctx: RuntimeContext,
  sourcePath: string,
  createdAt: Date,
  extra: Partial<BackupEntry> = {}
): Promise<string> {
  const iso = createdAt.toISOString();
  const id = `${iso.replace(/[:.]/g, "-")}-${path.basename(sourcePath)}`;
  const entry: BackupEntry = {
    id,
    createdAt: iso,
    sourcePath,
    reason: "test",
    existed: true,
    contentBase64: Buffer.from(`content ${iso}`).toString("base64"),
    ...extra
  };
  await fs.mkdir(backupsDir(ctx), { recursive: true });
  await fs.writeFile(path.join(backupsDir(ctx), `${id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  return id;
}

/** Seeds `count` backups of one file, one day apart, newest first in the returned ids. */
async function seedSeries(
  ctx: RuntimeContext,
  sourcePath: string,
  count: number,
  base: Date = NOW
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(await seedBackup(ctx, sourcePath, new Date(base.getTime() - index * DAY)));
  }
  return ids;
}

async function backupIds(ctx: RuntimeContext): Promise<string[]> {
  const names = await fs.readdir(backupsDir(ctx)).catch(() => [] as string[]);
  return names.map((name) => name.replace(/\.json$/, "")).sort();
}

async function writeProtected(ctx: RuntimeContext, ids: string[]): Promise<void> {
  await fs.mkdir(ctx.appDir, { recursive: true });
  await fs.writeFile(
    path.join(ctx.appDir, "profiles.json"),
    JSON.stringify({
      version: 1,
      capabilities: {},
      profiles: {},
      assignments: {
        a: { projectPath: "/p", profileId: "personal", state: "applied", originalBackupIds: ids, updatedAt: "" }
      }
    })
  );
}

async function cli(argv: string[], ctx: RuntimeContext) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const code = await runCli(argv, { ctx, io });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("backup retention", () => {
  it("keeps the newest n backups per source path", async () => {
    const env = await makeTempEnv();
    // Same basename, different directories: retention must not mix them up.
    const first = path.join(env.root, "one", ".claude", "settings.local.json");
    const second = path.join(env.root, "two", ".claude", "settings.local.json");
    const firstIds = await seedSeries(env.ctx, first, 5);
    const secondIds = await seedSeries(env.ctx, second, 3, new Date(NOW.getTime() - 60 * 1000));

    const result = await pruneBackups(env.ctx, { keep: 2 });

    expect(result.deletedCount).toBe(4);
    expect(result.keptCount).toBe(4);
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(await backupIds(env.ctx)).toEqual([...firstIds.slice(0, 2), ...secondIds.slice(0, 2)].sort());
    expect(result.sources.find((source) => source.sourcePath === first)).toMatchObject({
      total: 5,
      deleted: 3,
      kept: 2
    });
  });

  it("only deletes backups older than --older-than", async () => {
    const env = await makeTempEnv();
    const file = path.join(env.project, "CLAUDE.local.md");
    const ids = await seedSeries(env.ctx, file, 10); // ages 0..9 days

    const result = await pruneBackups(env.ctx, { keep: 1, olderThanDays: 5.5, now: NOW });

    // Beyond keep=1 are ages 1..9; only ages 6..9 are older than 5.5 days.
    expect(result.deleted.map((entry) => entry.id).sort()).toEqual(ids.slice(6).sort());
    expect(await backupIds(env.ctx)).toEqual(ids.slice(0, 6).sort());
  });

  it("deletes nothing on a dry run but reports the plan", async () => {
    const env = await makeTempEnv();
    const file = path.join(env.project, "CLAUDE.local.md");
    await seedSeries(env.ctx, file, 6);
    const before = await backupIds(env.ctx);

    const result = await pruneBackups(env.ctx, { keep: 2, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.deletedCount).toBe(4);
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(await backupIds(env.ctx)).toEqual(before);
  });

  it("never deletes protected originals, and they do not count towards keep", async () => {
    const env = await makeTempEnv();
    const file = path.join(env.project, ".claude", "settings.local.json");
    const ids = await seedSeries(env.ctx, file, 6);
    const oldest = ids[ids.length - 1];
    await writeProtected(env.ctx, [oldest, "missing-id"]);

    const zero = await pruneBackups(env.ctx, { keep: 0, dryRun: true });
    expect(zero.deletedCount).toBe(5);
    expect(zero.deleted.map((entry) => entry.id)).not.toContain(oldest);

    const result = await pruneBackups(env.ctx, { keep: 1 });
    expect(result.protectedCount).toBe(1);
    expect(await backupIds(env.ctx)).toEqual([ids[0], oldest].sort());
  });

  it("refuses to prune when profiles.json cannot be parsed", async () => {
    const env = await makeTempEnv();
    await seedSeries(env.ctx, path.join(env.project, "CLAUDE.local.md"), 3);
    await fs.mkdir(env.ctx.appDir, { recursive: true });
    await fs.writeFile(path.join(env.ctx.appDir, "profiles.json"), "{not json");

    await expect(pruneBackups(env.ctx, { keep: 0 })).rejects.toThrow(/refusing to prune/);
    expect(await backupIds(env.ctx)).toHaveLength(3);
  });

  it("leaves unreadable backup files alone", async () => {
    const env = await makeTempEnv();
    await seedSeries(env.ctx, path.join(env.project, "CLAUDE.local.md"), 3);
    await fs.writeFile(path.join(backupsDir(env.ctx), "garbage.json"), "{oops");

    const result = await pruneBackups(env.ctx, { keep: 1 });

    expect(result.unreadable).toEqual(["garbage.json"]);
    expect(await backupIds(env.ctx)).toContain("garbage");
  });

  it("reports groups that are only partially deleted", async () => {
    const env = await makeTempEnv();
    const settings = path.join(env.project, ".claude", "settings.local.json");
    const instructions = path.join(env.project, "CLAUDE.local.md");
    const old = new Date(NOW.getTime() - 30 * DAY);
    await seedBackup(env.ctx, settings, old, { groupId: "g1" });
    await seedBackup(env.ctx, instructions, old, { groupId: "g1" });
    await seedSeries(env.ctx, settings, 2); // two newer settings backups push g1's out

    const result = await pruneBackups(env.ctx, { keep: 2 });

    expect(result.deletedCount).toBe(1);
    expect(result.splitGroups).toEqual(["g1"]);
  });

  it("auto-prunes a file's backups to the default limit after each write", async () => {
    const env = await makeTempEnv();
    const file = path.join(env.project, "CLAUDE.local.md");
    const other = path.join(env.project, "other", "CLAUDE.local.md");
    const ids = await seedSeries(env.ctx, file, 25);
    const protectedId = ids[ids.length - 1];
    await writeProtected(env.ctx, [protectedId]);
    // Same basename (so same id suffix), offset by an hour so ids don't collide.
    await seedSeries(env.ctx, other, 25, new Date(NOW.getTime() - 60 * 60 * 1000));
    vi.stubEnv("CAPSULE_BACKUP_KEEP", "");

    await writeTextFileSafe(env.ctx, file, "new\n", "test write");

    const remaining = await backupIds(env.ctx);
    // 20 unprotected (the new backup + ids[0..18]) plus the protected one,
    // and the other source path is untouched.
    expect(remaining).toHaveLength(21 + 25);
    expect(remaining).toContain(protectedId);
    expect(remaining).toContain(ids[18]);
    expect(remaining).not.toContain(ids[19]);
  });

  it("honours CAPSULE_BACKUP_KEEP for auto-pruning", async () => {
    const env = await makeTempEnv();
    const file = path.join(env.project, "CLAUDE.local.md");
    await seedSeries(env.ctx, file, 10);
    vi.stubEnv("CAPSULE_BACKUP_KEEP", "3");

    await writeTextFileSafe(env.ctx, file, "new\n", "test write");

    expect(await backupIds(env.ctx)).toHaveLength(3);
  });

  it.each(["0", "off", "OFF"])("disables auto-pruning with CAPSULE_BACKUP_KEEP=%s", async (value) => {
    const env = await makeTempEnv();
    const file = path.join(env.project, "CLAUDE.local.md");
    await seedSeries(env.ctx, file, 25);
    vi.stubEnv("CAPSULE_BACKUP_KEEP", value);

    await writeTextFileSafe(env.ctx, file, "new\n", "test write");

    expect(await backupIds(env.ctx)).toHaveLength(26);
  });

  it("parses the keep limit from the environment", () => {
    expect(autoPruneKeepLimit({})).toBe(20);
    expect(autoPruneKeepLimit({ CAPSULE_BACKUP_KEEP: "5" })).toBe(5);
    expect(autoPruneKeepLimit({ CAPSULE_BACKUP_KEEP: "off" })).toBeUndefined();
    expect(autoPruneKeepLimit({ CAPSULE_BACKUP_KEEP: "0" })).toBeUndefined();
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(autoPruneKeepLimit({ CAPSULE_BACKUP_KEEP: "lots" })).toBe(20);
    expect(warn).toHaveBeenCalled();
  });

  it("never fails the triggering write when auto-pruning fails", async () => {
    const env = await makeTempEnv();
    const file = path.join(env.project, "CLAUDE.local.md");
    await seedSeries(env.ctx, file, 25);
    await fs.mkdir(env.ctx.appDir, { recursive: true });
    await fs.writeFile(path.join(env.ctx.appDir, "profiles.json"), "{not json");
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(writeTextFileSafe(env.ctx, file, "new\n", "test write")).resolves.toBeUndefined();

    expect(await fs.readFile(file, "utf8")).toBe("new\n");
    expect(await backupIds(env.ctx)).toHaveLength(26);
    expect(warn.mock.calls.map((call) => String(call[0])).join("")).toContain("automatic backup pruning failed");
  });

  it("keeps a project's originals through apply and deactivate even with a tiny limit", async () => {
    const env = await makeTempEnv();
    vi.stubEnv("CAPSULE_BACKUP_KEEP", "1");
    const manager = new ProfileManager(env.ctx);
    const instructionsPath = path.join(env.project, "CLAUDE.local.md");
    await fs.writeFile(instructionsPath, "original instructions\n");

    await manager.applyProfile("personal", env.project, { confirmOwnership: true });
    await manager.applyProfile("vanilla", env.project);
    await manager.applyProfile("personal", env.project);

    await manager.deactivate(env.project);
    expect(await fs.readFile(instructionsPath, "utf8")).toBe("original instructions\n");
  });
});

describe("caps backups prune", () => {
  it("prints a dry-run plan as JSON without deleting", async () => {
    const env = await makeTempEnv();
    await seedSeries(env.ctx, path.join(env.project, "CLAUDE.local.md"), 30);

    const result = await cli(["backups", "prune", "--dry-run", "--json"], env.ctx);

    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout) as PruneBackupsResult;
    expect(plan).toMatchObject({ dryRun: true, keep: 20, deletedCount: 10, scanned: 30 });
    expect(await backupIds(env.ctx)).toHaveLength(30);
  });

  it("deletes with --yes and reports counts and bytes freed", async () => {
    const env = await makeTempEnv();
    await seedSeries(env.ctx, path.join(env.project, "CLAUDE.local.md"), 8, new Date());

    const result = await cli(["backups", "prune", "--keep", "3", "--older-than", "5.5", "--yes"], env.ctx);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Deleted 2 of 8 backup\(s\), freed \d+(\.\d)? (B|KB)/);
    expect(await backupIds(env.ctx)).toHaveLength(6); // ages 0..5 days survive, 6 and 7 go
  });

  it("asks for confirmation before deleting", async () => {
    const env = await makeTempEnv();
    await seedSeries(env.ctx, path.join(env.project, "CLAUDE.local.md"), 4);

    const result = await cli(["backups", "prune", "--keep", "1"], env.ctx);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(await backupIds(env.ctx)).toHaveLength(4);
  });

  it("rejects an invalid --keep", async () => {
    const env = await makeTempEnv();
    const result = await cli(["backups", "prune", "--keep", "-1", "--dry-run"], env.ctx);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--keep");
  });
});
