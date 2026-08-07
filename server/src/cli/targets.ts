import type { Command } from "commander";
import { getTargetStatuses, listProjects } from "../paths";
import type { CliDeps } from "./context";
import { printResult, table } from "./output";

export function registerTargetCommands(program: Command, getDeps: () => CliDeps): void {
  program
    .command("targets")
    .description("Show target config files and their status")
    .action(async () => {
      const deps = getDeps();
      const statuses = await getTargetStatuses(deps.ctx, deps.projectPath);
      printResult(statuses, deps.opts.json, deps.io, () =>
        table(
          ["KEY", "LABEL", "PATH", "EXISTS", "WRITABLE"],
          statuses.map((status) => [
            status.key,
            status.label,
            status.path,
            status.exists ? "yes" : "no",
            status.writable ? "yes" : "no"
          ])
        )
      );
    });

  program
    .command("projects")
    .description("List projects in the projects directory")
    .action(async () => {
      const deps = getDeps();
      const projects = await listProjects(deps.ctx);
      printResult(projects, deps.opts.json, deps.io, () =>
        projects.length ? `${projects.map((project) => project.path).join("\n")}\n` : "(none)\n"
      );
    });
}
