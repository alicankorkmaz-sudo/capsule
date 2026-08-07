import type {
  ApplyPreview,
  BackupEntry,
  Capability,
  CapabilityKind,
  ImportCandidate,
  LaunchResult,
  Profile,
  ProfileOverview,
  ProjectAssignment,
  ProjectEntry,
  ServerRecord,
  TargetKey,
  TargetStatus
} from "./types";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "X-Capsule": "1"
};

export async function getTargets(projectPath?: string): Promise<TargetStatus[]> {
  return apiGet(`/api/targets${query({ projectPath })}`);
}

export async function getServers(projectPath?: string): Promise<ServerRecord[]> {
  return apiGet(`/api/servers${query({ projectPath })}`);
}

export async function getProjects(): Promise<ProjectEntry[]> {
  return apiGet("/api/projects");
}

export async function getServer(id: string, raw = false): Promise<ServerRecord> {
  return apiGet(`/api/servers/${encodeURIComponent(id)}${query({ raw: raw ? "true" : undefined })}`);
}

export async function addServer(input: {
  targets: TargetKey[];
  name: string;
  config: unknown;
  projectPath?: string;
  allowElevated?: boolean;
}): Promise<ServerRecord[]> {
  return apiJson("/api/servers", "POST", input);
}

export async function patchServer(
  id: string,
  input: {
    name?: string;
    config?: unknown;
    enabled?: boolean;
    projectPath?: string;
    allowElevated?: boolean;
  }
): Promise<ServerRecord[]> {
  return apiJson(`/api/servers/${encodeURIComponent(id)}`, "PATCH", input);
}

export async function moveServer(
  id: string,
  input: {
    target: TargetKey;
    name?: string;
    projectPath?: string;
    allowElevated?: boolean;
  }
): Promise<ServerRecord[]> {
  return apiJson(`/api/servers/${encodeURIComponent(id)}/move`, "POST", input);
}

export async function copyServer(
  id: string,
  input: {
    target: TargetKey;
    name?: string;
    projectPath?: string;
    allowElevated?: boolean;
  }
): Promise<ServerRecord[]> {
  return apiJson(`/api/servers/${encodeURIComponent(id)}/copy`, "POST", input);
}

export async function copyServers(input: {
  ids: string[];
  target: TargetKey;
  projectPath?: string;
  allowElevated?: boolean;
}): Promise<ServerRecord[]> {
  let result: ServerRecord[] = [];
  for (const id of input.ids) {
    result = await copyServer(id, {
      target: input.target,
      projectPath: input.projectPath,
      allowElevated: input.allowElevated
    });
  }
  return result;
}

export async function moveServers(input: {
  ids: string[];
  target: TargetKey;
  projectPath?: string;
  allowElevated?: boolean;
}): Promise<ServerRecord[]> {
  let result: ServerRecord[] = [];
  for (const id of input.ids) {
    result = await moveServer(id, {
      target: input.target,
      projectPath: input.projectPath,
      allowElevated: input.allowElevated
    });
  }
  return result;
}

export async function deleteServer(id: string, allowElevated?: boolean): Promise<ServerRecord[]> {
  return apiJson(`/api/servers/${encodeURIComponent(id)}`, "DELETE", { allowElevated });
}

export async function getBackups(): Promise<BackupEntry[]> {
  return apiGet("/api/backups");
}

export async function restoreBackup(id: string, allowElevated?: boolean): Promise<void> {
  await apiJson(`/api/backups/${encodeURIComponent(id)}/restore`, "POST", { allowElevated });
}

export async function restoreBackupGroup(id: string, allowElevated?: boolean): Promise<void> {
  await apiJson(`/api/backup-groups/${encodeURIComponent(id)}/restore`, "POST", { allowElevated });
}

export async function validateConfig(config: unknown): Promise<void> {
  await apiJson("/api/validate", "POST", { config });
}

export async function getProfileOverview(projectPath?: string): Promise<ProfileOverview> {
  return apiGet(`/api/profile-overview${query({ projectPath })}`);
}

export async function getCapability(id: string, raw = false): Promise<Capability> {
  return apiGet(`/api/catalog/${encodeURIComponent(id)}${query({ raw: raw ? "true" : undefined })}`);
}

export async function createCapability(input: CapabilityDraft): Promise<Capability> {
  return apiJson("/api/catalog", "POST", input);
}

