import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src";
import { runCli } from "../src/cli/index";
import type { CliIO } from "../src/cli/output";
import { ProfileManager } from "../src/profileManager";
import { profileStorePath } from "../src/profileStorage";
import type { Profile, ProfileStore, ProfileSummary, RuntimeContext } from "../src/types";
import { makeTempEnv, readJson } from "./helpers";

async function hook(manager: ProfileManager, name: string, command: string) {
  return manager.createCapability({
    kind: "hook",
    name,
    event: "PostToolUse",
    handlers: [{ type: "command", command }]
  });
}

async function instruction(manager: ProfileManager, name: string) {
  return manager.createCapability({ kind: "instruction", name, content: `${name} content.` });
}

async function editStore(ctx: RuntimeContext, mutate: (store: ProfileStore) => void): Promise<void> {
  const store = await readJson<ProfileStore>(profileStorePath(ctx));
  mutate(store);
  await fs.writeFile(profileStorePath(ctx), `${JSON.stringify(store, null, 2)}\n`);
}

describe("profile inheritance", () => {
  it("puts parents' capabilities first, depth-first in order, and de-duplicates", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const ids: string[] = [];
    for (const name of ["a", "b", "c", "d", "e"]) ids.push((await instruction(manager, name)).id);
    const [a, b, c, d, e] = ids;

    const base1 = await manager.createProfile({ name: "Base1", capabilityIds: [a, b] });
    const base2 = await manager.createProfile({ name: "Base2", capabilityIds: [b, c] });
    const mid = await manager.createProfile({ name: "Mid", capabilityIds: [d], extends: [base1.id] });
    // Diamond: Base1 reaches Child through Mid and directly; it counts once.
    const child = await manager.createProfile({
      name: "Child",
      capabilityIds: [c, e, a],
      extends: [mid.id, base2.id, base1.id]
    });

    expect(child.extends).toEqual([mid.id, base2.id, base1.id]);
    expect(child.capabilityIds).toEqual([c, e, a]);

    const expected = [a, b, d, c, e];
    const summary = (await manager.getOverview()).profiles.find((profile) => profile.id === child.id)!;
    expect(summary.effectiveCapabilityIds).toEqual(expected);
    const compiled = await manager.compileProfile(child.id, env.project);
    expect(compiled.effectiveCapabilityIds).toEqual(expected);
    expect(compiled.instructions.indexOf("## a")).toBeLessThan(compiled.instructions.indexOf("## e"));

    // Profiles without parents report an empty extends list.
    expect(summary.extends).toEqual([mid.id, base2.id, base1.id]);
    const personal = (await manager.getOverview()).profiles.find((profile) => profile.id === "personal")!;
    expect(personal.extends).toEqual([]);
    expect(personal.effectiveCapabilityIds).toEqual([]);
  });

  it("applies inherited hooks and writes inherited skills into the runtime plugin", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const logA = await hook(manager, "log-a", "log a");
    const logB = await hook(manager, "log-b", "log b");
    const skill = await manager.createCapability({
      kind: "skill",
      name: "shared-skill",
      content: "---\nname: shared-skill\ndescription: Shared\n---\nShared body.\n"
    });
    const shared = await manager.createProfile({ name: "Shared", capabilityIds: [logA.id, logB.id, skill.id] });
    const own = await instruction(manager, "own");
    const work = await manager.createProfile({ name: "Work", capabilityIds: [own.id], extends: [shared.id] });

    await manager.applyProfile(work.id, env.project, { confirmOwnership: true });

    const settings = await readJson<{ hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }>(
      path.join(env.project, ".claude", "settings.local.json")
    );
    expect(settings.hooks.PostToolUse.map((group) => group.hooks[0].command)).toEqual(["log a", "log b"]);
    const runtimeDirs = await fs.readdir(path.join(env.ctx.appDir, "runtime"));
    const skillPath = path.join(
      env.ctx.appDir,
      "runtime",
      runtimeDirs[0],
      "profile-skills",
      "skills",
      "shared-skill",
      "SKILL.md"
    );
    expect(await fs.readFile(skillPath, "utf8")).toContain("Shared body.");
  });

  it("rejects cycles and self-references at edit time", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const a = await manager.createProfile({ name: "A" });
    const b = await manager.createProfile({ name: "B", extends: [a.id] });
    const c = await manager.createProfile({ name: "C", extends: [b.id] });

    await expect(manager.updateProfile(a.id, { extends: [c.id] })).rejects.toThrow(
      "Profile inheritance cycle: A -> C -> B -> A"
    );
    await expect(manager.updateProfile(a.id, { extends: [a.id] })).rejects.toThrow("cannot extend itself");
    // Nothing was written.
    expect((await manager.getOverview()).profiles.find((profile) => profile.id === a.id)!.extends).toEqual([]);
  });

  it("rejects a cycle found in a hand-edited store at compile time but still lists it", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const own = await instruction(manager, "own");
    const a = await manager.createProfile({ name: "A", capabilityIds: [own.id] });
    const b = await manager.createProfile({ name: "B", extends: [a.id] });
    await editStore(env.ctx, (store) => {
      store.profiles[a.id].extends = [b.id];
    });

    await expect(manager.compileProfile(b.id, env.project)).rejects.toThrow("Profile inheritance cycle");
    await expect(manager.applyProfile(b.id, env.project, { confirmOwnership: true })).rejects.toThrow(
      "Profile inheritance cycle"
    );
    const listed = (await manager.getOverview()).profiles.find((profile) => profile.id === b.id)!;
    expect(listed.effectiveCapabilityIds).toEqual([own.id]);
  });

  it("rejects missing parents at edit time and at compile time", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    await expect(manager.createProfile({ name: "Orphan", extends: ["nope"] })).rejects.toThrow(
      "Unknown parent profile: nope"
    );

    const child = await manager.createProfile({ name: "Child", extends: ["personal"] });
    await editStore(env.ctx, (store) => {
      store.profiles[child.id].extends = ["gone"];
    });
    await expect(manager.compileProfile(child.id, env.project)).rejects.toThrow(
      'Profile "Child" extends a missing profile: gone'
    );
  });

  it("keeps Vanilla out of inheritance", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    await expect(manager.createProfile({ name: "Safe", extends: ["vanilla"] })).rejects.toThrow(
      "The Vanilla system profile cannot be extended."
    );
    await expect(manager.updateProfile("vanilla", { extends: ["personal"] })).rejects.toThrow(
      "cannot be edited"
    );

    // A hand-written extends on Vanilla is dropped on load: Vanilla stays empty.
    await manager.createProfile({ name: "Persist store" });
    await editStore(env.ctx, (store) => {
      store.profiles.vanilla.extends = ["personal"];
    });
    const vanilla = (await manager.getOverview()).profiles.find((profile) => profile.id === "vanilla")!;
    expect(vanilla.extends).toEqual([]);
    expect(vanilla.effectiveCapabilityIds).toEqual([]);
  });

  it("refuses to delete a profile that others extend", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const base = await manager.createProfile({ name: "Base" });
    const child = await manager.createProfile({ name: "Child", extends: [base.id] });

    await expect(manager.deleteProfile(base.id)).rejects.toThrow('Profile "Base" is extended by "Child"');
    await manager.updateProfile(child.id, { extends: [] });
    await manager.deleteProfile(base.id);
    const remaining = (await manager.getOverview()).profiles.map((profile) => profile.name);
    expect(remaining).not.toContain("Base");
    // Clearing extends removes the field rather than storing an empty list.
    const stored = await readJson<ProfileStore>(profileStorePath(env.ctx));
    expect("extends" in stored.profiles[child.id]).toBe(false);
  });

  it("marks children pending and changes the applied hash when a parent changes", async () => {
    const env = await makeTempEnv();
    const manager = new ProfileManager(env.ctx);
    const logA = await hook(manager, "log-a", "log a");
    const logB = await hook(manager, "log-b", "log b");
    const base = await manager.createProfile({ name: "Base", capabilityIds: [logA.id] });
    const child = await manager.createProfile({ name: "Child", extends: [base.id] });
    const grandchild = await manager.createProfile({ name: "Grandchild", extends: [child.id] });
    const otherProject = path.join(env.root, "other");
    await fs.mkdir(otherProject);

    const first = await manager.applyProfile(child.id, env.project, { confirmOwnership: true });
    await manager.applyProfile(grandchild.id, otherProject, { confirmOwnership: true });
    const states = async () =>
      Object.fromEntries((await manager.getOverview()).assignments.map((item) => [item.profileId, item.state]));
    expect(await states()).toEqual({ [child.id]: "applied", [grandchild.id]: "applied" });

    // Editing the parent's capability list.
    await manager.updateProfile(base.id, { capabilityIds: [logA.id, logB.id] });
    expect(await states()).toEqual({ [child.id]: "pending", [grandchild.id]: "pending" });

    const second = await manager.applyProfile(child.id, env.project);
    expect(second.appliedHash).not.toBe(first.appliedHash);
    const settings = await readJson<{ hooks: Record<string, unknown[]> }>(
      path.join(env.project, ".claude", "settings.local.json")
    );
    expect(settings.hooks.PostToolUse).toHaveLength(2);

    // Editing a capability the child only inherits.
    await manager.updateCapability(logB.id, { handlers: [{ type: "command", command: "log b v2" }] });
    expect((await states())[child.id]).toBe("pending");
    const third = await manager.applyProfile(child.id, env.project);
    expect(third.appliedHash).not.toBe(second.appliedHash);

    // A description-only edit doesn't change what apply writes.
    await manager.updateCapability(logB.id, { description: "renamed in the catalog only" });
    expect((await states())[child.id]).toBe("applied");
  });

  it("loads a store written before inheritance existed without changing it", async () => {
    const env = await makeTempEnv();
    const legacy: ProfileStore = {
      version: 1,
      capabilities: {},
      profiles: {
        vanilla: {
          id: "vanilla",
          name: "Vanilla",
          capabilityIds: [],
          system: "vanilla",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        personal: {
          id: "personal",
          name: "Personal",
          capabilityIds: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      },
      assignments: {}
    };
    await fs.mkdir(env.ctx.appDir, { recursive: true });
    await fs.writeFile(profileStorePath(env.ctx), JSON.stringify(legacy));
    const manager = new ProfileManager(env.ctx);

    const profiles = (await manager.getOverview()).profiles;
    expect(profiles.map((profile) => profile.extends)).toEqual([[], []]);
    await manager.createProfile({ name: "New" });
    const stored = await readJson<ProfileStore>(profileStorePath(env.ctx));
    expect(stored.version).toBe(1);
    expect(stored.profiles.personal).toEqual(legacy.profiles.personal);
    expect(Object.values(stored.profiles).some((profile) => "extends" in profile)).toBe(false);
  });
});

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

