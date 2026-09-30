import test from "node:test";
import assert from "node:assert/strict";
import { authorized, execRequest, readJson, workspaceConfig, MAX_BODY_BYTES } from "../dist-test/protocol.js";
import { route } from "../dist-test/router.js";
import { TOKEN, SETTINGS } from "./fakes.mjs";

const req = (token = TOKEN, path = "/health", method = "GET", body) => new Request(`https://gateway.example${path}`, {
  method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("auth fails closed without configured secret", async () => {
  await assert.rejects(authorized(req(), undefined), { code: "not_configured" });
});

test("valid and invalid bearer tokens", async () => {
  assert.equal(await authorized(req(), TOKEN), true);
  assert.equal(await authorized(req("wrong"), TOKEN), false);
});

test("unauthorized request never allocates a Durable Object", async () => {
  let allocations = 0;
  const env = { ...SETTINGS, SANDBOX: { getByName() { allocations++; throw new Error(); } } };
  const response = await route(req("wrong", "/v1/sandboxes/test", "POST", {}), env);
  assert.equal(response.status, 401);
  assert.equal(allocations, 0);
});

test("authenticated health check does not start compute", async () => {
  const env = { ...SETTINGS, SANDBOX: { getByName() { throw new Error("must not allocate"); } } };
  assert.deepEqual(await (await route(req(), env)).json(), { ok: true, protocol: 1 });
});

test("forwarded DO request excludes authorization and preserves body", async () => {
  const observed = [];
  const env = { ...SETTINGS, SANDBOX: { getByName(name) { return { async fetch(request) {
    observed.push({ name, path: new URL(request.url).pathname, auth: request.headers.get("authorization"), body: await request.json() });
    return Response.json({ ok: true });
  } }; } } };
  assert.equal((await route(req(TOKEN, "/v1/sandboxes/h-test", "POST", { persistent: false }), env)).status, 200);
  assert.deepEqual(observed, [{ name: "h-test", path: "/init", auth: null, body: { persistent: false } }]);
});

test("routing rejects wrong methods and identifiers", async () => {
  const env = { ...SETTINGS, SANDBOX: { getByName() { throw new Error("unexpected allocation"); } } };
  assert.equal((await route(req(TOKEN, "/v1/sandboxes/test/exec"), env)).status, 405);
  assert.equal((await route(req(TOKEN, "/v1/sandboxes/A!"), env)).status, 404);
  assert.equal((await route(req(TOKEN, "/v1/sandboxes/test?foo=bar"), env)).status, 404);
});

test("strict payload types and deadline limits", () => {
  const valid = { request_id: "a".repeat(32), command: "echo ok", timeout: 1 };
  assert.equal(execRequest(valid).login, false);
  for (const change of [{ timeout: 0 }, { timeout: 901 }, { timeout: NaN }, { timeout: "10" },
    { command: "x\0" }, { login: "true" }, { request_id: "../../" }, { env: { TOKEN: "bad" } }]) {
    assert.throws(() => execRequest({ ...valid, ...change }));
  }
});

test("workspace policy disallows expensive and invalid instance types", () => {
  for (const instance of ["basic", "standard-4"]) {
    assert.throws(() => workspaceConfig({ persistent: true, instance }, SETTINGS));
  }
  assert.equal(workspaceConfig({ persistent: false }, SETTINGS).instance, "standard-1");
  assert.throws(() => workspaceConfig({ persistent: "false" }, SETTINGS));
  assert.throws(() => workspaceConfig({ persistent: true, cwd: "relative" }, SETTINGS));
});

test("JSON body is bounded even without Content-Length", async () => {
  await assert.rejects(readJson(new Request("https://test/", { method: "POST", headers: { "content-type": "application/json" },
    body: '"' + "x".repeat(MAX_BODY_BYTES) + '"' })), { code: "payload_too_large" });
});

test("JSON rejects primitives, invalid UTF-8 and wrong content type", async () => {
  const request = body => new Request("https://test/", { method: "POST", headers: { "content-type": "application/json" }, body });
  await assert.rejects(readJson(request("[]")), { code: "invalid_json" });
  await assert.rejects(readJson(request(new Uint8Array([255]))), { code: "invalid_json" });
  await assert.rejects(readJson(new Request("https://test/", { method: "POST", body: "{}" })), { code: "content_type" });
});
