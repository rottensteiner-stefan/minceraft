import type { MeshBlockDescriptorEntry, VoxelMeshData } from "../mesh/NaiveMesher.js";
import { buildMesh } from "../mesh/NaiveMesher.js";
import { buildGreedyMesh } from "../mesh/GreedyMesher.js";
import { TerrainGenerator } from "../TerrainGenerator.js";
import type { MeshWorkerRequest, MeshWorkerResponse } from "./MeshWorkerProtocol.js";

/**
 * Dedicated mesh worker (M1, dossier §5 S2: world generation and mesh building live here, never
 * on the main thread). Imported by the M1 `MeshWorkerClient` and the M7 `MeshWorkerPoolClient`
 * (N arena instances) via Vite's module-worker pattern
 * (`new Worker(new URL(...), { type: "module" })`), which bundles this file as its own chunk.
 *
 * The worker hosts TWO kept-apart roles -- seeded column generation and neighbor-aware meshing --
 * served by the SAME pure modules the node tests exercise (`TerrainGenerator`, `buildMesh`).
 * It never imports `BlockRegistry` or any DOM/engine API: the registry subset and the world seed
 * arrive via the `init` message, so this file stays dependency-free and trivially portable.
 *
 * The worker keeps a minimal `self` contract (`MeshWorkerScope`, no `webworker` lib dependency).
 */

interface MeshWorkerScope {
  onmessage: ((e: MessageEvent<MeshWorkerRequest>) => void) | null;
  postMessage(message: MeshWorkerResponse): void;
}

const scope = self as unknown as MeshWorkerScope;

let generator: TerrainGenerator | null = null;
let descriptor: readonly MeshBlockDescriptorEntry[] = [];

scope.onmessage = (e: MessageEvent<MeshWorkerRequest>): void => {
  const msg = e.data;
  try {
    switch (msg.kind) {
      case "init":
        generator = new TerrainGenerator({ seed: msg.seed });
        descriptor = msg.descriptor;
        return;
      case "generate": {
        const voxels = generator!.generateColumn(msg.cx, 0, msg.cz);
        scope.postMessage({ kind: "data", id: msg.id, voxels });
        return;
      }
      case "mesh": {
        const start = performance.now();
        const meshFn = msg.useGreedy !== false ? buildGreedyMesh : buildMesh;
        const mesh: VoxelMeshData = msg.neighborCorners
          ? meshFn({
              voxels: msg.voxels,
              descriptor,
              neighbors: msg.neighbors,
              neighborCorners: msg.neighborCorners,
            })
          : meshFn({
              voxels: msg.voxels,
              descriptor,
              neighbors: msg.neighbors,
            });
        const meshMs = performance.now() - start;
        scope.postMessage({ kind: "mesh-result", id: msg.id, outcome: { mesh, meshMs } });
        return;
      }
      default:
        scope.postMessage({
          kind: "error",
          id: "id" in msg ? (msg as { id: number }).id : 0,
          message: `[mesh.worker] unknown message kind: ${(msg as { kind?: string }).kind}`,
        });
    }
  } catch (err) {
    scope.postMessage({
      kind: "error",
      id: "id" in msg ? (msg as { id: number }).id : 0,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
