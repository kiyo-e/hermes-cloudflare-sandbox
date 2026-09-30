import test from "node:test";
import assert from "node:assert/strict";
import { SandboxService } from "../dist-test/service.js";
import { MAX_OUTPUT_CHARS } from "../dist-test/protocol.js";
import { MemoryStorage, FakeContainer, SETTINGS, request, execution, collect, completedProcess, pendingProcess } from "./fakes.mjs";

async function setup(persistent = true) {
  const container = new FakeContainer(), storage = new MemoryStorage();
  const service = new SandboxService(container, storage, SETTINGS);
  const response = await service.fetch(request("init", { persistent, cwd: "/workspace", image: "hermes" }));
  assert.equal(response.status, 200);
  return { service, container, storage };
}

async function execute(service, input = execution()) {
  const response = await service.fetch(request("exec", input));
  assert.equal(response.status, 200);
  return collect(response);
}

test("configuration does not boot compute", async () => {
  const { container } = await setup();
  assert.equal(container.running, false);
  assert.equal(container.starts.length, 0);
});

test("cold start uses named image and explicit network policy", async () => {
  const { service, container } = await setup();
  const events = await execute(service);
  assert.deepEqual(container.starts[0], { image: "sha256:example-image", instance: "standard-1", enableInternet: true });
  assert.equal(events.at(-1).exit_code, 0);
  assert.equal(events.filter(e => e.type === "output").map(e => e.data).join(""), "hello\n");
  const run = container.commands.find(c => c.command[0].includes("hermes-exec"));
  assert.deepEqual(run.options, { cwd: "/workspace", stdout: "pipe", stderr: "combined" });
  assert.equal(run.options.env, undefined);
});

test("nonzero command exit is not an infrastructure error", async () => {
  const { service, container } = await setup();
  container.processes.push(completedProcess("failure\n", 42));
  const events = await execute(service);
  assert.deepEqual(events.at(-1), { type: "exit", exit_code: 42 });
});

test("stdin travels through native stdin without shell interpolation", async () => {
  const { service, container } = await setup();
  const text = "日本語\n$(echo unsafe)\r\nno-final-newline";
  const process = completedProcess();
  container.processes.push(process);
  await execute(service, execution({ command: "cat", stdin: text }));
  assert.equal(new TextDecoder().decode(process.stdinChunks[0]), text);
});

test("Unicode code points survive byte and JSON frame boundaries", async () => {
  const { service, container } = await setup();
  const text = "a".repeat(4095) + "🚀日本語".repeat(2000);
  container.processes.push(completedProcess(text, 0, 65_536));
  const events = await execute(service);
  assert.equal(events.filter(e => e.type === "output").map(e => e.data).join(""), text);
  for (const event of events.filter(e => e.type === "output")) {
    assert.equal(event.data.isWellFormed(), true);
  }
});

test("snapshot is persisted before destroy; restore omits image", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  const originalDestroy = container.destroy.bind(container);
  container.destroy = async reason => {
    assert.ok(await storage.get("snapshot"));
    return originalDestroy(reason);
  };
  assert.equal((await service.fetch(request("release"))).status, 200);
  assert.equal(container.running, false);
  assert.equal(storage.alarm, null);
  // Simulate DO eviction: reconstruct the JS coordinator with durable state.
  const revived = new SandboxService(container, storage, SETTINGS);
  await execute(revived);
  assert.ok(container.starts[1].containerSnapshot);
  assert.equal("image" in container.starts[1], false);
});

test("snapshot failure preserves the live filesystem and schedules retry", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  container.failSnapshot = true;
  assert.equal((await service.fetch(request("release"))).status, 503);
  assert.equal(container.running, true);
  assert.equal(container.log.includes("destroy"), false);
  assert.ok(storage.alarm > Date.now());
});

test("snapshot handle storage failure also prevents destroy", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  storage.failSnapshotPut = true;
  assert.equal((await service.fetch(request("release"))).status, 503);
  assert.equal(container.running, true);
  assert.equal(container.log.includes("destroy"), false);
});

test("ephemeral release destroys and forgets state without a snapshot", async () => {
  const { service, container, storage } = await setup(false);
  await execute(service);
  assert.equal((await service.fetch(request("release"))).status, 200);
  assert.equal(container.running, false);
  assert.equal(container.log.includes("snapshot"), false);
  assert.equal(storage.data.size, 0);
});

