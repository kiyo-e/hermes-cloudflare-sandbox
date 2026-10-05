import type { ExecRequest, InstanceType, Settings, WorkspaceConfig } from "./contracts.js";

export const MAX_BODY_BYTES = 1_048_576;
export const MAX_COMMAND_BYTES = 65_536;
export const MAX_TIMEOUT_SECONDS = 900;
export const MAX_OUTPUT_CHARS = 2_000_000;
export const INSTANCES = new Set<InstanceType>(["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"]);
export const REQUEST_ID = /^[a-f0-9]{32}$/;
export const SANDBOX_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const encoder = new TextEncoder();

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  // Never expose provider exception objects, request bodies, or credentials.
  return json({ error: { code: "internal_error", message: "Sandbox operation failed" } }, 503);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new ApiError(415, "content_type", "Send application/json");
  }
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", "Request exceeds 1 MiB");
  if (!request.body) throw new ApiError(400, "invalid_json", "Missing JSON body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "payload_too_large", "Request exceeds 1 MiB");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Expected a JSON object");
  }
}

function text(value: unknown, name: string, maxBytes: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.includes("\0")
      || encoder.encode(value).length > maxBytes) {
    throw new ApiError(400, "invalid_field", `Invalid ${name}`);
  }
  return value;
}

function knownKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ApiError(400, "unknown_field", "Request contains an unsupported field");
  }
}

export function workspaceConfig(data: Record<string, unknown>, settings: Settings): WorkspaceConfig {
  knownKeys(data, ["persistent", "cwd", "image", "instance"]);
  if (typeof data.persistent !== "boolean") throw new ApiError(400, "invalid_field", "persistent must be boolean");
  const cwd = text(data.cwd ?? "/workspace", "cwd", 4096);
  if (!cwd.startsWith("/")) throw new ApiError(400, "invalid_field", "cwd must be absolute");
  const image = text(data.image ?? "hermes", "image", 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(image)) throw new ApiError(400, "invalid_field", "Invalid named image");
  const instance = text(data.instance ?? settings.DEFAULT_INSTANCE_TYPE ?? "standard-1", "instance", 32) as InstanceType;
  const allowed = new Set((settings.ALLOWED_INSTANCE_TYPES ?? "lite,standard-1").split(",").map(s => s.trim()));
  if (!INSTANCES.has(instance) || !allowed.has(instance)) {
    throw new ApiError(400, "instance_not_allowed", "Requested instance is not enabled by the operator");
  }
  return { persistent: data.persistent, cwd, image, instance };
}

export function execRequest(data: Record<string, unknown>): ExecRequest {
  knownKeys(data, ["request_id", "command", "timeout", "login", "stdin"]);
  const request_id = text(data.request_id, "request_id", 32);
  if (!REQUEST_ID.test(request_id)) throw new ApiError(400, "invalid_field", "Invalid request_id");
  const command = text(data.command, "command", MAX_COMMAND_BYTES, true);
  const timeout = data.timeout ?? 120;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0.1 || timeout > MAX_TIMEOUT_SECONDS) {
    throw new ApiError(400, "invalid_timeout", `timeout must be between 0.1 and ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  const login = data.login ?? false;
  if (typeof login !== "boolean") throw new ApiError(400, "invalid_field", "login must be boolean");
  const stdin = data.stdin == null ? null : text(data.stdin, "stdin", 786_432, true);
  return { request_id, command, timeout, login, stdin };
}

export async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 32 || /\s/.test(secret)) {
    throw new ApiError(503, "not_configured", "Set the SANDBOX_API_TOKEN Worker secret");
  }
  const supplied = request.headers.get("authorization") ?? "";
  if (supplied.length > 4096) return false;
  // Compare fixed-length SHA-256 digests, not variable-length token strings.
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${secret}`)),
  ]);
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}
