import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/index";
import type { CliIO } from "../src/cli/output";
import type { RuntimeContext, ServerRecord } from "../src/types";
import { MASK } from "../src/types";
import type { Capability, Profile } from "../src/types";
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

const CONFIG = '{"command":"npx","args":["-y","demo-mcp"],"env":{"API_KEY":"secret"}}';

describe("caps CLI", () => {
  it("adds, lists, gets, and removes servers", async () => {
    const env = await makeTempEnv();

    const added = await cli(
      ["servers", "add", "demo", "--target", "claude-code-user", "--config", CONFIG, "--json"],
      env.ctx
    );
    expect(added.code).toBe(0);
    expect(json<ServerRecord[]>(added).map((record) => record.name)).toContain("demo");

    const list = await cli(["servers", "list"], env.ctx);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("demo");
    expect(list.stdout).toContain("Claude Code user");

    const masked = await cli(["servers", "get", "demo", "--json"], env.ctx);
    expect(masked.code).toBe(0);
    expect((json<ServerRecord>(masked).config.env as Record<string, string>).API_KEY).toBe(MASK);

    const raw = await cli(["servers", "get", "demo", "--show-secrets", "--json"], env.ctx);
    expect((json<ServerRecord>(raw).config.env as Record<string, string>).API_KEY).toBe("secret");

    const removed = await cli(["servers", "rm", "demo", "--yes", "--json"], env.ctx);
    expect(removed.code).toBe(0);
    expect(json<ServerRecord[]>(removed)).toHaveLength(0);
  });

  it("copies a server to another target", async () => {
    const env = await makeTempEnv();
    await cli(["servers", "add", "demo", "--target", "claude-code-user", "--config", CONFIG], env.ctx);

    const copied = await cli(
      ["servers", "copy", "demo", "--target", "claude-desktop", "--json"],
      env.ctx
    );
    expect(copied.code).toBe(0);
    const targets = json<ServerRecord[]>(copied)
      .filter((record) => record.name === "demo")
      .map((record) => record.target)
      .sort();
    expect(targets).toEqual(["claude-code-user", "claude-desktop"]);
  });

  it("refuses destructive actions without --yes when stdin is not a TTY", async () => {
    const env = await makeTempEnv();
    await cli(["servers", "add", "demo", "--target", "claude-code-user", "--config", CONFIG], env.ctx);

    const result = await cli(["servers", "rm", "demo"], env.ctx);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--yes");
  });

  it("rejects an invalid config with exit code 2", async () => {
    const env = await makeTempEnv();
    const result = await cli(
      ["servers", "add", "demo", "--target", "claude-code-user", "--config", "{}"],
      env.ctx
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("command or a url");
  });

  it("exits 1 for an unknown server", async () => {
    const env = await makeTempEnv();
    const result = await cli(["servers", "get", "missing"], env.ctx);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("MCP server not found: missing");
  });

  it("lists targets and validates configs", async () => {
    const env = await makeTempEnv();
    const targets = await cli(["targets", "--json"], env.ctx);
    expect(targets.code).toBe(0);
    expect(json<Array<{ key: string }>>(targets)).toHaveLength(6);

    const valid = await cli(["servers", "validate", "--config", CONFIG], env.ctx);
    expect(valid.code).toBe(0);
    expect(valid.stdout).toContain("valid");

    const invalid = await cli(["servers", "validate", "--config", "{}"], env.ctx);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toContain("command or a url");
  });

  it("lists and restores backups", async () => {
    const env = await makeTempEnv();
    await cli(["servers", "add", "demo", "--target", "claude-code-user", "--config", CONFIG], env.ctx);

    const backups = await cli(["backups", "list", "--json"], env.ctx);
    expect(backups.code).toBe(0);
    const entries = json<Array<{ id: string }>>(backups);
    expect(entries.length).toBeGreaterThan(0);

    const restored = await cli(["backups", "restore", entries[0].id, "--yes"], env.ctx);
    expect(restored.code).toBe(0);
    expect(restored.stdout).toContain("Restored backup");
  });

  it("manages profiles and the catalog", async () => {
    const env = await makeTempEnv();

    const created = await cli(
      ["catalog", "create", "demo-server", "--kind", "mcp", "--config", CONFIG, "--json"],
      env.ctx
    );
    expect(created.code).toBe(0);
    const capability = json<Capability>(created);

    const filtered = await cli(["catalog", "list", "--kind", "mcp", "--json"], env.ctx);
    expect(json<Capability[]>(filtered).map((item) => item.id)).toContain(capability.id);
    const empty = await cli(["catalog", "list", "--kind", "skill", "--json"], env.ctx);
    expect(json<Capability[]>(empty)).toHaveLength(0);

    const profile = await cli(
      ["profiles", "create", "Work", "--capability", "demo-server", "--json"],
      env.ctx
    );
    expect(profile.code).toBe(0);
    expect(json<Profile>(profile).capabilityIds).toEqual([capability.id]);

    const listed = await cli(["profiles", "list"], env.ctx);
    expect(listed.stdout).toContain("Vanilla (system)");
    expect(listed.stdout).toContain("Work");

    const removedProfile = await cli(["profiles", "rm", "Work", "--yes"], env.ctx);
    expect(removedProfile.code).toBe(0);
    const removedCapability = await cli(["catalog", "rm", "demo-server", "--yes"], env.ctx);
    expect(removedCapability.code).toBe(0);
  });

  it("scans and imports existing configs by candidate id", async () => {
    const env = await makeTempEnv();
    await cli(["servers", "add", "demo", "--target", "claude-code-user", "--config", CONFIG], env.ctx);

    const scan = await cli(["import", "scan", "--json"], env.ctx);
    expect(scan.code).toBe(0);
    const candidates = json<Array<{ id: string; name: string }>>(scan);
    const demo = candidates.find((candidate) => candidate.name === "demo");
    expect(demo).toBeDefined();

    const commit = await cli(
      ["import", "commit", demo!.id, "--catalog-only", "--yes", "--json"],
      env.ctx
    );
    expect(commit.code).toBe(0);
    expect(json<Capability[]>(commit).map((item) => item.name)).toContain("demo");

    const unknown = await cli(["import", "commit", "nope", "--catalog-only", "--yes"], env.ctx);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown candidate id");
  });

  it("shows help without error", async () => {
    const env = await makeTempEnv();
    const help = await cli(["--help"], env.ctx);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("servers");
    expect(help.stdout).toContain("profiles");
  });
});