test("lost filesystem fails closed instead of starting an empty replacement", async () => {
  const { service, container } = await setup();
  await execute(service);
  container.running = false; // Simulate a crash before the first checkpoint.
  const events = await execute(service);
  assert.equal(events.at(-1).code, "workspace_lost");
  assert.equal(container.starts.length, 1);
});

test("stored workspace configuration cannot be silently replaced", async () => {
  const { service } = await setup();
  const response = await service.fetch(request("init", { persistent: false, cwd: "/workspace" }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "config_conflict");
});

test("unknown named images are rejected without running compute", async () => {
  const container = new FakeContainer(), storage = new MemoryStorage();
  const service = new SandboxService(container, storage, SETTINGS);
  assert.equal((await service.fetch(request("init", { persistent: true, image: "missing" }))).status, 400);
  assert.equal(container.starts.length, 0);
});

test("duplicate command identifier is not executed twice", async () => {
  const { service, container } = await setup();
  const input = execution();
  await execute(service, input);
  const response = await service.fetch(request("exec", input));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "duplicate_request");
  assert.equal(container.commands.filter(c => c.command[0].includes("hermes-exec")).length, 1);
});

test("concurrent execute and release are rejected while command is active", async () => {
  const { service, container } = await setup();
  const pending = pendingProcess();
  container.processes.push(pending);
  const first = await service.fetch(request("exec", execution()));
  assert.equal((await service.fetch(request("exec", execution()))).status, 409);
  assert.equal((await service.fetch(request("release"))).status, 409);
  pending.finish(0);
  await collect(first);
});

test("cancel can race ahead of exec", async () => {
  const { service, container } = await setup();
  const input = execution();
  await service.fetch(request(`cancel/${input.request_id}`));
  const response = await service.fetch(request("exec", input));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "command_cancelled");
  assert.equal(container.starts.length, 0);
});

test("cancel signals only the matching active process", async () => {
  const { service, container } = await setup();
  const pending = pendingProcess();
  container.processes.push(pending);
  const input = execution();
  const response = await service.fetch(request("exec", input));
  const reader = response.body.getReader();
  await reader.read(); // started event => native process exists
  await service.fetch(request(`cancel/${"0".repeat(32)}`));
  assert.equal(pending.signals.length, 0);
  await service.fetch(request(`cancel/${input.request_id}`));
  while (!(await reader.read()).done) {}
  assert.deepEqual(pending.signals, [15]);
});

test("output cap is a failure, never truncated successful file data", async () => {
  const { service, container } = await setup();
  container.processes.push(completedProcess("x".repeat(MAX_OUTPUT_CHARS + 1)));
  const events = await execute(service);
  assert.equal(events.at(-1).code, "output_limit");
  assert.equal(events.some(e => e.type === "exit"), false);
});

test("idle alarm checkpoints and stops persistent workspaces", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  await storage.put("lastActivity", Date.now() - 700_000);
  await service.alarm();
  assert.equal(container.running, false);
  assert.ok(await storage.get("snapshot"));
});

test("recent activity reschedules the alarm without destroying compute", async () => {
  const { service, container } = await setup();
  await execute(service);
  await service.alarm();
  assert.equal(container.running, true);
});

test("delete requires explicit confirmation", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  assert.equal((await service.fetch(request("reset", {}, "DELETE"))).status, 400);
  assert.equal(container.running, true);
  assert.equal((await service.fetch(request("reset", { confirm: true }, "DELETE"))).status, 200);
  assert.equal(container.running, false);
  assert.equal(storage.data.size, 0);
});

test("hard deadline also bounds a hanging native process-start request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, container } = await setup();
  const original = container.exec.bind(container);
  let pendingStart = false;
  container.exec = async (command, options) => {
    if (command[0] === "/usr/local/bin/hermes-exec") {
      pendingStart = true;
      return new Promise(() => {});
    }
    return original(command, options);
  };
  const response = await service.fetch(request("exec", execution({ timeout: 0.1 })));
  const result = collect(response);
  for (let i = 0; i < 20 && !pendingStart; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(pendingStart, true);
  t.mock.timers.tick(5101);
  const events = await result;
  assert.equal(events.at(-1).code, "hard_timeout");
  assert.equal(container.running, false);
  assert.equal(events.some(e => e.type === "exit"), false);
});
