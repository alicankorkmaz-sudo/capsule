import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src";
import { runCli } from "../src/cli/index";
import type { CliIO } from "../src/cli/output";
import {
  formatDoctorReport,
  parseHookCommand,
  runDoctor,
  skillFileReferences,
  skillInvocations,
  type DoctorIssue
} from "../src/doctor";
import { customPluginsRoot, profileStorePath } from "../src/profileStorage";
import { backupsDir } from "../src/storage";
import type { Capability, Profile, ProfileStore, ProjectAssignment } from "../src/types";
import { makeTempEnv, type TempEnv } from "./helpers";

const NOW = "2026-01-01T00:00:00.000Z";

type CapabilitySeed = Omit<Capability, "createdAt" | "updatedAt"> & Record<string, unknown>;

interface Seed {
  capabilities?: CapabilitySeed[];
  profiles?: Array<{ id: string; name?: string; capabilityIds: string[]; extends?: string[] }>;
  assignments?: Array<{ projectPath: string; profileId: string; state?: ProjectAssignment["state"] }>;
}

async function seedStore(env: TempEnv, seed: Seed): Promise<void> {
  const store: ProfileStore = {
    version: 1,
    capabilities: {},
    profiles: {
      vanilla: {
        id: "vanilla",
        name: "Vanilla",
        capabilityIds: [],
        system: "vanilla",
        createdAt: NOW,
        updatedAt: NOW
      },
      personal: { id: "personal", name: "Personal", capabilityIds: [], createdAt: NOW, updatedAt: NOW }
    },
    assignments: {}
  };
  for (const item of seed.capabilities ?? []) {
    store.capabilities[item.id] = { ...item, createdAt: NOW, updatedAt: NOW } as Capability;
  }
  for (const profile of seed.profiles ?? []) {
    store.profiles[profile.id] = {
      id: profile.id,
      name: profile.name ?? profile.id,
      capabilityIds: profile.capabilityIds,
      ...(profile.extends ? { extends: profile.extends } : {}),
      createdAt: NOW,
      updatedAt: NOW
    } satisfies Profile;
  }
  for (const assignment of seed.assignments ?? []) {
    store.assignments[Buffer.from(assignment.projectPath).toString("base64url")] = {
      projectPath: assignment.projectPath,
      profileId: assignment.profileId,
      state: assignment.state ?? "applied",
      updatedAt: NOW
    };
  }
  await fs.mkdir(env.ctx.appDir, { recursive: true });
  await fs.writeFile(profileStorePath(env.ctx), JSON.stringify(store));
}

async function writeExecutable(filePath: string, mode = 0o755): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "#!/bin/sh\nexit 0\n", { mode });
  await fs.chmod(filePath, mode);
}

/** A PATH holding only the given commands, so lookups don't depend on the host. */
async function fakePath(env: TempEnv, commands: string[]): Promise<Record<string, string>> {
  const bin = path.join(env.root, "bin");
  await fs.mkdir(bin, { recursive: true });
  for (const command of commands) await writeExecutable(path.join(bin, command));
  return { PATH: bin };
}

function byCode(issues: DoctorIssue[], code: string): DoctorIssue[] {
  return issues.filter((issue) => issue.code === code);
}

const skill = (id: string, name: string, content: string, files?: Record<string, string>): CapabilitySeed => ({
  id,
  kind: "skill",
  name,
  content,
  files
});

