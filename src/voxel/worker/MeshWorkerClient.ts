import type { CornerDir, FaceDir, MeshBlockDescriptorEntry } from "../mesh/NaiveMesher.js";
import type { MeshClient, MeshOutcome, MeshWorkerResponse } from "./MeshWorkerProtocol.js";

/**
 * M1 production `MeshClient`. Spawns the dedicated mesh worker via Vite's module-worker pattern
 * (`new Worker(new URL(...), { type: "module" })`); Vite bundles `mesh.worker.ts` as a separate
 * chunk for both dev and build. Promises resolve per request id; results are structured-cloned
 * typed arrays (see `MeshWorkerProtocol` for the documented M1 simplifications: no explicit
 * transferables, single worker instance). SINGLE-WORKER transport: the M7 production path is
 * `MeshWorkerPoolClient` (N arenas of the same worker + same protocol); this class remains the
 * documented single-arena fallback and the fixed transport for `?workers=1`.
 */
export class MeshWorkerClient implements MeshClient {
  private readonly _worker: Worker;
  private readonly _pending = new Map<
    number,
    | { kind: "data"; resolve: (v: Uint8Array) => void; reject: (r: unknown) => void }
    | { kind: "mesh"; resolve: (v: MeshOutcome) => void; reject: (r: unknown) => void }
  >();
  private _nextId: number = 1;

  constructor() {
    this._worker = new Worker(new URL("./mesh.worker.ts", import.meta.url), { type: "module" });
    this._worker.onmessage = (e: MessageEvent<MeshWorkerResponse>): void => this._onMessage(e.data);
    this._worker.onerror = (): void => this._rejectAll("mesh worker crashed");
  }

  public configure(seed: number, descriptor: readonly MeshBlockDescriptorEntry[]): void {
    this._worker.postMessage({ kind: "init", seed, descriptor });
  }

  public generate(cx: number, cz: number): Promise<Uint8Array> {
    const id = this._nextId++;
    return new Promise<Uint8Array>((resolve, reject) => {
      this._pending.set(id, { kind: "data", resolve, reject });
      this._worker.postMessage({ kind: "generate", id, cx, cz });
    });
  }

  public mesh(
    cx: number,
    cz: number,
    voxels: Uint8Array,
    neighbors: Partial<Record<FaceDir, Uint8Array>>,
    neighborCorners?: Partial<Record<CornerDir, Uint8Array>>,
    useGreedy: boolean = true,
  ): Promise<MeshOutcome> {
    const id = this._nextId++;
    return new Promise<MeshOutcome>((resolve, reject) => {
      this._pending.set(id, { kind: "mesh", resolve, reject });
      this._worker.postMessage({
        kind: "mesh",
        id,
        cx,
        cz,
        voxels,
        neighbors,
        neighborCorners,
        useGreedy,
      });
    });
  }

  public destroy(): void {
    this._worker.terminate();
    this._rejectAll("mesh worker destroyed");
  }

  private _onMessage(msg: MeshWorkerResponse): void {
    const pending = this._pending.get(msg.id);
    if (!pending) return; // stale/unknown id (e.g. worker crashed mid-batch)
    this._pending.delete(msg.id);
    switch (msg.kind) {
      case "data":
        // `pending.kind` is "data" whenever the response is a generated buffer.
        (pending as { kind: "data"; resolve: (v: Uint8Array) => void }).resolve(msg.voxels);
        break;
      case "mesh-result":
        (pending as { kind: "mesh"; resolve: (v: MeshOutcome) => void }).resolve(msg.outcome);
        break;
      case "error":
        pending.reject(new Error(`[mesh] ${msg.message}`));
        break;
    }
  }

  private _rejectAll(reason: string): void {
    for (const pending of Array.from(this._pending.values())) {
      pending.reject(new Error(reason));
    }
    this._pending.clear();
  }
}
