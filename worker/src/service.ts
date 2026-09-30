import type { ContainerPort, ExecRequest, ProcessPort, Settings, StoragePort, WorkspaceConfig } from "./contracts.js";
import { ApiError, errorResponse, execRequest, json, MAX_OUTPUT_CHARS, readJson, REQUEST_ID, workspaceConfig } from "./protocol.js";

const encoder = new TextEncoder();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const STARTUP_MS = 60_000;
const GRACE_MS = 5_000;
// The supervisor needs up to ~4 s to escalate a timeout and up to 5 s to drain a
// noisy background job after a normal exit; the hard stop must not race either.
export const HARD_DEADLINE_GRACE_MS = 15_000;
// hermes-exec closes its stdout at most DRAIN_GRACE (5 s) after Bash exits. This is
// the Worker-side backstop if a stream is still open well after the exit status.
export const POST_EXIT_STREAM_MS = 7_000;
const SUPERVISOR = "/usr/local/bin/hermes-exec";

/** Reject with `error` if `operation` has not settled within `ms`. */
async function bounded<T>(operation: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error()), Math.max(1, ms)); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

interface ActiveCommand {
  id: string;
  cancelled: boolean;
  process?: ProcessPort;
}
interface SnapshotRecord<S> { handle: S; savedAt: number }

/** One durable workspace, with at most one foreground command at a time.
 * The container itself contains no gateway token or Cloudflare account key.
 */
export class SandboxService<S = unknown, I = string> {
  readonly inactivityMs: number;
  readonly idleMs: number;
  private active: ActiveCommand | null = null;
  private lifecycleBusy = false;

  constructor(private container: ContainerPort<S, I>, private storage: StoragePort,
              private settings: Settings) {
    const idle = Number(settings.IDLE_SECONDS ?? "600");
    if (!Number.isInteger(idle) || idle < 60 || idle > 18_000) {
      throw new Error("IDLE_SECONDS must be an integer from 60 to 18000");
    }
    this.idleMs = idle * 1000;
    // Alarm saves first; native timeout is a later failsafe, not the saving mechanism.
    this.inactivityMs = this.idleMs + 300_000;
  }

  private async touch(): Promise<void> {
    await this.storage.put("lastActivity", Date.now());
    await this.storage.setAlarm(Date.now() + this.idleMs);
  }

  private async config(): Promise<WorkspaceConfig> {
    const value = await this.storage.get<WorkspaceConfig>("config");
    if (!value) throw new ApiError(404, "workspace_missing", "Initialize the workspace first");
    return value;
  }