describe("caps profiles --extends", () => {
  it("creates, edits, lists, and guards inherited profiles", async () => {
    const env = await makeTempEnv();
    for (const name of ["log-a", "log-b", "own"]) {
      const created = await cli(["catalog", "create", name, "--kind", "instruction", "--content", name], env.ctx);
      expect(created.code).toBe(0);
    }
    expect((await cli(["profiles", "create", "Logging", "-c", "log-a", "log-b"], env.ctx)).code).toBe(0);
    expect((await cli(["profiles", "create", "Extra"], env.ctx)).code).toBe(0);

    // Parents accept a name (any case) or an id.
    const created = await cli(
      ["profiles", "create", "Work", "--capability", "own", "--extends", "logging", "--json"],
      env.ctx
    );
    expect(created.code).toBe(0);
    const work = json<Profile>(created);
    const listJson = async () => json<ProfileSummary[]>(await cli(["profiles", "list", "--json"], env.ctx));
    const byName = async (name: string) => (await listJson()).find((profile) => profile.name === name)!;
    const logging = await byName("Logging");
    const extra = await byName("Extra");
    expect(work.extends).toEqual([logging.id]);

    const listedWork = await byName("Work");
    expect(listedWork.extends).toEqual([logging.id]);
    expect(listedWork.effectiveCapabilityIds).toEqual([...logging.capabilityIds, ...work.capabilityIds]);

    const human = await cli(["profiles", "list"], env.ctx);
    expect(human.stdout).toContain("Extends: Logging");
    expect(human.stdout).toContain("Enabled capabilities (3, 2 inherited):");
    expect(human.stdout).toContain("^ log-a [Instruction] (from Logging)");
    expect(human.stdout).toContain("- own [Instruction]");

    // --add-extends / --remove-extends edit the list in place.
    expect((await cli(["profiles", "edit", "Work", "--add-extends", extra.id], env.ctx)).code).toBe(0);
    expect((await byName("Work")).extends).toEqual([logging.id, extra.id]);
    expect((await cli(["profiles", "edit", "Work", "--remove-extends", "Logging"], env.ctx)).code).toBe(0);
    expect((await byName("Work")).extends).toEqual([extra.id]);

    // --extends replaces, --no-extends clears.
    expect((await cli(["profiles", "edit", "Work", "--extends", "Logging", "Extra"], env.ctx)).code).toBe(0);
    expect((await byName("Work")).extends).toEqual([logging.id, extra.id]);
    expect((await cli(["profiles", "edit", "Work", "--no-extends"], env.ctx)).code).toBe(0);
    expect((await byName("Work")).extends).toEqual([]);
    expect((await cli(["profiles", "edit", "Work", "-e", "Logging"], env.ctx)).code).toBe(0);

    const conflicting = await cli(["profiles", "edit", "Work", "--extends", "Extra", "--add-extends", "Extra"], env.ctx);
    expect(conflicting.code).toBe(1);
    expect(conflicting.stderr).toContain("not both");

    const cycle = await cli(["profiles", "edit", "Logging", "--add-extends", "Work"], env.ctx);
    expect(cycle.code).toBe(1);
    expect(cycle.stderr).toContain("Profile inheritance cycle: Logging -> Work -> Logging");

    const vanilla = await cli(["profiles", "create", "Safe", "--extends", "vanilla"], env.ctx);
    expect(vanilla.code).toBe(1);
    expect(vanilla.stderr).toContain("cannot be extended");

    const missing = await cli(["profiles", "create", "Lost", "--extends", "nope"], env.ctx);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Profile not found: nope");

    const refused = await cli(["profiles", "rm", "Logging", "--yes"], env.ctx);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Profile "Logging" is extended by "Work"');
    expect((await cli(["profiles", "edit", "Work", "--remove-extends", "Logging"], env.ctx)).code).toBe(0);
    expect((await cli(["profiles", "rm", "Logging", "--yes"], env.ctx)).code).toBe(0);
  });
});

describe("profile API extends", () => {
  it("accepts extends on create and keeps it on a partial update", async () => {
    const env = await makeTempEnv();
    const app = buildServer(env.ctx);
    const headers = { "x-capsule": "1", origin: "http://127.0.0.1:5173" };

    const created = await app.inject({
      method: "POST",
      url: "/api/profiles",
      headers,
      payload: { name: "Child", extends: ["personal"] }
    });
    expect(created.statusCode).toBe(200);
    const child = created.json<Profile>();
    expect(child.extends).toEqual(["personal"]);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/profiles/${child.id}`,
      headers,
      payload: { name: "Child 2" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Profile>().extends).toEqual(["personal"]);

    const overview = await app.inject({ method: "GET", url: "/api/profile-overview" });
    const listed = overview.json<{ profiles: ProfileSummary[] }>().profiles.find((item) => item.id === child.id)!;
    expect(listed.extends).toEqual(["personal"]);
    expect(listed.effectiveCapabilityIds).toEqual([]);

    const refused = await app.inject({ method: "DELETE", url: "/api/profiles/personal", headers });
    expect(refused.statusCode).toBe(500);
    expect(refused.json<{ error: string }>().error).toContain("is extended by");
    await app.close();
  });
});
