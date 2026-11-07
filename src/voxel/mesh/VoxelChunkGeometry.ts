import { AbstractGeometry } from "@small-world-machine/engine";
import type { VoxelMeshData } from "../mesh/NaiveMesher.js";

/**
 * Engine adapter for mesher output: wraps the pure `VoxelMeshData` typed arrays into the
 * engine's `AbstractGeometry` so the chunk can live on the normal `Object3D` path (bounds,
 * frustum culling, `getGeometryData()` for upload). Deliberately a thin, stateless wrapper --
 * all logic stays in the pure `NaiveMesher`.
 *
 * The base class fills `_tangents`/`_wireframeIndices` lazily in `getGeometryData()`; the
 * renderer uploads STATIC_DRAW once and swaps geometry objects on a later remesh (M1 pattern:
 * `needsUpdate`/swap, not per-frame mutation -- Dave-Report §2.1).
 */
export class VoxelChunkGeometry extends AbstractGeometry {
  constructor(data: VoxelMeshData) {
    super();
    this._vertices = data.positions;
    this._indices = data.indices;
    this._normals = data.normals;
    this._uvs = data.uvs;
    this._colors = data.colors;
  }

  /** Data is pre-built by the mesher -- nothing to generate. */
  protected override generateGeometryData(): void {
    // no-op: geometry is fully populated in the constructor.
  }
}