describe("doctor: installed plugins", () => {
  it("flags catalog plugins missing from installed_plugins.json", async () => {
    const env = await makeTempEnv();
    const inventory = path.join(env.home, ".claude", "plugins", "installed_plugins.json");
    await fs.mkdir(path.dirname(inventory), { recursive: true });
    await fs.writeFile(
      inventory,
      JSON.stringify({
        version: 2,
        plugins: { "kept@market": [{ scope: "user", installPath: "/x/kept", version: "1.0.0" }] }
      })
    );
    const plugin = (id: string, pluginId: string): CapabilitySeed => ({
      id,
      kind: "installed-plugin",
      name: pluginId,
      pluginId,
      installPath: `/x/${pluginId}`
    });
    await seedStore(env, {
      capabilities: [plugin("p-kept", "kept@market"), plugin("p-gone", "gone@market"), plugin("p-orphan", "orphan@market")],
      profiles: [{ id: "work", name: "Work", capabilityIds: ["p-kept", "p-gone"] }]
    });

    const issues = byCode(await runDoctor(env.ctx, { env: {} }), "plugin-not-installed");

    expect(issues.map((issue) => [issue.capabilityId, issue.severity])).toEqual([
      ["p-gone", "error"],
      ["p-orphan", "warn"]
    ]);
    expect(issues[1].hint).toBe("caps catalog rm p-orphan");
  });

  it("reports an unreadable inventory as info instead of guessing", async () => {
    const env = await makeTempEnv();
    await seedStore(env, {
      capabilities: [{ id: "p", kind: "installed-plugin", name: "a@b", pluginId: "a@b", installPath: "/x" }]
    });
    const issues = await runDoctor(env.ctx, { env: {} });
    expect(byCode(issues, "plugin-not-installed")).toHaveLength(0);
    expect(byCode(issues, "installed-plugins-unreadable")[0].severity).toBe("info");
  });
});

describe("doctor: MCP commands", () => {
  it("flags missing absolute commands and bare commands not on PATH", async () => {
    const env = await makeTempEnv();
    const pathEnv = await fakePath(env, ["npx", "uvx"]);
    const present = path.join(env.home, "bin", "server");
    const notExecutable = path.join(env.root, "tools", "plain");
    await writeExecutable(present);
    await writeExecutable(notExecutable, 0o644);
    const mcp = (id: string, config: Record<string, unknown>): CapabilitySeed => ({ id, kind: "mcp", name: id, config });
    await seedStore(env, {
      capabilities: [
        mcp("npx-ok", { command: "npx", args: ["-y", "demo"] }),
        mcp("uvx-ok", { type: "stdio", command: "uvx", args: ["demo"] }),
        mcp("abs-ok", { command: present }),
        mcp("home-ok", { command: `~/${path.relative(env.home, present)}` }),
        mcp("http-ok", { type: "http", url: "https://example.com/mcp" }),
        mcp("abs-missing", { command: path.join(env.root, "nope", "server") }),
        mcp("not-exec", { command: notExecutable }),
        mcp("bare-missing", { command: "definitely-not-installed-cmd" }),
        mcp("unused-missing", { command: "/no/such/binary" })
      ],
      profiles: [
        {
          id: "work",
          capabilityIds: ["npx-ok", "uvx-ok", "abs-ok", "home-ok", "http-ok", "abs-missing", "not-exec", "bare-missing"]
        }
      ]
    });

    const issues = byCode(await runDoctor(env.ctx, { env: pathEnv }), "mcp-command-missing");

    expect(Object.fromEntries(issues.map((issue) => [issue.capabilityId, issue.severity]))).toEqual({
      "abs-missing": "error",
      "not-exec": "error",
      "bare-missing": "error",
      "unused-missing": "warn"
    });
    expect(issues.find((issue) => issue.capabilityId === "bare-missing")?.message).toContain("not on PATH");
    expect(issues.find((issue) => issue.capabilityId === "not-exec")?.message).toContain("not executable");
  });
});

