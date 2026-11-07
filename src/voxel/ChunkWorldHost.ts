import { Object3D } from "@small-world-machine/engine";
import type { Scene } from "@small-world-machine/engine";
import { Chunk } from "./Chunk.js";
import type { BlockMaterial } from "./material/BlockMaterial.js";
import type { VoxelMeshData } from "./mesh/NaiveMesher.js";
import { VoxelChunkGeometry } from "./mesh/VoxelChunkGeometry.js";

/**
 * App-level host glue between the pure `ChunkWorld` (lifecycle + dispatch) and the engine scene
 * (dossier §3.2 "Chunk-Object3D-Host-Verwaltung", §5 S2: main thread ONLY decides and hosts).
 *
 * The worker returns neighbour-aware mesh DATA; this class materializes it as the standard
 * "one `Object3D` per chunk" pattern (bounds, frustum culling, static draw) -- exactly the M0
 * contract, now in the streaming life of the world. The node's world origin is
 * `(cx * Chunk.SIZE, 0, cz * Chunk.SIZE)` because the mesher emits LOCAL chunk coordinates
 * (0..SIZE on X/Z). KEEP THIS CLASS THIN: all logic lives in `ChunkWorld` / the pure mesher;
 * this only turns a structured-cloned outcome into a scene node and back.
 */
export class ChunkWorldHost {
  private readonly _scene: Scene;
  private readonly _material: BlockMaterial;
  private readonly _nodes = new Map<string, Object3D>();
  private readonly _triangles = new Map<string, number>();
  private _triangleCount: number = 0;

  constructor(scene: Scene, material: BlockMaterial) {
    this._scene = scene;
    this._material = material;
  }

  /** Number of chunks currently hosted in the scene. */
  public get nodeCount(): number {
    return this._nodes.size;
  }

  /** Total triangles across all hosted chunk meshes (for the stats overlay). */
  public get triangleCount(): number {
    return this._triangleCount;
  }

  /**
   * Hosts a freshly meshed chunk. On a (cx, cz) that is already hosted the mesh REPLACES the
   * existing geometry (M2 block-edit remesh): swap the `GeometryData`, recompute bounds and
   * re-account triangles -- never mutate buffers in place (Dave-Report §2.1 swap pattern). The
   * renderer re-uploads a freshly assigned GeometryData; old GPU buffers are dropped by its
   * buffer lifecycle. KEEP THIS CLASS THIN: all logic lives in `ChunkWorld` / the pure mesher.
   */
  public onMeshReady(cx: number, cz: number, mesh: VoxelMeshData): void {
    const key = ChunkWorldHost._key(cx, cz);
    const existing = this._nodes.get(key);
    if (existing) {
      existing.geometry = new VoxelChunkGeometry(mesh).getGeometryData();
      existing.computeBounds();
      const previous = this._triangles.get(key) ?? 0;
      this._triangleCount = this._triangleCount - previous + mesh.triangleCount;
      this._triangles.set(key, mesh.triangleCount);
      return;
    }

    const node = new Object3D(`chunk_${cx}_${cz}`);
    node.geometry = new VoxelChunkGeometry(mesh).getGeometryData();
    node.material = this._material;
    node.position.set(cx * Chunk.SIZE, 0, cz * Chunk.SIZE);
    node.frustumCulled = true;
    // `computeBounds()` transforms the geometry bounds by `worldMatrix` -- which is still
    // IDENTITY on a fresh node. Resolve the transform first (`updateMatrixWorld`), then bound
    // in WORLD space; otherwise every chunk's cull bounds sit at the identity-space origin and
    // the FrustumCuller (which reads `obj.bounds` directly each frame) culls ~the whole world.
    // Same order the engine apps use (yad LevelBuilder: `updateMatrixWorld()` -> `computeBounds()`).
    node.updateMatrixWorld();
    node.computeBounds();
    this._scene.add(node);
    this._nodes.set(key, node);
    this._triangles.set(key, mesh.triangleCount);
    this._triangleCount += mesh.triangleCount;
  }

  /** Evicts the hosted node for (cx, cz) when the world unloads the chunk. */
  public onUnload(cx: number, cz: number): void {
    const key = ChunkWorldHost._key(cx, cz);
    const node = this._nodes.get(key);
    if (!node) return; // a chunk may be evicted before it ever meshed
    this._scene.remove(node);
    this._nodes.delete(key);
    const triangles = this._triangles.get(key) ?? 0;
    this._triangles.delete(key);
    this._triangleCount -= triangles;
  }

  /** Removes every hosted node (teardown). */
  public destroy(): void {
    for (const node of this._nodes.values()) {
      this._scene.remove(node);
    }
    this._nodes.clear();
    this._triangleCount = 0;
  }

  private static _key(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }
}
