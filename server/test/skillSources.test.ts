import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/index";
import type { CliIO } from "../src/cli/output";
import { SKILL_FILE_MAX_BYTES } from "../src/capabilitySource";
import type { CapabilitySyncResult } from "../src/profileManager";
import { ProfileManager } from "../src/profileManager";
import type { Capability, RuntimeContext, SkillCapability } from "../src/types";
import { makeTempEnv } from "./helpers";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(argv: string[], ctx: RuntimeContext): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const code = await runCli(argv, { ctx, io });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

function json<T>(result: CliResult): T {
  return JSON.parse(result.stdout) as T;
}

/** A skill directory with assets, nested files and everything import must skip. */
async function writeSkillDir(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
  await fs.mkdir(path.join(dir, "references", "deep"), { recursive: true });
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: review\n---\nReview carefully.\n");
  await fs.writeFile(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\necho review\n");
  await fs.writeFile(path.join(dir, "references", "deep", "guide.md"), "# Guide\n");
  await fs.writeFile(path.join(dir, ".DS_Store"), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await fs.writeFile(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]));
  await fs.writeFile(path.join(dir, "huge.txt"), "x".repeat(SKILL_FILE_MAX_BYTES + 1));
}

describe("multi-file skills", () => {
  it("imports every text file of a skill directory and reports skipped ones", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const skillDir = path.join(env.project, ".claude", "skills", "review");
    await writeSkillDir(skillDir);

    const candidates = await manager.scanImport(env.project);
    const candidate = candidates.find((item) => item.kind === "skill" && item.name === "review");
    expect(candidate).toBeDefined();
    expect(candidate!.warnings).toEqual([
      `Skipped ${path.join(skillDir, "huge.txt")}: larger than 512 KiB (513 KiB)`,
      `Skipped ${path.join(skillDir, "logo.png")}: binary file`
    ]);

    const [imported] = (await manager.commitCatalogImport([candidate!.id])) as SkillCapability[];
    expect(imported.content).toContain("Review carefully.");
    expect(imported.files).toEqual({
      "references/deep/guide.md": "# Guide\n",
      "scripts/run.sh": "#!/bin/sh\necho review\n"
    });
    expect(imported.sourcePath).toBe(skillDir);

    // Apply still writes the stored files next to SKILL.md.
    const profile = await manager.createProfile({ name: "Review", capabilityIds: [imported.id] });
    await manager.applyProfile(profile.id, env.project, { confirmOwnership: true });
    const runtime = (await fs.readdir(path.join(env.ctx.appDir, "runtime")))[0];
    const written = path.join(env.ctx.appDir, "runtime", runtime, "profile-skills", "skills", "review");
    expect(await fs.readFile(path.join(written, "references", "deep", "guide.md"), "utf8")).toBe("# Guide\n");
  });

  it("links instructions to their file on import", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    await fs.writeFile(path.join(env.project, "AGENTS.md"), "Be brief.\n");

    const candidates = await manager.scanImport(env.project);
    const candidate = candidates.find((item) => item.kind === "instruction" && item.name === "AGENTS.md");
    const [imported] = await manager.commitCatalogImport([candidate!.id]);
    expect(imported.kind === "instruction" && imported.sourcePath).toBe(path.join(env.project, "AGENTS.md"));
  });

  it("creates and edits a skill from a directory", async () => {
    const env = await makeTempEnv();
    const skillDir = path.join(env.root, "skills", "review");
    await writeSkillDir(skillDir);

    const created = await cli(["catalog", "create", "review", "--kind", "skill", "--from-dir", skillDir, "--json"], env.ctx);
    expect(created.code).toBe(0);
    expect(created.stderr).toContain("logo.png: binary file");
    const skill = json<SkillCapability>(created);
    expect(skill.sourcePath).toBe(skillDir);
    expect(Object.keys(skill.files ?? {}).sort()).toEqual(["references/deep/guide.md", "scripts/run.sh"]);

    const human = await cli(["catalog", "get", "review"], env.ctx);
    expect(human.stdout).toContain("Files (2):");
    expect(human.stdout).toContain("  scripts/run.sh  (");
    expect(human.stdout).not.toContain("echo review");

    const other = path.join(env.root, "skills", "review-v2");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "SKILL.md"), "Review v2.\n");
    await fs.writeFile(path.join(other, "notes.md"), "Notes.\n");
    const edited = await cli(["catalog", "edit", "review", "--from-dir", other, "--json"], env.ctx);
    expect(edited.code).toBe(0);
    const next = json<SkillCapability>(edited);
    expect(next.content).toBe("Review v2.\n");
    expect(next.files).toEqual({ "notes.md": "Notes.\n" });
    expect(next.sourcePath).toBe(other);

    const unlinked = await cli(["catalog", "edit", "review", "--no-source", "--json"], env.ctx);
    expect(json<SkillCapability>(unlinked).sourcePath).toBeUndefined();
    expect(json<SkillCapability>(unlinked).files).toEqual({ "notes.md": "Notes.\n" });

    const relinked = await cli(["catalog", "edit", "review", "--source", skillDir, "--json"], env.ctx);
    expect(json<SkillCapability>(relinked).sourcePath).toBe(skillDir);
    expect(json<SkillCapability>(relinked).content).toBe("Review v2.\n");
  });

  it("rejects --from-dir for non-skills and without SKILL.md", async () => {
    const env = await makeTempEnv();
    const empty = path.join(env.root, "empty");
    await fs.mkdir(empty, { recursive: true });

    const wrongKind = await cli(["catalog", "create", "notes", "--kind", "instruction", "--from-dir", empty], env.ctx);
    expect(wrongKind.code).not.toBe(0);
    expect(wrongKind.stderr).toContain("--from-dir only applies to skills");

    const missing = await cli(["catalog", "create", "notes", "--kind", "skill", "--from-dir", empty], env.ctx);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("No SKILL.md");

    const both = await cli(
      ["catalog", "create", "notes", "--kind", "skill", "--from-dir", empty, "--content", "x"],
      env.ctx
    );
    expect(both.stderr).toContain("Use only one of");
  });

  it("links --content-file as the source unless --no-source is given", async () => {
    const env = await makeTempEnv();
    const file = path.join(env.root, "rules.md");
    await fs.writeFile(file, "Rule one.\n");

    const linked = await cli(["catalog", "create", "rules", "--kind", "instruction", "--content-file", file, "--json"], env.ctx);
    expect(json<Capability & { sourcePath?: string }>(linked).sourcePath).toBe(file);

    const plain = await cli(
      ["catalog", "create", "rules-2", "--kind", "instruction", "--content-file", file, "--no-source", "--json"],
      env.ctx
    );
    expect(json<Capability & { sourcePath?: string }>(plain).sourcePath).toBeUndefined();

    const fromSource = await cli(["catalog", "create", "rules-3", "--kind", "instruction", "--source", file, "--json"], env.ctx);
    expect(fromSource.code).toBe(0);
    expect(json<Capability & { content: string }>(fromSource).content).toBe("Rule one.\n");
  });
});

