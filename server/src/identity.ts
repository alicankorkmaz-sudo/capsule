import type { ServerIdentity } from "./types";

export function encodeIdentity(identity: ServerIdentity): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

export function decodeIdentity(id: string): ServerIdentity {
  const raw = Buffer.from(id, "base64url").toString("utf8");
  return JSON.parse(raw) as ServerIdentity;
}

export function disabledStoreKey(identity: ServerIdentity): string {
  return encodeIdentity({
    target: identity.target,
    name: identity.name,
    sourcePath: identity.sourcePath,
    scope: identity.scope,
    projectPath: identity.projectPath,
    disabled: true
  });
}
