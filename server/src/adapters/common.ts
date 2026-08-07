import type {
  McpServerConfig,
  ServerIdentity,
  ServerRecord,
  TargetKey,
  Transport
} from "../types";
import { MASK, McpServerConfigSchema } from "../types";
import { encodeIdentity } from "../identity";
import { labelForTarget } from "../paths";

const SECRET_KEY_RE = /(token|secret|password|passwd|pwd|api[_-]?key|auth|credential|private|p8)/i;
const HEADER_CONTAINER_RE = /^(headers|http_headers)$/i;

export function determineTransport(config: Record<string, unknown>): Transport {
  const type = config.type;
  if (type === "streamable-http" || type === "http") return "http";
  if (type === "sse") return "sse";
  if (type === "ws") return "ws";
  if (type === "stdio") return "stdio";
  if (typeof config.url === "string") return "http";
  if (typeof config.command === "string") return "stdio";
  return "unknown";
}

export function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

export function makeRecord(
  target: TargetKey,
  identity: Omit<ServerIdentity, "target">,
  config: Record<string, unknown>,
  enabled: boolean,
  managedDisable: ServerRecord["managedDisable"]
): ServerRecord {
  const fullIdentity: ServerIdentity = { target, ...identity };
  const parsed = McpServerConfigSchema.safeParse(config);
  return {
    ...fullIdentity,
    id: encodeIdentity(fullIdentity),
    label: labelForTarget(target),
    transport: determineTransport(config),
    enabled,
    disabled: !enabled,
    config: redactConfig(config),
    validationErrors: parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
    managedDisable
  };
}

export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  return redactValue(config, undefined) as Record<string, unknown>;
}

export function normalizeForCodex(config: McpServerConfig): Record<string, unknown> {
  const next = toRecord(config);
  const type = next.type;
  if (type === "sse" || type === "ws") {
    throw new Error("Codex supports STDIO and Streamable HTTP MCP servers in config.toml.");
  }
  if (isRecord(next.headers) && !next.http_headers) {
    next.http_headers = next.headers;
  }
  delete next.headers;
  delete next.type;
  return next;
}

export function normalizeForClaude(config: McpServerConfig): Record<string, unknown> {
  const next = toRecord(config);
  if (isRecord(next.http_headers) && !next.headers) {
    next.headers = next.http_headers;
  }
  delete next.http_headers;
  delete next.env_http_headers;
  delete next.bearer_token_env_var;
  delete next.enabled;
  if (typeof next.url === "string" && !next.type) {
    next.type = "http";
  }
  if (typeof next.command === "string" && !next.type) {
    next.type = "stdio";
  }
  return next;
}

export function assertUniqueName(
  servers: Record<string, unknown>,
  name: string,
  previousName?: string
): void {
  if (name !== previousName && Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new Error(`An MCP server named "${name}" already exists in this target.`);
  }
}

export function reservedClaudeName(name: string): boolean {
  return new Set(["workspace", "claude-in-chrome", "computer-use", "Claude Preview", "Claude Browser"]).has(
    name
  );
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string") {
    return key && SECRET_KEY_RE.test(key) ? MASK : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, key));
  }
  if (isRecord(value)) {
    const headerContainer = key ? HEADER_CONTAINER_RE.test(key) : false;
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] =
        headerContainer && typeof childValue === "string"
          ? MASK
          : redactValue(childValue, childKey);
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
