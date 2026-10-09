import test from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { SandboxService, HARD_DEADLINE_GRACE_MS, KILL_GRACE_MS, POST_EXIT_STREAM_MS } from "../dist-test/service.js";
import { MemoryStorage, FakeContainer, SETTINGS, request, execution, collect, completedProcess } from "./fakes.mjs";

const SUPERVISOR = "/usr/local/bin/hermes-exec";
const isKill = command => command[0] === SUPERVISOR && command[1] === "--kill";
const isLaunch = command => command[0] === SUPERVISOR && command[1] === "--id";

async function setup() {
  const container = new FakeContainer(), storage = new MemoryStorage();
  const service = new SandboxService(container, storage, SETTINGS);
  const response = await service.fetch(request("init", { persistent: true, cwd: "/workspace", image: "hermes" }));
  assert.equal(response.status, 200);
  return { service, container };
}

async function settle(condition) {
  for (let i = 0; i < 50 && !condition(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(condition(), true);
}

test("supervisor is launched with the request id so it can be killed by id", async () => {
  const { service, container } = await setup();
  const input = execution();
  await collect(await service.fetch(request("exec", input)));
  const launch = container.commands.find(c => isLaunch(c.command));
  assert.deepEqual(launch.command.slice(0, 3), [SUPERVISOR, "--id", input.request_id]);
});

test("hard deadline stops only the command group and keeps the workspace", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, container } = await setup();
  const original = container.exec.bind(container);
  let pendingStart = false;
  container.exec = async (command, options) => {
    if (isLaunch(command)) { pendingStart = true; return new Promise(() => {}); }
    return original(command, options);
  };
  const input = execution({ timeout: 0.1 });
  const result = collect(await service.fetch(request("exec", input)));
  await settle(() => pendingStart);
  // The supervisor's own drain/escalation window must not be raced.
  t.mock.timers.tick(100 + HARD_DEADLINE_GRACE_MS - 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(container.commands.some(c => isKill(c.command)), false);
  t.mock.timers.tick(2);
  const events = await result;
  assert.equal(events.at(-1).code, "hard_timeout");
  assert.equal(events.some(e => e.type === "exit"), false);
  const kill = container.commands.find(c => isKill(c.command));
  assert.deepEqual(kill.command, [SUPERVISOR, "--kill", input.request_id]);
  assert.equal(container.running, true);
  assert.equal(container.log.includes("destroy"), false);
});

test("hard deadline destroys the container only when the targeted kill hangs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, container } = await setup();
  const original = container.exec.bind(container);
  let killRequested = false, launched = false;
  container.exec = async (command, options) => {
    if (isLaunch(command)) { launched = true; return new Promise(() => {}); }
    if (isKill(command)) { killRequested = true; return new Promise(() => {}); }
    return original(command, options);
  };
  const result = collect(await service.fetch(request("exec", execution({ timeout: 0.1 }))));
  await settle(() => launched);
  t.mock.timers.tick(100 + HARD_DEADLINE_GRACE_MS + 1);
  await settle(() => killRequested);
  t.mock.timers.tick(KILL_GRACE_MS + 1);
  const events = await result;
  assert.equal(events.at(-1).code, "hard_timeout");
  assert.equal(container.running, false);
});

test("hard deadline destroys the container when the kill reports failure", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, container } = await setup();
  const original = container.exec.bind(container);
  let launched = false;
  container.exec = async (command, options) => {
    if (isLaunch(command)) { launched = true; return new Promise(() => {}); }
    if (isKill(command)) return completedProcess("", 1);
    return original(command, options);
  };
  const result = collect(await service.fetch(request("exec", execution({ timeout: 0.1 }))));
  await settle(() => launched);
  t.mock.timers.tick(100 + HARD_DEADLINE_GRACE_MS + 1);
  const events = await result;
  assert.equal(events.at(-1).code, "hard_timeout");
  assert.equal(container.running, false);
});

test("an exited command whose stream never closes still returns its exit status", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { service, container } = await setup();
  const encoder = new TextEncoder();
  let cancelled = false;
  container.processes.push({
    stdin: null,
    // Output arrives, then the stream stays open (a leaked write end).
    stdout: new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode("done\n")); },
      cancel() { cancelled = true; },
    }),
    stderr: null,
    exitCode: Promise.resolve(0),
    kill() {},
  });
  const result = collect(await service.fetch(request("exec", execution({ timeout: 60 }))));
  await settle(() => container.commands.some(c => isLaunch(c.command)));
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(POST_EXIT_STREAM_MS + 1);
  const events = await result;
  assert.deepEqual(events.filter(e => e.type === "output").map(e => e.data).join(""), "done\n");
  assert.deepEqual(events.at(-1), { type: "exit", exit_code: 0 });
  assert.equal(cancelled, true);
  assert.equal(container.running, true);
  // The workspace lock is released: the next command runs.
  const next = await collect(await service.fetch(request("exec", execution())));
  assert.equal(next.at(-1).type, "exit");
});

test("post-exit backstop is shorter than the hard deadline slack", () => {
  assert.ok(POST_EXIT_STREAM_MS > 5_000, "must exceed the supervisor's own 5 s drain cap");
  assert.ok(POST_EXIT_STREAM_MS < HARD_DEADLINE_GRACE_MS);
});
