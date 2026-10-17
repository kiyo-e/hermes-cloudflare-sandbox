import test from "node:test";
import assert from "node:assert/strict";
import { SandboxService, RELEASE_MAX_FAILURES, LOST_POLL_MS, LIVENESS_INTERVAL_MS, LIVENESS_TIMEOUT_MS } from "../dist-test/service.js";
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

// Hard-deadline and stream-drain behavior: see deadline.test.mjs.

test("a re-created object re-arms the inactivity timeout of a running container", async () => {
  const { container, storage } = await setup();
  const stopped = new SandboxService(new FakeContainer(), storage, SETTINGS);
  await stopped.restoreInactivityTimeout(); // must not throw before start()
  await execute(new SandboxService(container, storage, SETTINGS));
  assert.equal(container.running, true);
  container.inactivity = undefined; // simulate the timeout lost with the old instance
  const recreated = new SandboxService(container, storage, SETTINGS);
  await recreated.restoreInactivityTimeout();
  assert.equal(container.inactivity, recreated.inactivityMs);
  assert.ok(recreated.inactivityMs > recreated.idleMs, "the alarm must checkpoint before the native stop");
});

test("an alarm for a workspace that already lost its container does not retry forever", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  container.running = false; // stopped natively before any checkpoint
  await storage.put("lastActivity", Date.now() - 700_000);
  await service.alarm(); // resolves: a thrown alarm would be retried by the platform
  assert.equal(storage.alarm, null);
  assert.ok(await storage.get("config"), "workspace metadata is kept so the loss is reported, not hidden");
});

test("a container that dies mid-command is reported as lost at once, not at the hard deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { service, container } = await setup();
  const pending = pendingProcess();
  container.processes.push(pending);
  const response = await service.fetch(request("exec", execution({ timeout: 900 })));
  const reader = response.body.getReader();
  await reader.read(); // started
  container.running = false; // e.g. killed for memory; the native stream never ends
  t.mock.timers.tick(LOST_POLL_MS);
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    events.push(...new TextDecoder().decode(value).trim().split("\n").map(l => JSON.parse(l)));
  }
  assert.equal(events.at(-1).code, "workspace_lost");
  assert.equal(pending.signals.length, 0, "no kill is sent to a container that is gone");
  // The workspace is free again, and the next command reports the loss immediately.
  const next = await execute(service);
  assert.equal(next.at(-1).code, "workspace_lost");
});

async function drain(reader) {
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return events;
    events.push(...new TextDecoder().decode(value).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)));
  }
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test("a container that hangs mid-command is destroyed after two unanswered probes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { service, container } = await setup();
  const pending = pendingProcess();
  container.processes.push(pending);
  const response = await service.fetch(request("exec", execution({ timeout: 900 })));
  const reader = response.body.getReader();
  await reader.read(); // started
  const original = container.exec.bind(container);
  container.exec = async (command, options) =>
    command[0] === "/bin/true" ? new Promise(() => {}) : original(command, options); // hung
  // Advance one second at a time so timers created inside callbacks run in order.
  const advance = async ms => { for (let i = 0; i < ms / 1000; i++) { t.mock.timers.tick(1000); await flush(); } };
  await advance(LIVENESS_INTERVAL_MS + LIVENESS_TIMEOUT_MS + 1000);
  assert.equal(container.log.includes("destroy"), false, "one miss is not enough");
  await advance(LIVENESS_INTERVAL_MS + LIVENESS_TIMEOUT_MS);
  assert.equal(container.log.includes("destroy"), true, "two misses in a row destroy the container");
  const events = await drain(reader);
  assert.equal(events.at(-1).code, "workspace_lost");
});

test("a busy but responsive container is never destroyed by the liveness probe", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { service, container } = await setup();
  const pending = pendingProcess();
  container.processes.push(pending);
  const response = await service.fetch(request("exec", execution({ timeout: 900 })));
  const reader = response.body.getReader();
  await reader.read();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(LIVENESS_INTERVAL_MS); await flush(); }
  assert.equal(container.log.includes("destroy"), false);
  assert.ok(container.commands.filter(c => c.command[0] === "/bin/true").length >= 5);
  pending.finish(0);
  const events = await drain(reader);
  assert.equal(events.at(-1).type, "exit");
});

