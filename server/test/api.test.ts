import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src";
import { makeTempEnv } from "./helpers";

describe("API guard", () => {
  it("lists first-level project directories from the configured projects root", async () => {
    const env = await makeTempEnv();
    await fs.mkdir(path.join(env.ctx.projectsDir, "zeta"));
    await fs.mkdir(path.join(env.ctx.projectsDir, "alpha"));
    await fs.writeFile(path.join(env.ctx.projectsDir, "notes.txt"), "not a project");
    const app = buildServer(env.ctx);

    const response = await app.inject({ method: "GET", url: "/api/projects" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { name: "alpha", path: path.join(env.ctx.projectsDir, "alpha") },
      { name: "zeta", path: path.join(env.ctx.projectsDir, "zeta") }
    ]);
    await app.close();
  });

  it("rejects mutating requests without the local request marker", async () => {
    const env = await makeTempEnv();
    const app = buildServer(env.ctx);

    const response = await app.inject({
      method: "POST",
      url: "/api/servers",
      payload: {
        targets: ["codex"],
        name: "context7",
        config: { command: "npx", args: ["-y", "@upstash/context7-mcp"] }
      }
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("accepts marked local mutating requests", async () => {
    const env = await makeTempEnv();
    const app = buildServer(env.ctx);

    const response = await app.inject({
      method: "POST",
      url: "/api/servers",
      headers: { "x-capsule": "1", origin: "http://127.0.0.1:5173" },
      payload: {
        targets: ["codex"],
        name: "context7",
        config: { command: "npx", args: ["-y", "@upstash/context7-mcp"] }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().some((item: { name: string }) => item.name === "context7")).toBe(true);
    await app.close();
  });

  it("loads raw server details for encoded ids longer than Fastify's default param limit", async () => {
    const env = await makeTempEnv();
    const app = buildServer(env.ctx);

    const create = await app.inject({
      method: "POST",
      url: "/api/servers",
      headers: { "x-capsule": "1", origin: "http://127.0.0.1:5173" },
      payload: {
        targets: ["claude-code-local"],
        name: "longid",
        projectPath: env.project,
        config: { type: "stdio", command: "node", args: ["server.js"] }
      }
    });
    const record = create
      .json()
      .find((item: { name: string; target: string }) => item.name === "longid" && item.target === "claude-code-local");
    expect(record.id.length).toBeGreaterThan(100);

    const details = await app.inject({
      method: "GET",
      url: `/api/servers/${encodeURIComponent(record.id)}?raw=true`
    });

    expect(details.statusCode).toBe(200);
    expect(details.json().config.command).toBe("node");
    await app.close();
  });

  it("creates a reusable profile and applies it through the profile API", async () => {
    const env = await makeTempEnv();
    const app = buildServer(env.ctx);
    const headers = { "x-capsule": "1", origin: "http://127.0.0.1:5173" };

    const capabilityResponse = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers,
      payload: {
        kind: "instruction",
        name: "Testing rules",
        content: "Always run the test suite."
      }
    });
    expect(capabilityResponse.statusCode).toBe(200);
    const capability = capabilityResponse.json();

    const profileResponse = await app.inject({
      method: "POST",
      url: "/api/profiles",
      headers,
      payload: {
        name: "API Work",
        capabilityIds: [capability.id]
      }
    });
    expect(profileResponse.statusCode).toBe(200);
    const profile = profileResponse.json();

    const applyResponse = await app.inject({
      method: "POST",
      url: "/api/profile-apply",
      headers,
      payload: {
        profileId: profile.id,
        projectPath: env.project,
        confirmOwnership: true
      }
    });
    expect(applyResponse.statusCode).toBe(200);
    expect(applyResponse.json().state).toBe("applied");
    expect(await fs.readFile(path.join(env.project, "CLAUDE.local.md"), "utf8")).toContain(
      "Always run the test suite"
    );

    const overview = await app.inject({
      method: "GET",
      url: `/api/profile-overview?projectPath=${encodeURIComponent(env.project)}`
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().selectedAssignment.profileId).toBe(profile.id);
    await app.close();
  });
});
