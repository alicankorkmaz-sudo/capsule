import type { Command } from "commander";
import type { CliDeps } from "./context";
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
}