test("an idle workspace is not probed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { service, container } = await setup();
  await execute(service);
  const probes = container.commands.filter(c => c.command[0] === "/bin/true").length;
  t.mock.timers.tick(LIVENESS_INTERVAL_MS * 5);
  await flush();
  assert.equal(container.commands.filter(c => c.command[0] === "/bin/true").length, probes);
});

// --- a release that keeps failing must not lock the workspace ---
async function idle(storage) { await storage.put("lastActivity", Date.now() - 3_600_000); }

test("init during a failing idle save records activity instead of 409, and keeps compute", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  await idle(storage);
  container.failSnapshot = true;
  let open; container.snapshotGate = new Promise(r => { open = r; });
  const alarm = service.alarm().catch(() => {});
  await new Promise(r => setTimeout(r, 5));
  const init = await service.fetch(request("init", { persistent: true, cwd: "/workspace", image: "hermes" }));
  assert.equal(init.status, 200);
  assert.equal((await init.json()).saving, true);
  open(); await alarm;
  assert.equal(container.running, true);
  container.snapshotGate = null;
  await service.alarm(); // activity is recent: no new save attempt
  assert.equal(container.log.filter(x => x === "snapshot").length, 1);
});

test("reset is accepted while a save is in flight, and the late save does not bring the files back", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  await idle(storage);
  container.failSnapshot = true;
  container.snapshotError = "internal error; reference = 9lhele873oj7v9v9g7ckui53";
  await service.alarm().catch(() => {});
  container.failSnapshot = false;
  let open; container.snapshotGate = new Promise(r => { open = r; });
  await idle(storage);
  const alarm = service.alarm().catch(() => {});
  await new Promise(r => setTimeout(r, 5));
  // A reset is the way out of a wedged workspace: it must not wait for the save.
  const res = await service.fetch(request("reset", { confirm: true }, "DELETE"));
  assert.equal(res.status, 200);
  assert.equal(container.running, false);
  open(); await alarm;
  assert.equal(await storage.get("snapshot"), undefined, "a late save must not resurrect the discarded files");
  assert.equal(await storage.get("config"), undefined);
  assert.equal(await storage.get("releaseFailures"), undefined);
  assert.equal(storage.alarm, null);
  // The same id starts fresh from the image.
  assert.equal((await service.fetch(request("init", { persistent: true, cwd: "/workspace", image: "hermes" }))).status, 200);
  assert.equal((await execute(service)).at(-1).type, "exit");
  assert.equal(container.starts.at(-1).image, "sha256:example-image");
});

test("a busy answer during a failing save still carries the failure count and reference", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  await idle(storage);
  container.failSnapshot = true;
  container.snapshotError = "internal error; reference = 9lhele873oj7v9v9g7ckui53";
  await service.alarm().catch(() => {});
  let open; container.snapshotGate = new Promise(r => { open = r; });
  await idle(storage);
  const alarm = service.alarm().catch(() => {});
  await new Promise(r => setTimeout(r, 5));
  const res = await service.fetch(request("checkpoint"));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "workspace_saving");
  assert.equal(body.error.release_failures, 1);
  assert.equal(body.error.reference, "9lhele873oj7v9v9g7ckui53");
  open(); await alarm;
  const status = await (await service.fetch(request("status", {}, "GET"))).json();
  assert.equal(status.release_failures, 2);
});

test("after RELEASE_MAX_FAILURES the alarm backs off to the idle period and keeps compute alive", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  container.failSnapshot = true;
  for (let i = 0; i < RELEASE_MAX_FAILURES; i++) { await idle(storage); await service.alarm().catch(() => {}); }
  assert.equal(container.running, true);
  assert.equal(container.log.includes("destroy"), false);
  assert.ok(storage.alarm - Date.now() > 60_000 * 2, "no more 60 s retries");
  assert.ok(container.inactivity > service.idleMs, "native stop pushed past the next try");
  container.failSnapshot = false;
  await idle(storage); await service.alarm();
  assert.equal(container.running, false);
  assert.equal(await storage.get("releaseFailures"), undefined);
});

