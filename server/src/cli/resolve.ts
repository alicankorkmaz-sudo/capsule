import type { McpManager } from "../manager";
import type { ProfileManager } from "../profileManager";
import { decodeIdentity } from "../identity";

export async function resolveServerId(
  manager: McpManager,
  ref: string,
  projectPath?: string
): Promise<string> {
  if (isEncodedServerId(ref)) return ref;
  const records = await manager.listServers(projectPath);
  const matches = records.filter((record) => record.name === ref);
  if (!matches.length) throw new Error(`MCP server not found: ${ref}`);
  if (matches.length > 1) {
    const lines = matches.map((match) => `  ${match.label}: ${match.id}`);
    throw new Error(`Multiple servers named "${ref}". Use an id instead:\n${lines.join("\n")}`);
  }
  return matches[0].id;
}

export async function resolveCapabilityId(profiles: ProfileManager, ref: string): Promise<string> {
  const capabilities = await profiles.listCapabilities();
  if (capabilities.some((capability) => capability.id === ref)) return ref;
  const normalized = ref.trim().toLowerCase();
  const matches = capabilities.filter((capability) => capability.name.toLowerCase() === normalized);
  if (!matches.length) throw new Error(`Capability not found: ${ref}`);
  if (matches.length > 1) {
    const lines = matches.map((match) => `  ${match.kind}: ${match.id}`);
    throw new Error(`Multiple capabilities named "${ref}". Use an id instead:\n${lines.join("\n")}`);
  }
  return matches[0].id;
}

function isEncodedServerId(ref: string): boolean {
  try {
    const identity = decodeIdentity(ref);
    return Boolean(identity && typeof identity === "object" && identity.target && identity.name);
  } catch {
    return false;
  }
}