describe("doctor: assignments", () => {
  it("flags missing project paths, pending assignments and unknown profiles", async () => {
    const env = await makeTempEnv();
    const gone = path.join(env.root, "deleted-project");
    await seedStore(env, {
      assignments: [
        { projectPath: gone, profileId: "personal" },
        { projectPath: env.project, profileId: "personal", state: "pending" },
        { projectPath: env.root, profileId: "profile-deleted" }
      ]
    });

    const issues = await runDoctor(env.ctx, { env: {} });

    const missing = byCode(issues, "assignment-path-missing");
    expect(missing).toMatchObject([{ severity: "warn", projectPath: gone, profileId: "personal" }]);
    expect(missing[0].hint).toContain("profiles deactivate");
    expect(byCode(issues, "assignment-pending")).toMatchObject([{ severity: "info", projectPath: env.project }]);
    expect(byCode(issues, "assignment-profile-missing")).toMatchObject([
      { severity: "error", projectPath: env.root, profileId: "profile-deleted" }
    ]);
  });

  it("flags profiles that reference capabilities missing from the catalog", async () => {
    const env = await makeTempEnv();
    await seedStore(env, { profiles: [{ id: "work", capabilityIds: ["ghost"] }] });
    const issues = byCode(await runDoctor(env.ctx, { env: {} }), "profile-capability-missing");
    expect(issues).toMatchObject([{ severity: "error", capabilityId: "ghost", profileId: "work" }]);
  });
});

describe("doctor: profile inheritance", () => {
  it("flags missing parents and cycles in extends", async () => {
    const env = await makeTempEnv();
    await seedStore(env, {
      profiles: [
        { id: "orphan", name: "Orphan", capabilityIds: [], extends: ["gone"] },
        { id: "a", name: "A", capabilityIds: [], extends: ["b"] },
        { id: "b", name: "B", capabilityIds: [], extends: ["a"] }
      ]
    });

    const issues = byCode(await runDoctor(env.ctx, { env: {} }), "profile-extends-invalid");

    expect(issues.map((issue) => issue.profileId).sort()).toEqual(["a", "b", "orphan"]);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });
});

describe("doctor: hooks", () => {
  it("parses the program and script out of a hook command", () => {
    expect(parseHookCommand('"$CLAUDE_PROJECT_DIR"/bin/autosave.sh')).toEqual({
      program: "$CLAUDE_PROJECT_DIR/bin/autosave.sh"
    });
    expect(parseHookCommand('sh "$HOME/.claude/hooks/log.sh"')).toEqual({
      program: "sh",
      script: "$HOME/.claude/hooks/log.sh"
    });
    expect(parseHookCommand("FOO=1 node --no-warnings ./hook.mjs --flag")).toEqual({
      program: "node",
      script: "./hook.mjs"
    });
    expect(parseHookCommand("bash -c 'echo hi'")).toEqual({ program: "bash" });
    expect(parseHookCommand("rtk hook claude && echo done")).toEqual({ program: "rtk" });
  });

  it("checks $CLAUDE_PROJECT_DIR scripts against every directly assigned project", async () => {
    const env = await makeTempEnv();
    const learning = path.join(env.root, "learning");
    const desktop = path.join(env.root, "Desktop");
    await writeExecutable(path.join(learning, "bin", "autosave.sh"));
    await fs.mkdir(desktop, { recursive: true });
    await seedStore(env, {
      capabilities: [
        {
          id: "autosave",
          kind: "hook",
          name: "autosave",
          event: "SessionEnd",
          handlers: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/bin/autosave.sh', timeout: 30 }]
        }
      ],
      profiles: [{ id: "learner", name: "Learner", capabilityIds: ["autosave"] }],
      assignments: [
        { projectPath: learning, profileId: "learner" },
        { projectPath: desktop, profileId: "learner" },
        { projectPath: env.project, profileId: "personal" }
      ]
    });

    const issues = byCode(await runDoctor(env.ctx, { env: {} }), "hook-script-missing");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "warn",
      capabilityId: "autosave",
      profileId: "learner",
      projectPath: desktop
    });
    expect(issues[0].message).toContain(path.join(desktop, "bin", "autosave.sh"));
  });

  it("checks hooks a profile inherits against projects assigned to the child", async () => {
    const env = await makeTempEnv();
    const desktop = path.join(env.root, "Desktop");
    await fs.mkdir(desktop, { recursive: true });
    await seedStore(env, {
      capabilities: [
        {
          id: "autosave",
          kind: "hook",
          name: "autosave",
          event: "SessionEnd",
          handlers: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/bin/autosave.sh' }]
        }
      ],
      profiles: [
        { id: "base", name: "Base", capabilityIds: ["autosave"] },
        { id: "child", name: "Child", capabilityIds: [], extends: ["base"] }
      ],
      assignments: [{ projectPath: desktop, profileId: "child" }]
    });

    const issues = await runDoctor(env.ctx, { env: {} });

    expect(byCode(issues, "hook-script-missing")).toMatchObject([
      { severity: "warn", capabilityId: "autosave", profileId: "child", projectPath: desktop }
    ]);
    expect(byCode(issues, "unused-capabilities")).toHaveLength(0);
  });

  it("expands $HOME and checks bare commands on PATH", async () => {
    const env = await makeTempEnv();
    const pathEnv = await fakePath(env, ["sh"]);
    await writeExecutable(path.join(env.home, ".claude", "hooks", "present.sh"));
    const hook = (id: string, command: string): CapabilitySeed => ({
      id,
      kind: "hook",
      name: id,
      event: "PreToolUse",
      handlers: [{ type: "command", command }]
    });
    await seedStore(env, {
      capabilities: [
        hook("home-ok", 'sh "$HOME/.claude/hooks/present.sh"'),
        hook("tilde-missing", "sh ~/.claude/hooks/absent.sh"),
        hook("bare-missing", "rtk hook claude"),
        hook("unknown-var", "$SOME_TOOL_DIR/run.sh"),
        {
          id: "prompt",
          kind: "hook",
          name: "prompt",
          event: "Stop",
          handlers: [{ type: "prompt", prompt: "check" }]
        }
      ],
      profiles: [{ id: "work", capabilityIds: ["home-ok", "tilde-missing", "bare-missing", "unknown-var", "prompt"] }]
    });

    const issues = await runDoctor(env.ctx, { env: pathEnv });

    expect(byCode(issues, "hook-script-missing")).toMatchObject([{ capabilityId: "tilde-missing", severity: "warn" }]);
    expect(byCode(issues, "hook-script-missing")[0].message).toContain(
      path.join(env.home, ".claude", "hooks", "absent.sh")
    );
    expect(byCode(issues, "hook-command-missing")).toMatchObject([{ capabilityId: "bare-missing", severity: "warn" }]);
  });
});

