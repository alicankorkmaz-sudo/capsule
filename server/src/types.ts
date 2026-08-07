import { z } from "zod";

export const MASK = "••••••••";

export const TargetKeySchema = z.enum([
  "codex",
  "codex-project",
  "claude-desktop",
  "claude-code-user",
  "claude-code-local",
  "claude-code-project"
]);

export type TargetKey = z.infer<typeof TargetKeySchema>;

export type Transport = "stdio" | "http" | "sse" | "ws" | "unknown";

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema)
  ])
);

export const McpServerConfigSchema = z
  .object({
    type: z
      .enum(["stdio", "http", "streamable-http", "sse", "ws"])
      .optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    env_vars: z.array(z.union([z.string(), z.record(JsonValueSchema)])).optional(),
    cwd: z.string().optional(),
    url: z.string().min(1).optional(),
    headers: z.record(z.string()).optional(),
    http_headers: z.record(z.string()).optional(),
    env_http_headers: z.record(z.string()).optional(),
    bearer_token_env_var: z.string().optional(),
    startup_timeout_sec: z.number().int().positive().optional(),
    tool_timeout_sec: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    required: z.boolean().optional(),
    enabled_tools: z.array(z.string()).optional(),
    disabled_tools: z.array(z.string()).optional(),
    default_tools_approval_mode: z
      .enum(["auto", "prompt", "writes", "approve"])
      .optional()
  })
  .catchall(JsonValueSchema)
  .superRefine((value, ctx) => {
    const hasCommand = typeof value.command === "string" && value.command.length > 0;
    const hasUrl = typeof value.url === "string" && value.url.length > 0;
    if (!hasCommand && !hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP server config needs either a command or a url."
      });
    }
    if (hasCommand && hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose either command or url for one MCP server, not both."
      });
    }
  });

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const ServerNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, hyphens, or underscores.");

export interface RuntimeContext {
  homeDir: string;
  cwd: string;
  appDir: string;
  projectsDir: string;
}

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface TargetStatus {
  key: TargetKey;
  label: string;
  scope: string;
  path: string;
  exists: boolean;
  writable: boolean;
  error?: string;
}

export interface ServerIdentity {
  target: TargetKey;
  name: string;
  sourcePath: string;
  scope: string;
  projectPath?: string;
  disabled?: boolean;
}

export interface ServerRecord extends ServerIdentity {
  id: string;
  label: string;
  transport: Transport;
  enabled: boolean;
  disabled: boolean;
  config: Record<string, unknown>;
  validationErrors: string[];
  managedDisable: "native" | "app-store" | "claude-project-settings";
}

export interface DisabledEntry extends ServerIdentity {
  disabled: true;
  disabledAt: string;
  config: Record<string, unknown>;
  label: string;
}

export interface DisabledStore {
  version: 1;
  entries: Record<string, DisabledEntry>;
}

export interface BackupEntry {
  id: string;
  groupId?: string;
  createdAt: string;
  sourcePath: string;
  reason: string;
  existed: boolean;
  contentBase64?: string;
}

export const CapabilityKindSchema = z.enum([
  "mcp",
  "installed-plugin",
  "custom-plugin",
  "skill",
  "hook",
  "instruction"
]);

export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

export const HookHandlerSchema = z
  .object({
    type: z.enum(["command", "prompt", "agent", "http", "mcp_tool"])
  })
  .catchall(JsonValueSchema);

export interface CapabilityBase {
  id: string;
  kind: CapabilityKind;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpCapability extends CapabilityBase {
  kind: "mcp";
  config: Record<string, unknown>;
}

export interface InstalledPluginCapability extends CapabilityBase {
  kind: "installed-plugin";
  pluginId: string;
  version?: string;
  installPath: string;
  scope?: string;
}

export interface CustomPluginCapability extends CapabilityBase {
  kind: "custom-plugin";
  rootPath: string;
}

export interface SkillCapability extends CapabilityBase {
  kind: "skill";
  content: string;
  files?: Record<string, string>;
}

export interface HookCapability extends CapabilityBase {
  kind: "hook";
  event: string;
  matcher?: string;
  handlers: Array<Record<string, unknown>>;
}

export interface InstructionCapability extends CapabilityBase {
  kind: "instruction";
  content: string;
}

export type Capability =
  | McpCapability
  | InstalledPluginCapability
  | CustomPluginCapability
  | SkillCapability
  | HookCapability
  | InstructionCapability;

export interface Profile {
  id: string;
  name: string;
  description?: string;
  capabilityIds: string[];
  system?: "vanilla";
  createdAt: string;
  updatedAt: string;
}

export type AssignmentState = "pending" | "applied" | "drifted";

export interface ProjectAssignment {
  projectPath: string;
  profileId: string;
  appliedHash?: string;
  state: AssignmentState;
  originalBackupIds?: string[];
  updatedAt: string;
}

export interface ProfileStore {
  version: 1;
  capabilities: Record<string, Capability>;
  profiles: Record<string, Profile>;
  assignments: Record<string, ProjectAssignment>;
}

export interface InstalledPlugin {
  id: string;
  version?: string;
  scope?: string;
  enabled: boolean;
  installPath: string;
}

export interface CompiledProfile {
  profile: Profile;
  settings: Record<string, unknown>;
  instructions: string;
  mcpConfig: { mcpServers: Record<string, Record<string, unknown>> };
  pluginDirs: string[];
  syntheticPluginDir?: string;
  warnings: string[];
}