export async function updateCapability(id: string, input: Partial<CapabilityDraft>): Promise<Capability> {
  return apiJson(`/api/catalog/${encodeURIComponent(id)}`, "PATCH", input);
}

export async function removeCapability(id: string): Promise<void> {
  return apiJson(`/api/catalog/${encodeURIComponent(id)}`, "DELETE", {});
}

export async function syncInstalledPlugins(): Promise<Capability[]> {
  return apiJson("/api/catalog/plugins/sync", "POST", {});
}

export async function forkPlugin(id: string, name?: string): Promise<Capability> {
  return apiJson(`/api/catalog/plugins/${encodeURIComponent(id)}/fork`, "POST", { name });
}

export async function getPluginFiles(id: string): Promise<string[]> {
  return apiGet(`/api/catalog/plugins/${encodeURIComponent(id)}/files`);
}

export async function getPluginFile(id: string, path: string): Promise<string> {
  const result = await apiGet<{ content: string }>(
    `/api/catalog/plugins/${encodeURIComponent(id)}/file${query({ path })}`
  );
  return result.content;
}

export async function savePluginFile(id: string, path: string, content: string): Promise<void> {
  return apiJson(`/api/catalog/plugins/${encodeURIComponent(id)}/file`, "PUT", { path, content });
}

export async function removePluginFile(id: string, path: string): Promise<void> {
  return apiJson(`/api/catalog/plugins/${encodeURIComponent(id)}/file`, "DELETE", { path });
}

export async function validatePlugin(id: string): Promise<{ ok: boolean; output: string }> {
  return apiJson(`/api/catalog/plugins/${encodeURIComponent(id)}/validate`, "POST", {});
}

export async function createProfile(input: ProfileDraft): Promise<Profile> {
  return apiJson("/api/profiles", "POST", input);
}

export async function updateProfile(id: string, input: Partial<ProfileDraft>): Promise<Profile> {
  return apiJson(`/api/profiles/${encodeURIComponent(id)}`, "PATCH", input);
}

export async function removeProfile(id: string): Promise<void> {
  return apiJson(`/api/profiles/${encodeURIComponent(id)}`, "DELETE", {});
}

export async function previewProfile(profileId: string, projectPath: string): Promise<ApplyPreview> {
  return apiJson("/api/profile-apply/preview", "POST", { profileId, projectPath });
}

export async function applyProfile(
  profileId: string,
  projectPath: string,
  options: { confirmOwnership?: boolean; force?: boolean } = {}
): Promise<ProjectAssignment> {
  return apiJson("/api/profile-apply", "POST", { profileId, projectPath, ...options });
}

export async function deactivateProfile(projectPath: string): Promise<void> {
  return apiJson("/api/profile-deactivate", "POST", { projectPath });
}

export async function launchProfile(
  profileId: string,
  projectPath: string,
  options: { confirmOwnership?: boolean; force?: boolean; dryRun?: boolean } = {}
): Promise<LaunchResult> {
  return apiJson("/api/profile-launch", "POST", { profileId, projectPath, ...options });
}

export async function scanImport(projectPath?: string): Promise<ImportCandidate[]> {
  return apiGet(`/api/import/scan${query({ projectPath })}`);
}

export async function scanImportFolder(folderPath: string, includeGlobal = true): Promise<ImportCandidate[]> {
  return apiGet(`/api/import/scan-folder${query({ folderPath, includeGlobal: String(includeGlobal) })}`);
}

export async function commitCatalogImport(candidateIds: string[]): Promise<Capability[]> {
  return apiJson("/api/import/catalog", "POST", { candidateIds });
}

export async function commitImport(candidateIds: string[], profileName = "Work"): Promise<Profile> {
  return apiJson("/api/import/commit", "POST", { candidateIds, profileName });
}

export interface CapabilityDraft {
  kind: CapabilityKind;
  name: string;
  description?: string;
  config?: unknown;
  pluginId?: string;
  installPath?: string;
  version?: string;
  scope?: string;
  rootPath?: string;
  content?: string;
  files?: Record<string, string>;
  event?: string;
  matcher?: string;
  handlers?: unknown[];
}

export interface ProfileDraft {
  name: string;
  description?: string;
  capabilityIds?: string[];
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return readResponse(response);
}

async function apiJson<T>(url: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: JSON_HEADERS,
    body: JSON.stringify(body)
  });
  return readResponse(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const value = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(value?.error || value?.errors?.join(", ") || response.statusText);
  }
  return value as T;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