describe("doctor: skill files", () => {
  it("extracts sibling-file references conservatively", () => {
    const content = [
      "---",
      "name: demo",
      "---",
      "See [DEEPENING.md](DEEPENING.md) and [format](./ADR-FORMAT.md#top).",
      "Run `scripts/check.sh` or `references/api.md`; templates live in `./templates/base.html`.",
      "Shipped: [guide](guide.md).",
      "Project files: `CONTEXT.md`, [ctx](CONTEXT.md), `docs/adr/0001.md`, [adr](docs/adr/x.md), `src/index.ts`.",
      "Not files: [site](https://example.com/a.md), [mail](mailto:a@b.c), [anchor](#usage), [link](link),",
      "`./lessons/`, `./reference/*.html`, `scripts/<name>.sh`, [up](../other/SKILL.md), [abs](/etc/hosts.conf).",
      "Bare spans are ambiguous and skipped: `NOTES.md`, `CODING_STANDARDS.md`.",
      "```",
      "[fenced](FENCED.md) `scripts/fenced.sh`",
      "```"
    ].join("\n");

    expect(skillFileReferences(content)).toEqual([
      "ADR-FORMAT.md",
      "DEEPENING.md",
      "guide.md",
      "references/api.md",
      "scripts/check.sh",
      "templates/base.html"
    ]);
  });

  it("warns when a skill references files missing from its files map", async () => {
    const env = await makeTempEnv();
    await fs.mkdir(path.join(env.project, "scripts"), { recursive: true });
    await fs.writeFile(path.join(env.project, "scripts", "project-tool.sh"), "");
    await seedStore(env, {
      capabilities: [
        skill(
          "s-broken",
          "codebase-design",
          "See [DEEPENING.md](DEEPENING.md), [shipped](./SHIPPED.md) and `scripts/project-tool.sh`.",
          { "SHIPPED.md": "ok" }
        ),
        skill("s-unused", "orphan", "See [MISSING.md](MISSING.md).")
      ],
      profiles: [{ id: "work", capabilityIds: ["s-broken"] }],
      assignments: [{ projectPath: env.project, profileId: "work" }]
    });

    const issues = byCode(await runDoctor(env.ctx, { env: {} }), "skill-file-missing");

    expect(issues.map((issue) => [issue.capabilityId, issue.severity])).toEqual([
      ["s-broken", "warn"],
      ["s-unused", "info"]
    ]);
    // SHIPPED.md is in the files map; scripts/project-tool.sh exists in the assigned project.
    expect(issues[0].message).toContain("DEEPENING.md");
    expect(issues[0].message).not.toContain("SHIPPED.md");
    expect(issues[0].message).not.toContain("project-tool.sh");
  });
});

