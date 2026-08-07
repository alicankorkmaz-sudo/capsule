import path from "node:path";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  type AddServerInput,
  type CopyServerInput,
  type CopyServersInput,
  type MoveServerInput,
  type MoveServersInput,
  McpManager
} from "./manager";
import {
  createRuntimeContext,
  getTargetStatuses,
  listProjects,
  migrateLegacyAppDir
} from "./paths";
import { TargetKeySchema } from "./types";
import type { RuntimeContext } from "./types";
import { CapabilityKindSchema } from "./types";
import { ProfileManager } from "./profileManager";

const MutatingBodySchema = z.object({
  allowElevated: z.boolean().optional()
});

const AddServerBodySchema = MutatingBodySchema.extend({
  targets: z.array(TargetKeySchema).min(1),
  name: z.string(),
  config: z.unknown(),
  projectPath: z.string().optional()
});

const PatchServerBodySchema = MutatingBodySchema.extend({
  name: z.string().optional(),
  config: z.unknown().optional(),
  enabled: z.boolean().optional(),
  projectPath: z.string().optional()
});

const MoveServerBodySchema = MutatingBodySchema.extend({
  target: TargetKeySchema,
  name: z.string().optional(),
  projectPath: z.string().optional()
});

const CopyServersBodySchema = MutatingBodySchema.extend({
  ids: z.array(z.string()).min(1),
  target: TargetKeySchema,
  projectPath: z.string().optional()
});

const RestoreBodySchema = MutatingBodySchema;

const ValidateBodySchema = z.object({
  config: z.unknown()
});

const CapabilityBodySchema = z
  .object({
    kind: CapabilityKindSchema,
    name: z.string(),
    description: z.string().optional(),
    config: z.unknown().optional(),
    pluginId: z.string().optional(),
    installPath: z.string().optional(),
    version: z.string().optional(),
    scope: z.string().optional(),
    rootPath: z.string().optional(),
    content: z.string().optional(),
    files: z.record(z.string()).optional(),
    event: z.string().optional(),
    matcher: z.string().optional(),
    handlers: z.array(z.unknown()).optional()
  })
  .strict();

const ProfileBodySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  capabilityIds: z.array(z.string()).optional()
});

const ApplyBodySchema = z.object({
  profileId: z.string(),
  projectPath: z.string(),
  confirmOwnership: z.boolean().optional(),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional()
});

const ImportCommitBodySchema = z.object({
  candidateIds: z.array(z.string()),
  profileName: z.string().optional()
});

const CatalogImportBodySchema = z.object({
  candidateIds: z.array(z.string()).min(1)
});

