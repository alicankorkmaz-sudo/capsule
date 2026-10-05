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
  /** Size of the saved file contents. */
  bytes?: number;
  /** An original that deactivation restores; pruning never deletes it. */
  protected?: boolean;
}

export interface PruneBackupsResult {
  dryRun: boolean;
  keep: number;
  olderThanDays?: number;
  scanned: number;
  deletedCount: number;
  keptCount: number;
  protectedCount: number;
  bytesFreed: number;
  splitGroups: string[];
  unreadable: string[];
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
  sourcePath?: string;
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
  /** Parent profile ids; their capabilities are inherited before this profile's own. */
  extends?: string[];
  /** Resolved inherited + own capabilities, as listed by the overview. */
  effectiveCapabilityIds?: string[];
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
  warnings?: string[];
}

export type LaunchTarget = "claude" | "codex";

export type DoctorSeverity = "error" | "warn" | "info";

export interface DoctorIssue {
  severity: DoctorSeverity;
  code: string;
  capabilityId?: string;
  profileId?: string;
  projectPath?: string;
  message: string;
  hint: string;
}

export type CapabilitySyncStatus = "updated" | "unchanged" | "missing" | "unlinked" | "failed";

export interface CapabilitySyncResult {
  id: string;
  kind: CapabilityKind;
  name: string;
  sourcePath?: string;
  status: CapabilitySyncStatus;
  /** What differs from the stored snapshot: "content", "+file", "-file", "~file". */
  changes: string[];
  warnings: string[];
  error?: string;
}

export interface LaunchResult {
  launched: boolean;
  command: string;
  args: string[];
  warnings: string[];
}