describe("caps catalog sync", () => {
  it("reports updated, unchanged and missing sources and honours --dry-run", async () => {
    const env = await makeTempEnv();
    const skillDir = path.join(env.root, "skills", "review");
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "Review v1.\n");
    await fs.writeFile(path.join(skillDir, "scripts", "old.sh"), "old\n");
    const notes = path.join(env.root, "notes.md");
    await fs.writeFile(notes, "Notes.\n");
    const gone = path.join(env.root, "gone.md");
    await fs.writeFile(gone, "Gone soon.\n");

    expect((await cli(["catalog", "create", "review", "-k", "skill", "--from-dir", skillDir], env.ctx)).code).toBe(0);
    expect((await cli(["catalog", "create", "notes", "-k", "instruction", "--content-file", notes], env.ctx)).code).toBe(0);
    expect((await cli(["catalog", "create", "gone", "-k", "instruction", "--content-file", gone], env.ctx)).code).toBe(0);
    expect((await cli(["catalog", "create", "inline", "-k", "instruction", "--content", "x"], env.ctx)).code).toBe(0);
    const manager = new ProfileManager(env.ctx);
    const review = (await manager.listCapabilities()).find((item) => item.name === "review")!;
    const profile = await manager.createProfile({ name: "Review", capabilityIds: [review.id] });
    await manager.applyProfile(profile.id, env.project, { confirmOwnership: true });

    await fs.writeFile(path.join(skillDir, "SKILL.md"), "Review v2.\n");
    await fs.rm(path.join(skillDir, "scripts", "old.sh"));
    await fs.writeFile(path.join(skillDir, "scripts", "new.sh"), "new\n");
    await fs.rm(gone);

    const dryRun = await cli(["catalog", "sync", "--dry-run", "--json"], env.ctx);
    expect(dryRun.code).toBe(0);
    const planned = json<CapabilitySyncResult[]>(dryRun);
    // Only linked capabilities are synced by default; "inline" has no source.
    expect(planned.map((item) => [item.name, item.status]).sort()).toEqual([
      ["gone", "missing"],
      ["notes", "unchanged"],
      ["review", "updated"]
    ]);
    expect(planned.find((item) => item.name === "review")!.changes).toEqual(["SKILL.md", "+scripts/new.sh", "-scripts/old.sh"]);
    const untouched = (await manager.getCapability(review.id)) as SkillCapability;
    expect(untouched.content).toBe("Review v1.\n");

    const human = await cli(["catalog", "sync", "--dry-run"], env.ctx);
    expect(human.stdout).toContain("would update");
    expect(human.stdout).toContain("source missing");

    const synced = await cli(["catalog", "sync"], env.ctx);
    expect(synced.code).toBe(0);
    const updated = (await manager.getCapability(review.id)) as SkillCapability;
    expect(updated.content).toBe("Review v2.\n");
    expect(updated.files).toEqual({ "scripts/new.sh": "new\n" });
    // A missing source never removes the capability.
    expect((await manager.listCapabilities()).some((item) => item.name === "gone")).toBe(true);
    // The profile using the synced skill must be re-applied to pick it up.
    const overview = await manager.getOverview(env.project);
    expect(overview.selectedAssignment?.state).toBe("pending");

    const again = await cli(["catalog", "sync", "review", "--json"], env.ctx);
    expect(json<CapabilitySyncResult[]>(again)[0].status).toBe("unchanged");
  });

  it("exits non-zero only when every requested sync fails", async () => {
    const env = await makeTempEnv();
    const gone = path.join(env.root, "gone.md");
    await fs.writeFile(gone, "Gone soon.\n");
    await cli(["catalog", "create", "gone", "-k", "instruction", "--content-file", gone], env.ctx);
    await cli(["catalog", "create", "inline", "-k", "instruction", "--content", "x"], env.ctx);
    await fs.rm(gone);

    const failed = await cli(["catalog", "sync", "gone", "inline", "--json"], env.ctx);
    expect(failed.code).toBe(1);
    expect(json<CapabilitySyncResult[]>(failed).map((item) => item.status)).toEqual(["missing", "unlinked"]);

    const nothing = await makeTempEnv();
    const empty = await cli(["catalog", "sync"], nothing.ctx);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No capabilities have a source link");
  });
});