describe("doctor: skill cross-references", () => {
  it("finds slash and prose invocations", () => {
    const content = [
      "Run `/grilling` first, then /domain-modeling.",
      "Use the `tdd` skill, or use the handoff skill.",
      "Not skills: /tmp/x, ~/.claude/jev-stats.html, /api/v1, https://a.b/c-d.",
      "```",
      "/fenced-skill",
      "```"
    ].join("\n");
    expect(skillInvocations(content)).toEqual(["domain-modeling", "grilling", "handoff", "tdd"]);
  });

  it("warns per profile when an invoked catalog skill is not in that profile", async () => {
    const env = await makeTempEnv();
    const pluginRoot = path.join(customPluginsRoot(env.ctx), "bundle");
    await fs.mkdir(path.join(pluginRoot, "skills", "from-plugin"), { recursive: true });
    await fs.writeFile(path.join(pluginRoot, "skills", "from-plugin", "SKILL.md"), "x");
    await seedStore(env, {
      capabilities: [
        skill("s-main", "main", "Start with /grilling, then use the `domain-modeling` skill, then /from-plugin and /tmp."),
        skill("s-grill", "grilling", "Interview."),
        skill("s-domain", "domain-modeling", "Model."),
        skill("s-from-plugin", "from-plugin", "Catalog copy."),
        { id: "bundle", kind: "custom-plugin", name: "bundle", rootPath: pluginRoot }
      ],
      profiles: [
        { id: "partial", name: "Partial", capabilityIds: ["s-main", "s-grill", "bundle"] },
        { id: "full", name: "Full", capabilityIds: ["s-main", "s-grill", "s-domain", "s-from-plugin"] }
      ]
    });

    const issues = byCode(await runDoctor(env.ctx, { env: {} }), "skill-ref-not-in-profile");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warn", capabilityId: "s-main", profileId: "partial" });
    expect(issues[0].message).toContain("/domain-modeling");
    expect(issues[0].message).not.toContain("/from-plugin");
    expect(issues[0].hint).toBe("caps profiles edit Partial --add domain-modeling");
  });
});

describe("doctor: custom plugins", () => {
  it("flags a missing rootPath", async () => {
    const env = await makeTempEnv();
    const present = path.join(customPluginsRoot(env.ctx), "present");
    await fs.mkdir(present, { recursive: true });
    await seedStore(env, {
      capabilities: [
        { id: "cp-ok", kind: "custom-plugin", name: "ok", rootPath: present },
        { id: "cp-gone", kind: "custom-plugin", name: "gone", rootPath: path.join(customPluginsRoot(env.ctx), "gone") }
      ],
      profiles: [{ id: "work", name: "Work", capabilityIds: ["cp-ok", "cp-gone"] }]
    });

    const issues = byCode(await runDoctor(env.ctx, { env: {} }), "custom-plugin-missing");

    expect(issues).toMatchObject([{ severity: "error", capabilityId: "cp-gone" }]);
    expect(issues[0].hint).toBe("caps profiles edit Work --remove cp-gone && caps catalog rm cp-gone");
  });
});