// --- saves racing with commands, storage and timeout failures ---
test("after init during a hanging save, exec runs, and the finished save does not stop compute", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  await idle(storage);
  let open; container.snapshotGate = new Promise(r => { open = r; });
  const alarm = service.alarm().catch(() => {});
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await service.fetch(request("init", { persistent: true, cwd: "/workspace", image: "hermes" }))).status, 200);
  const events = await execute(service);
  assert.equal(events.at(-1).type, "exit");
  open(); await alarm;
  assert.equal(container.running, true, "activity came in during the save: compute stays");
  assert.ok(await storage.get("snapshot"), "the snapshot is still kept");
});

test("a failed save whose retry alarm cannot be set rethrows (platform retry keeps compute safe)", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  await idle(storage);
  container.failSnapshot = true;
  storage.failSetAlarm = true;
  await assert.rejects(service.alarm());
  assert.equal(container.running, true);
});

test("releasing is cleared even when reading the failure record throws", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  storage.failGet = "releaseFailures";
  assert.equal((await service.fetch(request("release"))).status, 503);
  storage.failGet = null;
  const events = await execute(service);
  assert.equal(events.at(-1).type, "exit");
});

test("if the long inactivity timeout cannot be set, retries stay at one minute", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  container.failSnapshot = true;
  container.failInactivity = true;
  for (let i = 0; i < RELEASE_MAX_FAILURES; i++) { await idle(storage); await service.alarm().catch(() => {}); }
  assert.ok(storage.alarm - Date.now() <= 60_000);
});

test("a re-created object restores the long inactivity timeout after repeated failures", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  container.failSnapshot = true;
  for (let i = 0; i < RELEASE_MAX_FAILURES; i++) { await idle(storage); await service.alarm().catch(() => {}); }
  const recreated = new SandboxService(container, storage, SETTINGS);
  container.inactivity = 0;
  await recreated.restoreInactivityTimeout();
  assert.ok(container.inactivity > recreated.inactivityMs);
});

test("once the save decided to stop compute, a new command is refused with workspace_saving", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  await idle(storage);
  let open; container.destroyGate = new Promise(r => { open = r; });
  const alarm = service.alarm().catch(() => {});
  while (!container.log.includes("destroy")) await new Promise(r => setTimeout(r, 1));
  const res = await service.fetch(request("exec", execution()));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "workspace_saving");
  open(); await alarm;
});

// --- a wedged container: reset always gets through, and the error says so ---
test("reset is accepted while a command hangs, and the command ends as lost", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { service, container, storage } = await setup();
  container.processes.push(pendingProcess());
  const response = await service.fetch(request("exec", execution({ timeout: 900 })));
  const reader = response.body.getReader();
  await reader.read(); // started
  const reset = await service.fetch(request("reset", { confirm: true }, "DELETE"));
  assert.equal(reset.status, 200);
  t.mock.timers.tick(LOST_POLL_MS);
  const events = await drain(reader);
  assert.equal(events.at(-1).code, "workspace_lost");
  assert.equal(await storage.get("config"), undefined);
  assert.equal((await service.fetch(request("init", { persistent: true, cwd: "/workspace", image: "hermes" }))).status, 200);
  t.mock.timers.reset();
  assert.equal((await execute(service)).at(-1).type, "exit");
  assert.equal(container.starts.at(-1).image, "sha256:example-image");
});

test("a running container that stops answering is reported as unresponsive, not as a slow start", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { service, container } = await setup();
  await execute(service);
  assert.equal(container.running, true);
  const original = container.exec.bind(container);
  container.exec = async (command, options) =>
    command[0] === "/bin/true" ? new Promise(() => {}) : original(command, options);
  const result = collect(await service.fetch(request("exec", execution())));
  for (let i = 0; i < 70; i++) { t.mock.timers.tick(1000); await flush(); }
  const events = await result;
  assert.equal(events.at(-1).code, "workspace_unresponsive");
  assert.equal(container.commands.filter(c => c.command[0] === "/usr/local/bin/hermes-exec").length, 1, "only the first command ran");
});

