import { ReadableStream, WritableStream } from "node:stream/web";

const encoder = new TextEncoder();
export const TOKEN = "test-token-".repeat(5);
export const SETTINGS = { SANDBOX_API_TOKEN: TOKEN, ENABLE_INTERNET: "true" };

export class MemoryStorage {
  data = new Map();
  log = [];
  alarm = null;
  failSnapshotPut = false;
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) {
    this.log.push(`put:${key}`);
    if (key === "snapshot" && this.failSnapshotPut) throw new Error("storage unavailable");
    this.data.set(key, structuredClone(value));
  }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  async deleteAll() { this.data.clear(); }
}

export function completedProcess(text = "", code = 0, split = 8192) {
  const bytes = encoder.encode(text);
  const stdinChunks = [];
  return {
    stdinChunks,
    stdin: new WritableStream({ write(chunk) { stdinChunks.push(chunk); } }),
    stdout: new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
      controller.close();
    } }),
    stderr: null,
    exitCode: Promise.resolve(code),
    kill() {},
  };
}

export function pendingProcess() {
  let finish;
  let controller;
  const signals = [];
  let closed = false;
  const done = code => {
    if (!closed) { closed = true; controller.close(); finish(code); }
  };
  return {
    signals,
    stdin: null,
    stdout: new ReadableStream({ start(c) { controller = c; } }),
    stderr: null,
    exitCode: new Promise(resolve => { finish = resolve; }),
    kill(signal) { signals.push(signal); done(128 + signal); },
    finish: done,
  };
}

export class FakeContainer {
  running = false;
  images = { hermes: "sha256:example-image" };
  log = [];
  starts = [];
  commands = [];
  processes = [];
  failSnapshot = false;
  failProbe = 0;
  stdin = null;
  onSnapshot = null;
  async setInactivityTimeout(ms) { this.inactivity = ms; }
  start(options) { this.starts.push(options); this.log.push("start"); this.running = true; }
  async exec(command, options) {
    this.commands.push({ command, options });
    if (!this.running) throw new Error("container not running");
    if (command[0] === "/bin/true" && this.failProbe-- > 0) throw new Error("not ready");
    if (command[0] !== "/usr/local/bin/hermes-exec") return completedProcess();
    const process = this.processes.shift() ?? completedProcess("hello\n");
    this.stdin = process.stdinChunks;
    return process;
  }
  async snapshotContainer(options) {
    this.log.push("snapshot");
    this.onSnapshot?.();
    if (this.failSnapshot) throw new Error("snapshot failed");
    return { id: "opaque-snapshot", name: options.name };
  }
  async destroy(reason) { this.log.push("destroy"); this.reason = reason; this.running = false; }
}

export const request = (action, body = {}, method = "POST") => new Request(`https://internal/${action}`, {
  method, headers: { "Content-Type": "application/json" },
  ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
});
export const execution = (overrides = {}) => ({
  request_id: crypto.randomUUID().replaceAll("-", ""), command: "printf hello", timeout: 5,
  login: false, stdin: null, ...overrides,
});
export async function collect(response) {
  const text = await response.text();
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