describe("doctor: housekeeping", () => {
  it("reports unused capabilities and backup totals as info", async () => {
    const env = await makeTempEnv();
    await seedStore(env, {
      capabilities: [
        { id: "i-used", kind: "instruction", name: "used", content: "x" },
        { id: "i-idle", kind: "instruction", name: "idle", content: "x" },
        { id: "i-vanilla", kind: "instruction", name: "vanilla-only", content: "x" }
      ],
      profiles: [{ id: "work", capabilityIds: ["i-used"] }]
    });
    await fs.mkdir(backupsDir(env.ctx), { recursive: true });
    await fs.writeFile(path.join(backupsDir(env.ctx), "a.json"), "x".repeat(1000));
    await fs.writeFile(path.join(backupsDir(env.ctx), "b.json"), "x".repeat(1048));

    const issues = await runDoctor(env.ctx, { env: {} });

    const unused = byCode(issues, "unused-capabilities");
    expect(unused).toHaveLength(1);
    expect(unused[0].severity).toBe("info");
    expect(unused[0].message).toMatch(/^2 capabilities/);
    expect(unused[0].message).toContain("idle (instruction)");
    expect(unused[0].message).toContain("vanilla-only (instruction)");
    expect(byCode(issues, "backups")).toMatchObject([{ severity: "info" }]);
    expect(byCode(issues, "backups")[0].message).toContain("2 backups using 2.0 KB");
  });

  it("is read-only: a fresh home stays untouched", async () => {
    const env = await makeTempEnv();
    const issues = await runDoctor(env.ctx, { env: {} });
    expect(issues).toEqual([]);
    await expect(fs.access(env.ctx.appDir)).rejects.toThrow();
    expect(formatDoctorReport(issues)).toBe("No problems found.\n0 errors, 0 warnings, 0 info\n");
  });
});

describe("caps doctor", () => {
  async function cli(argv: string[], env: TempEnv) {
    const out: string[] = [];
    const io: CliIO = { out: (text) => out.push(text), err: (text) => out.push(text) };
    const code = await runCli(argv, { ctx: env.ctx, io });
    return { code, stdout: out.join("") };
  }

  it("exits 1 on errors and prints grouped output with fix hints", async () => {
    const env = await makeTempEnv();
    await seedStore(env, {
      capabilities: [{ id: "cp", kind: "custom-plugin", name: "gone", rootPath: "/no/such/plugin" }],
      profiles: [{ id: "work", name: "Work", capabilityIds: ["cp"] }],
      assignments: [{ projectPath: env.project, profileId: "work", state: "pending" }]
    });

    const human = await cli(["doctor"], env);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("Errors (1)");
    expect(human.stdout).toContain("[custom-plugin-missing]");
    expect(human.stdout).toContain("fix: caps profiles edit Work --remove cp && caps catalog rm cp");
    expect(human.stdout).toContain("Info (1)");
    expect(human.stdout.indexOf("Errors")).toBeLessThan(human.stdout.indexOf("Info"));

    const json = await cli(["doctor", "--json"], env);
    expect(json.code).toBe(1);
    const issues = JSON.parse(json.stdout) as DoctorIssue[];
    expect(issues.map((issue) => issue.code)).toEqual(["custom-plugin-missing", "assignment-pending"]);
    for (const issue of issues) {
      expect(Object.keys(issue)).toEqual(expect.arrayContaining(["severity", "code", "message", "hint"]));
    }
  });

  it("exits 0 when there are only warnings or info", async () => {
    const env = await makeTempEnv();
    await seedStore(env, { assignments: [{ projectPath: path.join(env.root, "gone"), profileId: "personal" }] });
    const result = await cli(["doctor"], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Warnings (1)");
  });

  it("is exposed as GET /api/doctor", async () => {
    const env = await makeTempEnv();
    await seedStore(env, { profiles: [{ id: "work", capabilityIds: ["ghost"] }] });
    const app = buildServer(env.ctx);
    const response = await app.inject({ method: "GET", url: "/api/doctor" });
    expect(response.statusCode).toBe(200);
    expect((response.json() as DoctorIssue[]).map((issue) => issue.code)).toContain("profile-capability-missing");
    await app.close();
  });
});
