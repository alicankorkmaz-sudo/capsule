import { describe, expect, it } from "vitest";
import { formatProfileList, parseProfileCliArgs, resolveProfile } from "../src/profileCli";
import type { Capability, Profile } from "../src/types";

const profiles: Profile[] = [
  {
    id: "vanilla",
    name: "Vanilla",
    capabilityIds: [],
    system: "vanilla",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  },
  {
    id: "personal",
    name: "Personal",
    capabilityIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }
];

describe("profile CLI", () => {
  it("defaults to Vanilla in the current directory", () => {
    const options = parseProfileCliArgs([], "/tmp/project");
    expect(options.profile).toBe("vanilla");
    expect(options.projectPath).toBe("/tmp/project");
    expect(options.claudeArgs).toEqual([]);
  });

  it("parses profile aliases and forwards Claude arguments", () => {
    const short = parseProfileCliArgs(["-p", "personal", "--resume"], "/tmp/project");
    expect(short.profile).toBe("personal");
    expect(short.claudeArgs).toEqual(["--resume"]);

    const long = parseProfileCliArgs(
      ["--profile=Vanilla", "-C", "../other", "--", "--continue", "session-id"],
      "/tmp/project"
    );
    expect(long.profile).toBe("Vanilla");
    expect(long.projectPath).toBe("/tmp/other");
    expect(long.claudeArgs).toEqual(["--continue", "session-id"]);
  });

  it("resolves profile names and ids case-insensitively", () => {
    expect(resolveProfile(profiles, "VANILLA").id).toBe("vanilla");
    expect(resolveProfile(profiles, "Personal").id).toBe("personal");
    expect(() => resolveProfile(profiles, "missing")).toThrow("Available profiles: Vanilla, Personal");
  });

  it("lists enabled capability names and kinds for every profile", () => {
    const capabilities: Capability[] = [
      {
        id: "mcp-docs",
        kind: "mcp",
        name: "docs",
        config: { url: "https://example.com/mcp" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "hook-format",
        kind: "hook",
        name: "format",
        event: "PostToolUse",
        handlers: [{ type: "command", command: "npm run format" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];
    const configured = profiles.map((profile) =>
      profile.id === "personal" ? { ...profile, capabilityIds: capabilities.map((item) => item.id) } : profile
    );

    const output = formatProfileList(configured, capabilities);
    expect(output).toContain("Vanilla (system)");
    expect(output).toContain("Enabled capabilities: none");
    expect(output).toContain("Enabled capabilities (2):");
    expect(output).toContain("- docs [MCP server]");
    expect(output).toContain("- format [Hook · PostToolUse]");
  });
});