  private assertIdle(): void {
    if (this.active || this.lifecycleBusy) throw new ApiError(409, "workspace_busy", "Workspace is busy");
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.assertIdle();
    this.lifecycleBusy = true;
    try { return await fn(); }
    finally { this.lifecycleBusy = false; }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const action = new URL(request.url).pathname.slice(1);
      if (action === "status") {
        const config = await this.config();
        const snapshot = await this.storage.get<SnapshotRecord<S>>("snapshot");
        return json({ config, running: this.container.running, busy: !!this.active || this.lifecycleBusy,
                      snapshot_saved_at: snapshot?.savedAt ?? null });
      }
      const body = await readJson(request);
      if (action === "init") {
        const config = workspaceConfig(body, this.settings);
        return await this.exclusive(async () => {
          if (!Object.prototype.hasOwnProperty.call(this.container.images, config.image)) {
            throw new ApiError(400, "image_not_found", "Named image was not deployed");
          }
          const existing = await this.storage.get<WorkspaceConfig>("config");
          if (existing && JSON.stringify(existing) !== JSON.stringify(config)) {
            throw new ApiError(409, "config_conflict", "Existing workspace has different settings; use a new identity");
          }
          if (!existing) await this.storage.put("config", config);
          await this.touch();
          return json({ ok: true, running: this.container.running });
        });
      }
      if (action === "exec") return await this.execute(execRequest(body));
      if (action.startsWith("cancel/")) {
        const id = action.slice(7);
        if (!REQUEST_ID.test(id)) throw new ApiError(400, "invalid_field", "Invalid request_id");
        return await this.cancel(id);
      }
      if (action === "release") {
        return await this.exclusive(async () => { await this.release(); return json({ ok: true }); });
      }
      if (action === "checkpoint") {
        return await this.exclusive(async () => {
          const config = await this.config();
          if (!config.persistent) throw new ApiError(409, "not_persistent", "Workspace is ephemeral");
          await this.save();
          await this.touch();
          return json({ ok: true });
        });
      }
      if (action === "reset") {
        if (body.confirm !== true) throw new ApiError(400, "confirmation_required", "Send confirm: true to discard the workspace");
        return await this.exclusive(async () => {
          await this.container.destroy("Explicit workspace deletion");
          await this.storage.deleteAlarm();
          await this.storage.deleteAll();
          return json({ ok: true });
        });
      }
      throw new ApiError(404, "not_found", "Not found");
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async ensureRunning(config: WorkspaceConfig): Promise<void> {
    if (!this.container.running) {
      const snapshot = await this.storage.get<SnapshotRecord<S>>("snapshot");
      const booted = await this.storage.get<boolean>("booted");
      if (booted && !snapshot) {
        // Never silently replace a lost working filesystem with an empty image.
        throw new ApiError(409, "workspace_lost", "No checkpoint exists for the stopped workspace; use a new identity");
      }
      const common = { instance: config.instance, enableInternet: this.settings.ENABLE_INTERNET === "true" };
      if (snapshot) {
        // image and containerSnapshot are mutually exclusive.
        this.container.start({ ...common, containerSnapshot: snapshot.handle });
      } else {
        const image = this.container.images[config.image];
        if (image === undefined) throw new ApiError(400, "image_not_found", "Named image is unavailable");
        this.container.start({ ...common, image });
      }
      await this.container.setInactivityTimeout(this.inactivityMs);
      await this.storage.put("booted", true);
    }
    // Only a side-effect-free readiness probe is retried, never the user's command.
    const deadline = Date.now() + STARTUP_MS;
    // Bound native calls too: a hanging exec/exitCode must not keep heartbeats alive forever.
    const withinStartup = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ApiError(503, "startup_timeout", "Container did not become ready")),
                               Math.max(1, deadline - Date.now()));
          }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    };
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const probe = await withinStartup(this.container.exec(["/bin/true"], { stdout: "ignore", stderr: "ignore" }));
        if (await withinStartup(probe.exitCode) === 0) { ready = true; break; }
      } catch { /* starting */ }
      await delay(100);
    }
    if (!ready) throw new ApiError(503, "startup_timeout", "Container did not become ready");
    const mkdir = await withinStartup(this.container.exec(["/bin/mkdir", "-p", "--", config.cwd], { stdout: "ignore", stderr: "ignore" }));
    if (await withinStartup(mkdir.exitCode) !== 0) throw new ApiError(400, "invalid_cwd", "Working directory is not writable");
  }

  private async save(): Promise<void> {
    if (!this.container.running) {
      if (!await this.storage.get("snapshot") && await this.storage.get("booted")) {
        throw new ApiError(409, "workspace_lost", "Container stopped without a checkpoint");
      }
      return;
    }
    const sync = await this.container.exec(["/bin/sync"], { stdout: "ignore", stderr: "ignore" });
    if (await sync.exitCode !== 0) throw new ApiError(503, "snapshot_failed", "Filesystem sync failed");
    const handle = await this.container.snapshotContainer({ name: `hermes-${Date.now()}` });
    // Critical ordering: persist the opaque handle before stopping compute.
    await this.storage.put<SnapshotRecord<S>>("snapshot", { handle, savedAt: Date.now() });
  }

  private async release(): Promise<void> {
    const config = await this.storage.get<WorkspaceConfig>("config");
    if (!config) return;
    try {
      if (config.persistent) {
        await this.save();
        await this.container.destroy("Workspace checkpointed");
        await this.storage.deleteAlarm();
      } else {
        await this.container.destroy("Ephemeral workspace released");
        await this.storage.deleteAlarm();
        await this.storage.deleteAll();
      }
    } catch (error) {
      // A failed snapshot must NOT fall through to destroy(). Keep data, retry the alarm.
      await this.storage.setAlarm(Date.now() + 60_000);
      throw error;
    }
  }

  async alarm(): Promise<void> {
    if (this.active || this.lifecycleBusy) {
      await this.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    if (!await this.storage.get("config")) return;
    const last = await this.storage.get<number>("lastActivity") ?? 0;
    if (Date.now() - last < this.idleMs) {
      await this.storage.setAlarm(last + this.idleMs);
      return;
    }
    await this.exclusive(() => this.release());
  }

  private async cancel(id: string): Promise<Response> {
    // A cancellation can race ahead of the original HTTP exec request.
    const cancelled = await this.storage.get<string[]>("cancelled") ?? [];
    if (!cancelled.includes(id)) await this.storage.put("cancelled", [...cancelled.slice(-63), id]);
    if (this.active?.id === id) {
      this.active.cancelled = true;
      this.active.process?.kill(15); // supervisor forwards SIGTERM to its process group
    }
    return json({ ok: true });
  }

  private async execute(input: ExecRequest): Promise<Response> {
    this.assertIdle();
    const active: ActiveCommand = { id: input.request_id, cancelled: false };
    this.active = active; // Reserve synchronously, before any storage/startup awaits.
    try {
      const config = await this.config();
      const recent = await this.storage.get<string[]>("recentRequests") ?? [];
      const cancelled = await this.storage.get<string[]>("cancelled") ?? [];
      if (recent.includes(input.request_id)) throw new ApiError(409, "duplicate_request", "Do not replay an exec request");
      if (cancelled.includes(input.request_id)) throw new ApiError(409, "command_cancelled", "Command was cancelled before execution");
      // Durable, bounded replay guard. Not an exactly-once guarantee or an output cache.
      await this.storage.put("recentRequests", [...recent.slice(-63), input.request_id]);
      await this.touch();
      const stream = this.commandStream(active, input, config);
      return new Response(stream, { headers: {
        "Content-Type": "application/x-ndjson", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      } });
    } catch (error) {
      if (this.active === active) this.active = null;
      throw error;
    }
  }

  /** Stop one command's process group without discarding the workspace.
   * Destroys the container only if the targeted kill itself cannot run (the
   * container is wedged), because an unkillable command would otherwise hold
   * the workspace lock and keep billing indefinitely.
   */
  private async stopCommand(requestId: string, reason: string): Promise<void> {
    if (!this.container.running) return;
    try {
      const killer = await bounded(
        this.container.exec([SUPERVISOR, "--kill", requestId], { stdout: "ignore", stderr: "ignore" }),
        GRACE_MS, () => new Error("kill request hung"));
      if (await bounded(killer.exitCode, GRACE_MS, () => new Error("kill did not finish")) === 0) return;
    } catch { /* fall through to the last resort */ }
    await this.container.destroy(reason);
  }

  private commandStream(active: ActiveCommand, input: ExecRequest, config: WorkspaceConfig): ReadableStream<Uint8Array> {
    let disconnected = false;
    let wakeAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { wakeAbort = () => reject(new ApiError(499, "client_disconnected", "Client disconnected")); });
    // Mark handled immediately; it can fire before the pump reaches Promise.race.
    void aborted.catch(() => {});
    return new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false;
        const send = (event: object) => {
          if (!disconnected && !closed) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        };
        const heartbeat = setInterval(() => send({ type: "heartbeat" }), 10_000);
        let hardTimer: ReturnType<typeof setTimeout> | undefined;
        let stuckTimer: ReturnType<typeof setTimeout> | undefined;
        const pump = async () => {
          try {
            await this.ensureRunning(config);
            if (active.cancelled || disconnected) throw new ApiError(409, "command_cancelled", "Command cancelled");
            const hardDeadline = new Promise<never>((_, reject) => {
              hardTimer = setTimeout(() => {
                // Covers a hung native exec request as well as the process itself. Stop only
                // this command's process group so the workspace (and its unsaved files) survive.
                active.cancelled = true;
                const fail = () => reject(new ApiError(504, "hard_timeout", "Command stopped at hard deadline"));
                void this.stopCommand(input.request_id, "Command could not be stopped at its hard deadline").then(fail, fail);
              }, input.timeout * 1000 + HARD_DEADLINE_GRACE_MS);
            });
            const launched = this.container.exec(
              [SUPERVISOR, "--id", input.request_id, String(input.timeout), input.login ? "-lc" : "-c", input.command],
              { cwd: config.cwd, stdout: "pipe", stderr: "combined", ...(input.stdin !== null ? { stdin: "pipe" as const } : {}) },
            );
            // A late native response after cancellation must not leave a new process alive.
            void launched.then(process => {
              if (active.cancelled || disconnected) { try { process.kill(15); } catch { /* stopped */ } }
            }, () => {});
            const process = await Promise.race([launched, hardDeadline, aborted]);
            active.process = process;
            if (active.cancelled || disconnected) process.kill(15);
            send({ type: "started", request_id: input.request_id });
            const writing = (async () => {
              if (input.stdin !== null && process.stdin) {
                const writer = process.stdin.getWriter();
                try { await writer.write(encoder.encode(input.stdin)); await writer.close(); }
                catch { /* Commands may close stdin early; the command exit status is authoritative. */ }
                finally { writer.releaseLock(); }
              }
            })();
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            const reading = (async () => {
              if (!process.stdout) throw new ApiError(503, "exec_failed", "Missing stdout stream");
              reader = process.stdout.getReader();
              const decoder = new TextDecoder();
              let characters = 0;
              const output = (value: string) => {
                characters += value.length;
                if (characters > MAX_OUTPUT_CHARS) {
                  // File tools need full-fidelity data: never truncate and report success.
                  throw new ApiError(413, "output_limit", "Command output exceeded the bridge limit");
                }
                for (let i = 0; i < value.length;) {
                  let end = Math.min(i + 4096, value.length);
                  // Do not split a Unicode surrogate pair across JSON frames.
                  if (end < value.length && value.charCodeAt(end - 1) >= 0xd800
                      && value.charCodeAt(end - 1) <= 0xdbff) end--;
                  send({ type: "output", data: value.slice(i, end) });
                  i = end;
                }
              };
              try {
                while (true) {
                  const item = await reader.read();
                  if (item.done) break;
                  output(decoder.decode(item.value, { stream: true }));
                }
                output(decoder.decode());
              } finally { reader.releaseLock(); }
            })();
            void reading.catch(() => {});
            // Once the supervisor has exited, its stdout closes within its own drain cap.
            // If the native stream still does not end, stop waiting instead of hanging the
            // workspace lock until the hard deadline (the Crabbox-style bounded drain).
            const streamEnded = process.exitCode.then(async code => {
              const finished = await Promise.race([
                reading.then(() => true),
                new Promise<false>(resolve => { stuckTimer = setTimeout(() => resolve(false), POST_EXIT_STREAM_MS); }),
              ]);
              if (!finished) { try { await reader?.cancel(); } catch { /* already closed */ } }
              return code;
            });
            const results = await Promise.race([
              Promise.all([streamEnded, writing]), hardDeadline, aborted,
            ]);
            send({ type: "exit", exit_code: results[0] });
          } catch (error) {
            if (active.process) {
              try { active.process.kill(15); } catch { /* process already gone */ }
              // Kill escalation applies to failed output/streams as well as explicit cancel.
              const process = active.process;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const settled = await Promise.race([
                process.exitCode.then(() => true, () => true),
                new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), GRACE_MS); }),
              ]);
              if (timer) clearTimeout(timer);
              // Stop the recorded process group; keep the workspace unless that fails.
              if (!settled) await this.stopCommand(input.request_id, "Failed command did not terminate");
            }
            send({ type: "error", code: error instanceof ApiError ? error.code : "exec_failed" });
          } finally {
            clearInterval(heartbeat);
            if (hardTimer) clearTimeout(hardTimer);
            if (stuckTimer) clearTimeout(stuckTimer);
            if (this.active === active) this.active = null;
            try { await this.touch(); } catch { /* existing native inactivity failsafe remains */ }
            closed = true;
            if (!disconnected) controller.close();
          }
        };
        // The live response stream owns this execution, not an untracked fire-and-forget job.
        void pump().catch(() => {
          clearInterval(heartbeat);
          if (hardTimer) clearTimeout(hardTimer);
          if (this.active === active) this.active = null;
          if (!disconnected && !closed) { send({ type: "error", code: "exec_failed" }); closed = true; controller.close(); }
        });
      },
      cancel: () => {
        disconnected = true;
        active.cancelled = true;
        try { active.process?.kill(15); } catch { /* stopped */ }
        wakeAbort?.();
      },
    });
  }
}
