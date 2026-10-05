import type { Command } from "commander";
import type { CliDeps } from "./context";
import { CliExit, confirmOrAbort, printResult } from "./output";
import { formatProfileList, resolveProfile, runLaunch } from "./launchFlow";
import { resolveCapabilityId } from "./resolve";

export function registerProfileCommands(program: Command, getDeps: () => CliDeps): void {
  const profiles = program.command("profiles").description("Manage profiles and apply them to projects");

  profiles
    .command("list")
    .description("List profiles with their capabilities (inherited ones marked with ^)")
    .action(async () => {
      const deps = getDeps();
      const overview = await deps.profiles.getOverview(deps.projectPath);
      printResult(overview.profiles, deps.opts.json, deps.io, () =>
        formatProfileList(overview.profiles, overview.capabilities)
      );
    });

  profiles
    .command("create <name>")
    .description("Create a profile")
    .option("-d, --description <text>", "profile description")
    .option("-c, --capability <id-or-name...>", "capabilities to enable")
    .option("-e, --extends <profile...>", "parent profiles (id or name) to inherit capabilities from")
    .action(
      async (name: string, options: { description?: string; capability?: string[]; extends?: string[] }) => {
        const deps = getDeps();
        const capabilityIds = await resolveCapabilities(deps, options.capability);
        const parents = await resolveProfileIds(deps, options.extends);
        const profile = await deps.profiles.createProfile({
          name,
          description: options.description,
          capabilityIds,
          extends: parents
        });
        printResult(profile, deps.opts.json, deps.io, () => `Created profile "${profile.name}" (${profile.id}).\n`);
      }
    );

  profiles
    .command("edit <profile>")
    .description("Edit a profile (id or name)")
    .option("--name <name>", "rename the profile")
    .option("-d, --description <text>", "profile description")
    .option("-c, --capability <id-or-name...>", "replace the capability set")
    .option("--add <id-or-name...>", "add capabilities")
    .option("--remove <id-or-name...>", "remove capabilities")
    .option("-e, --extends <profile...>", "replace the parent profiles (id or name)")
    .option("--no-extends", "clear the parent profiles")
    .option("--add-extends <profile...>", "add parent profiles")
    .option("--remove-extends <profile...>", "remove parent profiles")
    .action(
      async (
        ref: string,
        options: {
          name?: string;
          description?: string;
          capability?: string[];
          add?: string[];
          remove?: string[];
          /** Variadic list, or false for --no-extends. */
          extends?: string[] | false;
          addExtends?: string[];
          removeExtends?: string[];
        }
      ) => {
        const deps = getDeps();
        if (options.capability && (options.add || options.remove)) {
          throw new Error("Use either --capability or --add/--remove, not both.");
        }
        if (options.extends !== undefined && (options.addExtends || options.removeExtends)) {
          throw new Error("Use either --extends/--no-extends or --add-extends/--remove-extends, not both.");
        }
        const profile = await findProfile(deps, ref);
        let capabilityIds: string[] | undefined;
        if (options.capability) {
          capabilityIds = await resolveCapabilities(deps, options.capability);
        } else if (options.add || options.remove) {
          const additions = (await resolveCapabilities(deps, options.add)) ?? [];
          const removals = new Set((await resolveCapabilities(deps, options.remove)) ?? []);
          capabilityIds = [
            ...profile.capabilityIds.filter((id) => !removals.has(id)),
            ...additions.filter((id) => !profile.capabilityIds.includes(id))
          ];
        }
        let parents: string[] | undefined;
        if (options.extends === false) {
          parents = [];
        } else if (options.extends) {
          parents = await resolveProfileIds(deps, options.extends);
        } else if (options.addExtends || options.removeExtends) {
          const current = profile.extends ?? [];
          const additions = (await resolveProfileIds(deps, options.addExtends)) ?? [];
          // A parent id already listed is accepted verbatim, so a dangling
          // reference in a hand-edited store can still be removed.
          const removals = new Set(
            (await resolveProfileIds(
              deps,
              options.removeExtends?.filter((entry) => !current.includes(entry))
            )) ?? []
          );
          for (const entry of options.removeExtends ?? []) if (current.includes(entry)) removals.add(entry);
          parents = [
            ...current.filter((id) => !removals.has(id)),
            ...additions.filter((id) => !current.includes(id))
          ];
        }
        const updated = await deps.profiles.updateProfile(profile.id, {
          name: options.name,
          description: options.description,
          capabilityIds,
          extends: parents
        });
        printResult(updated, deps.opts.json, deps.io, () => `Updated profile "${updated.name}".\n`);
      }
    );

  profiles
    .command("rm <profile>")
    .description("Delete a profile (id or name)")
    .action(async (ref: string) => {
      const deps = getDeps();
      const profile = await findProfile(deps, ref);
      await confirmOrAbort(`Delete profile "${profile.name}"?`, deps.opts.yes);
      await deps.profiles.deleteProfile(profile.id);
      printResult({ deleted: profile.id }, deps.opts.json, deps.io, () => `Deleted profile "${profile.name}".\n`);
    });

  profiles
    .command("preview <profile>")
    .description("Preview applying a profile to the project")
    .action(async (ref: string) => {
      const deps = getDeps();
      const profile = await findProfile(deps, ref);
      const preview = await deps.profiles.previewApply(profile.id, deps.projectPath);
      printResult(preview, deps.opts.json, deps.io, () => {
        const lines = [
          `Profile: ${preview.profile.name}`,
          `Project: ${preview.projectPath}`,
          `Settings: ${preview.settingsPath}`,
          `Instructions: ${preview.instructionsPath}`,
          `Needs ownership confirmation: ${preview.needsOwnershipConfirmation ? "yes" : "no"}`,
          `Drifted: ${preview.drifted ? "yes" : "no"}`
        ];
        for (const warning of preview.warnings) lines.push(`Warning: ${warning}`);
        return `${lines.join("\n")}\n`;
      });
    });

  profiles
    .command("apply <profile>")
    .description("Apply a profile to the project")
    .option("-f, --force", "overwrite drifted managed files")
    .action(async (ref: string, options: { force?: boolean }) => {
      const deps = getDeps();
      const profile = await findProfile(deps, ref);
      const preview = await deps.profiles.previewApply(profile.id, deps.projectPath);
      if (preview.needsOwnershipConfirmation) {
        await confirmOrAbort(
          "This project already has local Claude configuration. Back it up and let Capsule manage it?",
          deps.opts.yes
        );
      }
      if (preview.drifted && !options.force) {
        await confirmOrAbort(
          "Managed Claude files changed outside Capsule. Overwrite those changes?",
          deps.opts.yes
        );
      }
      const assignment = await deps.profiles.applyProfile(profile.id, deps.projectPath, {
        confirmOwnership: true,
        force: true
      });
      printResult(assignment, deps.opts.json, deps.io, () =>
        `Applied profile "${profile.name}" to ${assignment.projectPath}.\n`
      );
    });

  profiles
    .command("deactivate")
    .description("Deactivate the project's profile and restore original files")
    .action(async () => {
      const deps = getDeps();
      await confirmOrAbort(`Deactivate the profile for ${deps.projectPath}?`, deps.opts.yes);
      await deps.profiles.deactivate(deps.projectPath);
      printResult({ deactivated: deps.projectPath }, deps.opts.json, deps.io, () =>
        `Deactivated profile for ${deps.projectPath}.\n`
      );
    });

  program
    .command("launch")
    .description("Launch Claude Code in the project, applying a profile if one is given or assigned")
    .option("-p, --profile <name>", "profile name or id (default: the project's assigned profile, or none)")
    .option("-f, --force", "overwrite drifted managed files")
    .argument("[claudeArgs...]", "arguments passed to Claude Code (use -- before Claude flags)")
    .action(async (claudeArgs: string[], options: { profile?: string; force?: boolean }) => {
      const deps = getDeps();
      const code = await runLaunch(
        deps.profiles,
        {
          profile: options.profile,
          projectPath: deps.projectPath,
          confirmOwnership: Boolean(deps.opts.yes),
          force: Boolean(options.force),
          claudeArgs
        },
        deps.io
      );
      if (code !== 0) throw new CliExit(code);
    });
}

async function findProfile(deps: CliDeps, ref: string) {
  const overview = await deps.profiles.getOverview(deps.projectPath);
  return resolveProfile(overview.profiles, ref);
}

async function resolveProfileIds(deps: CliDeps, refs?: string[]): Promise<string[] | undefined> {
  if (!refs) return undefined;
  const overview = await deps.profiles.getOverview(deps.projectPath);
  return refs.map((ref) => resolveProfile(overview.profiles, ref).id);
}

async function resolveCapabilities(deps: CliDeps, refs?: string[]): Promise<string[] | undefined> {
  if (!refs) return undefined;
  const ids = [];
  for (const ref of refs) ids.push(await resolveCapabilityId(deps.profiles, ref));
  return ids;
}
