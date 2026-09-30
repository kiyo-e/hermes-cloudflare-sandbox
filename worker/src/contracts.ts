/** Narrow runtime ports used by the testable coordinator, not a replacement SDK.
 * The production entry point passes the real ctx.container and ctx.storage.
 * `npm run typecheck` additionally checks these ports against wrangler types.
 */
export type InstanceType = "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
export interface ProcessPort {
  stdin: WritableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exitCode: Promise<number>;
  kill(signal?: number): void;
}
export interface ContainerPort<Snapshot = unknown, Image = string> {
  readonly running: boolean;
  readonly images: Record<string, Image>;
  // Mirrors Cloudflare's ContainerStartupOptions: image and containerSnapshot are mutually exclusive.
  start(options: {
    instance?: InstanceType;
    enableInternet: boolean;
  } & ({ image: Image; containerSnapshot?: never } | { image?: never; containerSnapshot?: Snapshot })): void;
  exec(command: string[], options?: {
    stdin?: "pipe";
    stdout?: "pipe" | "ignore";
    stderr?: "combined" | "ignore" | "pipe";
    cwd?: string;
  }): Promise<ProcessPort>;
  snapshotContainer(options: { name?: string }): Promise<Snapshot>;
  destroy(reason?: string): Promise<void>;
  setInactivityTimeout(milliseconds: number): Promise<void>;
}
export interface StoragePort {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface Settings {
  SANDBOX_API_TOKEN?: string;
  DEFAULT_INSTANCE_TYPE?: string;
  ALLOWED_INSTANCE_TYPES?: string;
  ENABLE_INTERNET?: string;
  IDLE_SECONDS?: string;
}
export interface WorkspaceConfig {
  persistent: boolean;
  cwd: string;
  image: string;
  instance: InstanceType;
}
export interface ExecRequest {
  request_id: string;
  command: string;
  timeout: number;
  login: boolean;
  stdin: string | null;
}
