import type { Command } from "commander";
import type { ImportCandidate } from "../profileManager";
import type { CliDeps } from "./context";
import { confirmOrAbort, printResult, table } from "./output";

export function registerImportCommands(program: Command, getDeps: () => CliDeps): void {
  const importCommand = program.command("import").description("Import existing configs into the catalog");

  importCommand
    .command("scan")
    .description("Scan global and project configs for importable capabilities")
    .action(async () => {
      const deps = getDeps();
      const candidates = await deps.profiles.scanImport(deps.projectPath);
      printResult(candidates, deps.opts.json, deps.io, () => candidateTable(candidates));
    });

  importCommand
    .command("scan-folder <folder>")
    .description("Scan an arbitrary folder for importable capabilities")
    .option("--no-global", "skip global configs")
    .action(async (folder: string, options: { global: boolean }) => {
      const deps = getDeps();
      const candidates = await deps.profiles.scanFolder(folder, options.global);
      printResult(candidates, deps.opts.json, deps.io, () => candidateTable(candidates));
    });

  importCommand
    .command("commit <candidate-id...>")
    .description("Import scanned candidates into the catalog or a new profile")
    .option("--profile-name <name>", "create a profile with the imported capabilities")
    .option("--catalog-only", "import into the catalog without creating a profile")
    .option("--folder <path>", "rescan this folder instead of global/project configs")
    .action(
      async (
        candidateIds: string[],
        options: { profileName?: string; catalogOnly?: boolean; folder?: string }
      ) => {
        const deps = getDeps();
        if (options.profileName && options.catalogOnly) {
          throw new Error("Use either --profile-name or --catalog-only, not both.");
        }
        // Candidate ids only exist within one ProfileManager instance, so rescan
        // with the same instance before committing.
        const candidates = options.folder
          ? await deps.profiles.scanFolder(options.folder)
          : await deps.profiles.scanImport(deps.projectPath);
        const known = new Set(candidates.map((candidate) => candidate.id));
        const missing = candidateIds.filter((id) => !known.has(id));
        if (missing.length) {
          throw new Error(
            `Unknown candidate id${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Run "caps import scan" to list candidates.`
          );
        }
        await confirmOrAbort(
          `Import ${candidateIds.length} candidate${candidateIds.length === 1 ? "" : "s"} into the catalog?`,
          deps.opts.yes
        );
        if (options.catalogOnly) {
          const capabilities = await deps.profiles.commitCatalogImport(candidateIds);
          printResult(capabilities, deps.opts.json, deps.io, () =>
            `Imported ${capabilities.length} capabilit${capabilities.length === 1 ? "y" : "ies"} into the catalog.\n`
          );
          return;
        }
        const profile = await deps.profiles.commitImport(candidateIds, options.profileName);
        printResult(profile, deps.opts.json, deps.io, () =>
          `Imported ${candidateIds.length} capabilit${candidateIds.length === 1 ? "y" : "ies"} into profile "${profile.name}" (${profile.id}).\n`
        );
      }
    );
}

function candidateTable(candidates: ImportCandidate[]): string {
  return table(
    ["ID", "KIND", "NAME", "SOURCE"],
    candidates.map((candidate) => [candidate.id, candidate.kind, candidate.name, candidate.sourcePath])
  );
}