test("a cold start that never becomes ready is still a startup timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { service, container } = await setup();
  container.failProbe = Infinity;
  const result = collect(await service.fetch(request("exec", execution())));
  for (let i = 0; i < 70; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.equal((await result).at(-1).code, "startup_timeout");
});

test("a save whose sync outlives a reset does not touch the next workspace with the same id", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  await idle(storage);
  const original = container.exec.bind(container);
  let finishSync;
  container.exec = async (command, options) => {
    if (command[0] === "/bin/sync" && !finishSync) {
      return { ...completedProcess(), exitCode: new Promise(r => { finishSync = () => r(0); }) };
    }
    return original(command, options);
  };
  const alarm = service.alarm().catch(() => {});
  await new Promise(r => setTimeout(r, 5));
  assert.equal(typeof finishSync, "function", "the save waits on sync");
  assert.equal((await service.fetch(request("reset", { confirm: true }, "DELETE"))).status, 200);
  assert.equal((await service.fetch(request("init", { persistent: true, cwd: "/workspace", image: "hermes" }))).status, 200);
  assert.equal((await execute(service)).at(-1).type, "exit");
  const snapshots = container.log.filter(x => x === "snapshot").length;
  finishSync(); await alarm;
  assert.equal(container.running, true, "the fresh container is not stopped by the old save");
  assert.equal(container.log.filter(x => x === "snapshot").length, snapshots, "the old save takes no snapshot");
  assert.equal(await storage.get("snapshot"), undefined);
});

test("a liveness probe that outlives its command does not destroy the workspace", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { service, container } = await setup();
  const pending = pendingProcess();
  container.processes.push(pending);
  const response = await service.fetch(request("exec", execution({ timeout: 900 })));
  const reader = response.body.getReader();
  await reader.read(); // started
  const original = container.exec.bind(container);
  container.exec = async (command, options) =>
    command[0] === "/bin/true" ? new Promise(() => {}) : original(command, options); // probes hang
  const advance = async ms => { for (let i = 0; i < ms / 1000; i++) { t.mock.timers.tick(1000); await flush(); } };
  await advance(LIVENESS_INTERVAL_MS + LIVENESS_TIMEOUT_MS + 1000); // first miss
  await advance(LIVENESS_INTERVAL_MS - LIVENESS_TIMEOUT_MS); // second probe in flight
  pending.finish(0); // the command ends while that probe still waits
  const events = await drain(reader);
  assert.equal(events.at(-1).type, "exit");
  await advance(LIVENESS_TIMEOUT_MS + 1000); // the stale probe gives up
  assert.equal(container.log.includes("destroy"), false, "a finished command's probe must not destroy the workspace");
  assert.equal(container.running, true);
});

test("a reset whose destroy fails keeps the workspace record and reports the failure", async () => {
  const { service, container, storage } = await setup();
  await execute(service);
  container.destroy = async () => { throw new Error("destroy failed"); }; // container keeps running
  const res = await service.fetch(request("reset", { confirm: true }, "DELETE"));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "reset_failed");
  assert.ok(await storage.get("config"), "not forgotten while the old container still runs");
  // A retry is accepted (not busy) and completes once destroy works.
  container.destroy = FakeContainer.prototype.destroy.bind(container);
  assert.equal((await service.fetch(request("reset", { confirm: true }, "DELETE"))).status, 200);
  assert.equal(container.running, false);
  assert.equal(await storage.get("config"), undefined);
});

test("a container that stops during the readiness wait is not called unresponsive", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { service, container } = await setup();
  await execute(service);
  const original = container.exec.bind(container);
  let probes = 0;
  container.exec = async (command, options) => {
    if (command[0] === "/bin/true") { if (++probes === 3) container.running = false; throw new Error("not ready"); }
    return original(command, options);
  };
  const result = collect(await service.fetch(request("exec", execution())));
  for (let i = 0; i < 70; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.notEqual((await result).at(-1).code, "workspace_unresponsive");
});