export function buildServer(ctx: RuntimeContext = createRuntimeContext()): FastifyInstance {
  const app = Fastify({
    logger: true,
    routerOptions: {
      maxParamLength: 8192
    }
  });
  const manager = new McpManager(ctx);
  const profiles = new ProfileManager(ctx);

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api")) return;
    if (!["POST", "PATCH", "DELETE", "PUT"].includes(request.method)) return;
    const marker = request.headers["x-capsule"];
    if (marker !== "1") {
      reply.code(403);
      throw new Error("Missing local Capsule request marker.");
    }
    const origin = request.headers.origin ?? request.headers.referer;
    if (origin && !isLocalOrigin(origin)) {
      reply.code(403);
      throw new Error("Rejected non-local origin.");
    }
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/projects", async () => listProjects(ctx));

  app.get("/api/targets", async (request) => {
    const query = z.object({ projectPath: z.string().optional() }).parse(request.query);
    return getTargetStatuses(ctx, query.projectPath);
  });

  app.get("/api/servers", async (request) => {
    const query = z.object({ projectPath: z.string().optional() }).parse(request.query);
    return manager.listServers(query.projectPath);
  });

  app.get("/api/servers/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ raw: z.string().optional() }).parse(request.query);
    const record = await manager.getServer(params.id, query.raw === "true");
    if (!record) return reply.code(404).send({ error: "Server not found" });
    return record;
  });

  app.post("/api/servers", async (request) => {
    const body = AddServerBodySchema.parse(request.body);
    if (body.config === undefined) throw new Error("Missing MCP server config.");
    return manager.addServer(body as AddServerInput);
  });

  app.patch("/api/servers/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = PatchServerBodySchema.parse(request.body);
    return manager.patchServer(params.id, body);
  });

  app.post("/api/servers/:id/move", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = MoveServerBodySchema.parse(request.body);
    return manager.moveServer(params.id, body as MoveServerInput);
  });

  app.post("/api/servers/:id/copy", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = MoveServerBodySchema.parse(request.body);
    return manager.copyServer(params.id, body as CopyServerInput);
  });

  app.post("/api/servers/copy", async (request) => {
    const body = CopyServersBodySchema.parse(request.body);
    return manager.copyServers(body as CopyServersInput);
  });

  app.post("/api/servers/move", async (request) => {
    const body = CopyServersBodySchema.parse(request.body);
    return manager.moveServers(body as MoveServersInput);
  });

  app.delete("/api/servers/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = MutatingBodySchema.partial().optional().parse(request.body ?? {});
    return manager.deleteServer(params.id, body?.allowElevated);
  });

  app.get("/api/backups", async () => manager.listBackups());

  app.post("/api/backups/:id/restore", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = RestoreBodySchema.parse(request.body ?? {});
    await manager.restoreBackup(params.id, body.allowElevated);
    return reply.code(204).send();
  });

  app.post("/api/backup-groups/:id/restore", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = RestoreBodySchema.parse(request.body ?? {});
    await manager.restoreBackupGroup(params.id, body.allowElevated);
    return reply.code(204).send();
  });

  app.post("/api/validate", async (request, reply) => {
    const body = ValidateBodySchema.parse(request.body);
    const result = manager.validateConfig(body.config);
    if (!result.success) {
      return reply.code(400).send({
        ok: false,
        errors: result.error.issues.map((issue) => issue.message)
      });
    }
    return { ok: true, config: result.data };
  });

  app.get("/api/profile-overview", async (request) => {
    const query = z.object({ projectPath: z.string().optional() }).parse(request.query);
    return profiles.getOverview(query.projectPath);
  });

  app.get("/api/catalog", async () => profiles.listCapabilities());

  app.get("/api/catalog/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ raw: z.string().optional() }).parse(request.query);
    const item = await profiles.getCapability(params.id, query.raw === "true");
    if (!item) return reply.code(404).send({ error: "Capability not found" });
    return item;
  });

  app.post("/api/catalog", async (request) => {
    return profiles.createCapability(CapabilityBodySchema.parse(request.body));
  });

  app.patch("/api/catalog/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return profiles.updateCapability(params.id, CapabilityBodySchema.partial().parse(request.body));
  });

  app.delete("/api/catalog/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    await profiles.deleteCapability(params.id);
    return reply.code(204).send();
  });

  app.post("/api/catalog/plugins/sync", async () => profiles.syncInstalledPlugins());

  app.post("/api/catalog/plugins/:id/fork", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ name: z.string().optional() }).parse(request.body ?? {});
    return profiles.forkPlugin(params.id, body.name);
  });

  app.get("/api/catalog/plugins/:id/files", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return profiles.listPluginFiles(params.id);
  });

  app.get("/api/catalog/plugins/:id/file", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const query = z.object({ path: z.string() }).parse(request.query);
    return { content: await profiles.readPluginFile(params.id, query.path) };
  });

  app.put("/api/catalog/plugins/:id/file", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ path: z.string(), content: z.string() }).parse(request.body);
    await profiles.writePluginFile(params.id, body.path, body.content);
    return reply.code(204).send();
  });

  app.delete("/api/catalog/plugins/:id/file", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ path: z.string() }).parse(request.body);
    await profiles.removePluginFile(params.id, body.path);
    return reply.code(204).send();
  });

  app.post("/api/catalog/plugins/:id/validate", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return profiles.validateCustomPlugin(params.id);
  });

  app.post("/api/profiles", async (request) => {
    return profiles.createProfile(ProfileBodySchema.parse(request.body));
  });

  app.patch("/api/profiles/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return profiles.updateProfile(params.id, ProfileBodySchema.partial().parse(request.body));
  });

  app.delete("/api/profiles/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    await profiles.deleteProfile(params.id);
    return reply.code(204).send();
  });

  app.post("/api/profile-apply/preview", async (request) => {
    const body = ApplyBodySchema.pick({ profileId: true, projectPath: true }).parse(request.body);
    return profiles.previewApply(body.profileId, body.projectPath);
  });

  app.post("/api/profile-apply", async (request) => {
    const body = ApplyBodySchema.parse(request.body);
    return profiles.applyProfile(body.profileId, body.projectPath, body);
  });

  app.post("/api/profile-deactivate", async (request, reply) => {
    const body = z.object({ projectPath: z.string() }).parse(request.body);
    await profiles.deactivate(body.projectPath);
    return reply.code(204).send();
  });

  app.post("/api/profile-launch", async (request) => {
    const body = ApplyBodySchema.parse(request.body);
    return profiles.launch(body.profileId, body.projectPath, body);
  });

  app.get("/api/import/scan", async (request) => {
    const query = z.object({ projectPath: z.string().optional() }).parse(request.query);
    return profiles.scanImport(query.projectPath);
  });

  app.get("/api/import/scan-folder", async (request) => {
    const query = z.object({
      folderPath: z.string().min(1),
      includeGlobal: z.enum(["true", "false"]).optional()
    }).parse(request.query);
    return profiles.scanFolder(query.folderPath, query.includeGlobal !== "false");
  });

  app.post("/api/import/catalog", async (request) => {
    const body = CatalogImportBodySchema.parse(request.body);
    return profiles.commitCatalogImport(body.candidateIds);
  });

  app.post("/api/import/commit", async (request) => {
    const body = ImportCommitBodySchema.parse(request.body);
    return profiles.commitImport(body.candidateIds, body.profileName);
  });

  const clientDist = path.join(__dirname, "..", "client");
  if (fs.existsSync(clientDist)) {
    app.register(fastifyStatic, {
      root: clientDist,
      prefix: "/",
      decorateReply: false
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api")) {
        return reply.code(404).send({ error: "Not found" });
      }
      if (request.url.includes(".")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "Not found" }));
  }

  app.setErrorHandler((err, _request, reply) => {
    const status = reply.statusCode && reply.statusCode >= 400 ? reply.statusCode : 500;
    const message = err instanceof Error ? err.message : "Unexpected error";
    reply.code(status).send({
      error: message
    });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const ctx = createRuntimeContext();
  migrateLegacyAppDir(ctx)
    .then(() => buildServer(ctx).listen({ host: "127.0.0.1", port }))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}

function isLocalOrigin(value: string | string[]): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  try {
    const url = new URL(raw);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
