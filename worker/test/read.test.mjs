import test from "node:test";
import assert from "node:assert/strict";
import { SandboxService } from "../dist-test/service.js";
import { MemoryStorage, FakeContainer, SETTINGS, request } from "./fakes.mjs";

async function setup() {
  const container = new FakeContainer(), storage = new MemoryStorage();
  const service = new SandboxService(container, storage, SETTINGS);
  assert.equal((await service.fetch(request("init", { persistent: true, cwd: "/workspace", image: "hermes" }))).status, 200);
  return { service, container };
}

test("read streams raw bytes beyond the exec output limit and releases the workspace", async () => {
  const { service, container } = await setup();
  const bytes = new Uint8Array(5 * 1024 * 1024 + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  container.files["/workspace/big.bin"] = bytes;
  const response = await service.fetch(request("read", { path: "/workspace/big.bin", max_bytes: 26_214_400 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-file-size"), String(bytes.length));
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  // The lock is free again: a command can run right after.
  const again = await service.fetch(request("read", { path: "/workspace/big.bin" }));
  assert.equal(again.status, 200);
  assert.equal((await again.arrayBuffer()).byteLength, bytes.length);
});

test("read refuses an oversized file before reading it", async () => {
  const { service, container } = await setup();
  container.files["/workspace/huge.bin"] = 30 * 1024 * 1024;
  const response = await service.fetch(request("read", { path: "/workspace/huge.bin", max_bytes: 26_214_400 }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "file_too_large");
  assert.equal(container.readers.length, 0);
  assert.equal((await service.fetch(request("read", { path: "/workspace/missing" }))).status, 404);
});

test("read rejects relative paths and unknown fields", async () => {
  const { service } = await setup();
  assert.equal((await service.fetch(request("read", { path: "big.bin" }))).status, 400);
  assert.equal((await service.fetch(request("read", { path: "/a", offset: 1 }))).status, 400);
});

test("a cancelled read stops cat and frees the workspace", async () => {
  const { service, container } = await setup();
  container.files["/workspace/a.bin"] = new Uint8Array(200_000);
  const response = await service.fetch(request("read", { path: "/workspace/a.bin" }));
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.deepEqual(container.readers[0].killed, [15]);
  const again = await service.fetch(request("read", { path: "/workspace/a.bin" }));
  assert.equal(again.status, 200);
  await again.arrayBuffer();
});

test("a file that shrinks while it is read errors instead of ending short", async () => {
  const { service, container } = await setup();
  container.files["/workspace/a.bin"] = new Uint8Array(10);
  const exec = container.exec.bind(container);
  container.exec = async (command, options) => {
    const process = await exec(command, options);
    if (command[0] === "/usr/bin/stat") container.files["/workspace/a.bin"] = new Uint8Array(4);
    return process;
  };
  const response = await service.fetch(request("read", { path: "/workspace/a.bin" }));
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer());
});
