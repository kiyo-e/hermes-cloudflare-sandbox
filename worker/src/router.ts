import type { Settings } from "./contracts.js";
import { ApiError, authorized, errorResponse, json, SANDBOX_ID } from "./protocol.js";

export interface GatewayEnv extends Settings {
  SANDBOX: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
}

export async function route(request: Request, env: GatewayEnv): Promise<Response> {
  try {
    // Authenticate before allocating a Durable Object or parsing a request body.
    if (!await authorized(request, env.SANDBOX_API_TOKEN)) {
      return json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
    }
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, protocol: 1 }); // Deliberately does not start compute.
    }
    const match = /^\/v1\/sandboxes\/([^/]+)(?:\/(exec|read|release|checkpoint|cancel\/([a-f0-9]{32})))?$/.exec(url.pathname);
    if (!match || !SANDBOX_ID.test(match[1]) || url.search) throw new ApiError(404, "not_found", "Not found");
    const action = match[2] ?? (request.method === "GET" ? "status" : request.method === "DELETE" ? "reset" : "init");
    const expected = action === "status" ? "GET" : action === "reset" ? "DELETE" : "POST";
    if (request.method !== expected) throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const headers = new Headers();
    if (request.headers.has("content-type")) headers.set("content-type", request.headers.get("content-type")!);
    if (request.headers.has("content-length")) headers.set("content-length", request.headers.get("content-length")!);
    const init = {
      method: request.method, headers, body: request.body,
      duplex: "half" as const, // Required by Node tests; ignored by Workers.
    };
    const internal = new Request(`https://sandbox.internal/${action}`, init);
    return await env.SANDBOX.getByName(match[1]).fetch(internal);
  } catch (error) {
    return errorResponse(error);
  }
}
