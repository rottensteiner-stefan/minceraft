import type {
  CornerDir,
  FaceDir,
  MeshBlockDescriptorEntry,
  VoxelMeshData,
} from "../mesh/NaiveMesher.js";

/**
 * M1 worker protocol (`.agents/collaborate/minceraft/dossier.md` §4.2 M1 "MeshWorkerProtocol").
 * Typed, transferable message shapes between the main thread and the dedicated mesh worker
 * (`voxel/worker/mesh.worker.ts`). Single worker, two kept-apart roles (dossier §5 S2: world
 * generation and mesh building NEVER together, NEVER on the main thread):
 *
 *   - `generate`: the worker runs the seeded `TerrainGenerator` and returns a plain
 *     `Uint8Array` (SIZE³) that survives structured clone without class-prototype issues.
 *   - `mesh`: the worker runs the pure `buildMesh` against the chunk's own voxels plus the
 *     border planes of its neighbors (the seam culling contract, see `buildNeighborRim`).
 *
 * Deliberate simplifications for M1, documented (not hidden scope cuts):
 *   - No explicit transferable lists. The payloads are 4-6 KB per chunk; the worker keeps the
 *     main-thread `Chunk` data intact by receiving COPIEs, and the output arrays would be
 *     consumed exactly once anyway. Zero-copy would complicate ownership for no measurable gain
 *     at M1 scale (benchmarked later in M5).
 *   - One worker, one mesh task at a time. A worker pool is the M7 hardening; M1 proves the
 *     architecture with a single background role. `MeshWorkerPoolClient` (M7) now runs the SAME
 *     protocol over N workers -- the message shapes below are unchanged, only the transport
 *     distributes tasks and keeps task ids GLOBALLY unique across the whole pool.
 */

export interface MeshInitMessage {
  kind: "init";
  /** World seed shared with the worker's own `TerrainGenerator` instance. */
  seed: number;
  /** Transferable registry subset -- the worker never imports `BlockRegistry`. */
  descriptor: readonly MeshBlockDescriptorEntry[];
}

export interface MeshGenerateRequest {
  kind: "generate";
  id: number;
  cx: number;
  cz: number;
}

export interface MeshBuildRequest {
  kind: "mesh";
  id: number;
  cx: number;
  cz: number;
  /** The chunk's own block-id buffer (SIZE³). Copied across, never transferred. */
  voxels: Uint8Array;
  /** Border planes of the (up to 4 horizontal) neighbors, per `RIM_INDEX_ORDER`. */
  neighbors: Partial<Record<FaceDir, Uint8Array>>;
  /** 16-tall AO corner columns of the up-to-4 diagonal neighbors (M2 seam-exact vertex AO;
   *  `ChunkWorld` gates meshing on all 8 neighbors, so these are always present in production). */
  neighborCorners?: Partial<Record<CornerDir, Uint8Array>>;
  /** M5: whether to use AO-compatible greedy quad merging. Default true. */
  useGreedy?: boolean;
}

export type MeshWorkerRequest = MeshInitMessage | MeshGenerateRequest | MeshBuildRequest;

export interface MeshDataResponse {
  kind: "data";
  id: number;
  voxels: Uint8Array;
}

/** Result of a `mesh` task: the mesh plus the worker-side wall time (for the "meshing never on
 *  the main thread" proof in the stats panel; the foreground fallback reports 0 as it is main). */
export interface MeshOutcome {
  mesh: VoxelMeshData;
  meshMs: number;
}

export interface MeshResultResponse {
  kind: "mesh-result";
  id: number;
  outcome: MeshOutcome;
}

export interface MeshErrorResponse {
  kind: "error";
  id: number;
  message: string;
}

export type MeshWorkerResponse = MeshDataResponse | MeshResultResponse | MeshErrorResponse;

/**
 * The background-work surface `ChunkWorld` consumes. Implementations share the SAME protocol:
 *
 *   - `MeshWorkerPoolClient` -- the M7 production path (a pool of dedicated Vite module workers;
 *     `?workers=1` degenerates to the M1 single-arena behavior).
 *   - `MeshWorkerClient` -- the M1 single-worker transport, kept as the documented fallback
 *     implementation of the same protocol (superseded in-app by the pool).
 *   - `ForegroundMeshClient` -- synchronous test/fallback double that runs the SAME pure
 *     `TerrainGenerator` + `buildMesh` code paths on the calling thread (node tests have no
 *     `Worker`). Single source of truth everywhere.
 */
export interface MeshClient {
  /** Seed + block semantics. Must run before any `generate`/`mesh` call. */
  configure(seed: number, descriptor: readonly MeshBlockDescriptorEntry[]): void;
  /** Generates the block-id buffer (SIZE³) of the world column (cx, cz) on a background thread. */
  generate(cx: number, cz: number): Promise<Uint8Array>;
  /** Meshes the chunk (cx, cz) against its neighbor border planes (and AO corner columns) on a
   *  background thread. */
  mesh(
    cx: number,
    cz: number,
    voxels: Uint8Array,
    neighbors: Partial<Record<FaceDir, Uint8Array>>,
    neighborCorners?: Partial<Record<CornerDir, Uint8Array>>,
    useGreedy?: boolean,
  ): Promise<MeshOutcome>;
  /** Releases background resources. Pending tasks reject. */
  destroy(): void;
}
