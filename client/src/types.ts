export type TargetKey =
  | "codex"
  | "codex-project"
  | "claude-desktop"
  | "claude-code-user"
  | "claude-code-local"
  | "claude-code-project";

export interface TargetStatus {
  key: TargetKey;
  label: string;
  scope: string;
  path: string;
  exists: boolean;
  writable: boolean;
  error?: string;
}

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface ServerRecord {
  id: string;
  target: TargetKey;
  label: string;
  scope: string;
  sourcePath: string;
  projectPath?: string;
  name: string;
  transport: "stdio" | "http" | "sse" | "ws" | "unknown";
  enabled: boolean;
  disabled: boolean;
  config: Record<string, unknown>;
  validationErrors: string[];
  managedDisable: "native" | "app-store" | "claude-project-settings";
}

export interface BackupEntry {
  id: string;
  groupId?: string;
  createdAt: string;
  sourcePath: string;
  reason: string;
  existed: boolean;
}

export type CapabilityKind =
  | "mcp"
  | "installed-plugin"
  | "custom-plugin"
  | "skill"
  | "hook"
  | "instruction";

export interface Capability {
  id: string;
  kind: CapabilityKind;
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  pluginId?: string;
  installPath?: string;
  version?: string;
  scope?: string;
  rootPath?: string;
  content?: string;
  files?: Record<string, string>;
  event?: string;
  matcher?: string;
  handlers?: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface Profile {
  id: string;
  name: string;
  description?: string;
  capabilityIds: string[];
  system?: "vanilla";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAssignment {
  projectPath: string;
  profileId: string;
  appliedHash?: string;
  state: "pending" | "applied" | "drifted";
  originalBackupIds?: string[];
  updatedAt: string;
}

export interface ProfileOverview {
  capabilities: Capability[];
  profiles: Profile[];
  assignments: ProjectAssignment[];
  selectedAssignment?: ProjectAssignment;
}

export interface ApplyPreview {
  projectPath: string;
  profile: Profile;
  settingsPath: string;
  instructionsPath: string;
  needsOwnershipConfirmation: boolean;
  drifted: boolean;
  warnings: string[];
  outputs: { settings: string; instructions: string; mcp: string };
}

export interface ImportCandidate {
  id: string;
  kind: CapabilityKind;
  name: string;
  sourcePath: string;
  summary?: string;
}

export interface LaunchResult {
  launched: boolean;
  command: string;
  args: string[];
  warnings: string[];
}
