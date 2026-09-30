import { DurableObject } from "cloudflare:workers";
import { route } from "./router.js";
import { SandboxService } from "./service.js";
import type { Settings } from "./contracts.js";

export interface Env extends Settings {
  SANDBOX: DurableObjectNamespace<HermesSandbox>;
}

type NativeContainer = NonNullable<DurableObjectState["container"]>;
type NativeSnapshot = Awaited<ReturnType<NativeContainer["snapshotContainer"]>>;
type NativeImage = NativeContainer["images"][string];

export class HermesSandbox extends DurableObject<Env> {
  private service: SandboxService<NativeSnapshot, NativeImage>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("HermesSandbox requires a Container binding");
    // This assignment is checked against the real API by `wrangler types` + tsc.
    this.service = new SandboxService<NativeSnapshot, NativeImage>(ctx.container, ctx.storage, env);
    // Do not call setInactivityTimeout here: the native API rejects it until the
    // container has been started. ensureRunning() sets it right after start().
  }

  fetch(request: Request): Promise<Response> { return this.service.fetch(request); }
  alarm(): Promise<void> { return this.service.alarm(); }
}

export default { fetch: (request: Request, env: Env) => route(request, env) };
