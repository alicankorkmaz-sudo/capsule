import type { Command } from "commander";
import { formatDoctorReport, runDoctor } from "../doctor";
import type { CliDeps } from "./context";
import { CliExit, printResult } from "./output";

export function registerDoctorCommands(program: Command, getDeps: () => CliDeps): void {
  program
    .command("doctor")
    .description("Audit the catalog, profiles and assignments for broken references (read-only)")
    .action(async () => {
      const deps = getDeps();
      const issues = await runDoctor(deps.ctx);
      printResult(issues, deps.opts.json, deps.io, () => formatDoctorReport(issues));
      if (issues.some((issue) => issue.severity === "error")) throw new CliExit(1);
    });
}
