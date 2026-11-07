import type { CornerDir, FaceDir, MeshBlockDescriptorEntry } from "../mesh/NaiveMesher.js";
import { buildMesh } from "../mesh/NaiveMesher.js";
import { buildGreedyMesh } from "../mesh/GreedyMesher.js";
import { TerrainGenerator } from "../TerrainGenerator.js";
import type { MeshClient, MeshOutcome } from "./MeshWorkerProtocol.js";

/**
 * Synchronous test/fallback implementation of `MeshClient` (node tests have no `Worker`, and a
 * graceful fallback is useful if worker construction ever fails). It runs the EXACT same pure
 * code paths the worker runs -- `TerrainGenerator.generateColumn` and `buildMesh` -- so a test
 * against this double is a test of the real worker logic, minus the message transport.
 */
export class ForegroundMeshClient implements MeshClient {
  private _generator: TerrainGenerator | null = null;
  private _descriptor: readonly MeshBlockDescriptorEntry[] = [];

  public configure(seed: number, descriptor: readonly MeshBlockDescriptorEntry[]): void {
    this._generator = new TerrainGenerator({ seed });
    this._descriptor = descriptor;
  }

  public async generate(cx: number, cz: number): Promise<Uint8Array> {
    const generator = this._generator;
    if (!generator)
      throw new Error("[ForegroundMeshClient] configure() must run before generate()");
    // M1 world is a single vertical column per (cx, cz); cy is always 0.
    return generator.generateColumn(cx, 0, cz);
  }

  public async mesh(
    _cx: number,
    _cz: number,
    voxels: Uint8Array,
    neighbors: Partial<Record<FaceDir, Uint8Array>>,
    neighborCorners?: Partial<Record<CornerDir, Uint8Array>>,
    useGreedy: boolean = true,
  ): Promise<MeshOutcome> {
    if (!this._descriptor.length) {
      throw new Error("[ForegroundMeshClient] configure() must run before mesh()");
    }
    const meshFn = useGreedy ? buildGreedyMesh : buildMesh;
    const mesh = neighborCorners
      ? meshFn({ voxels, descriptor: this._descriptor, neighbors, neighborCorners })
      : meshFn({ voxels, descriptor: this._descriptor, neighbors });
    return { mesh, meshMs: 0 }; // foreground runs on the caller thread -- no worker time to report
  }

  public destroy(): void {
    this._generator = null;
    this._descriptor = [];
  }
}
