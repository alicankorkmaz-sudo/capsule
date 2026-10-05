import type { Command } from "commander";
import type { CliDeps } from "./context";
import { DEFAULT_BACKUP_KEEP, type PruneBackupsResult } from "../storage";
import { confirmOrAbort, printResult, table } from "./output";

export function registerBackupCommands(program: Command, getDeps: () => CliDeps): void {
  const backups = program.command("backups").description("Manage config backups");

  backups
    .command("list")
    .description("List backups")
    .action(async () => {
      const deps = getDeps();
      const entries = await deps.manager.listBackups();
      printResult(entries, deps.opts.json, deps.io, () =>
        table(
          ["ID", "GROUP", "CREATED", "FILE", "REASON"],
          entries.map((entry) => [
            entry.id,
            entry.groupId ?? "",
            entry.createdAt,
            entry.sourcePath,
            entry.reason
          ])
        )
      );
    });

  backups
    .command("restore <backup-id>")
    .description("Restore a single backup")
    .action(async (backupId: string) => {
      const deps = getDeps();
      await confirmOrAbort(`Restore backup ${backupId}? This overwrites the current file.`, deps.opts.yes);
      await deps.manager.restoreBackup(backupId, deps.opts.elevated);
      printResult({ restored: backupId }, deps.opts.json, deps.io, () => `Restored backup ${backupId}.\n`);
    });

  backups
    .command("restore-group <group-id>")
    .description("Restore every backup in a group")
    .action(async (groupId: string) => {
      const deps = getDeps();
      await confirmOrAbort(`Restore backup group ${groupId}? This overwrites the current files.`, deps.opts.yes);
      await deps.manager.restoreBackupGroup(groupId, deps.opts.elevated);
      printResult({ restored: groupId }, deps.opts.json, deps.io, () => `Restored backup group ${groupId}.\n`);
    });

  backups
    .command("prune")
    .description(
      "Delete old backups, keeping the newest N per source file. " +
        "Original pre-Capsule backups of assigned projects are never deleted."
    )
    .option("--keep <n>", `backups to keep per source file (default ${DEFAULT_BACKUP_KEEP})`)
    .option("--older-than <days>", "only delete backups older than this many days")
    .option("--dry-run", "show what would be deleted without deleting anything")
    .action(async (flags: PruneFlags) => {
      const deps = getDeps();
      const options = {
        keep: flags.keep === undefined ? DEFAULT_BACKUP_KEEP : parseCount(flags.keep, "--keep"),
        olderThanDays: flags.olderThan === undefined ? undefined : parseDays(flags.olderThan)
      };
      let result = await deps.manager.pruneBackups({ ...options, dryRun: true });
      if (!flags.dryRun && result.deletedCount > 0) {
        await confirmOrAbort(
          `Delete ${result.deletedCount} backup(s) (${formatBytes(result.bytesFreed)})? This cannot be undone.`,
          deps.opts.yes
        );
        result = await deps.manager.pruneBackups(options);
      }
      if (!flags.dryRun) result = { ...result, dryRun: false };
      printResult(result, deps.opts.json, deps.io, () => formatPruneResult(result));
    });
}

interface PruneFlags {
  keep?: string;
  olderThan?: string;
  dryRun?: boolean;
}

function parseCount(value: string, flag: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a non-negative whole number.`);
  }
  return parsed;
}

function parseDays(value: string): number {
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--older-than must be a non-negative number of days.");
  }
  return parsed;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatPruneResult(result: PruneBackupsResult): string {
  const scope =
    `keeping ${result.keep} per file` +
    (result.olderThanDays === undefined ? "" : `, only deleting backups older than ${result.olderThanDays} day(s)`);
  const verb = result.dryRun ? "Would delete" : "Deleted";
  const lines = [
    `${verb} ${result.deletedCount} of ${result.scanned} backup(s), ` +
      `${result.dryRun ? "freeing" : "freed"} ${formatBytes(result.bytesFreed)} (${scope}).`,
    `Kept ${result.keptCount}, plus ${result.protectedCount} protected original(s).`
  ];
  const touched = result.sources.filter((source) => source.deleted > 0 || source.protected > 0);
  if (touched.length) {
    lines.push(
      "",
      table(
        ["FILE", "TOTAL", "DELETE", "KEEP", "PROTECTED", "FREED"],
        touched.map((source) => [
          source.sourcePath,
          String(source.total),
          String(source.deleted),
          String(source.kept),
          String(source.protected),
          formatBytes(source.bytesFreed)
        ])
      ).trimEnd()
    );
  }
  if (result.splitGroups.length) {
    lines.push(
      "",
      `${result.splitGroups.length} backup group(s) ${result.dryRun ? "would lose" : "lost"} some but not all ` +
        `members; restore-group restores only the remaining ones: ${result.splitGroups.join(", ")}`
    );
  }
  if (result.unreadable.length) {
    lines.push("", `Skipped ${result.unreadable.length} unreadable backup file(s): ${result.unreadable.join(", ")}`);
  }
  if (result.dryRun) lines.push("", "Dry run: nothing was deleted.");
  return `${lines.join("\n")}\n`;
}
