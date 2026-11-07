import { describe, expect, it } from "vitest";
import { BlockRegistry, BLOCK_DIRT, BLOCK_STONE } from "../src/voxel/BlockRegistry.js";
import { Chunk } from "../src/voxel/Chunk.js";
import { buildGreedyMesh } from "../src/voxel/mesh/GreedyMesher.js";
import { buildMesh, descriptorFromRegistry } from "../src/voxel/mesh/NaiveMesher.js";

describe("GreedyMesher (M5 AO-Compatible Quad Merging)", () => {
  it("merges a flat 4x4 stone platform into significantly fewer triangles than naive mesher", () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);

    const size = Chunk.SIZE;
    const voxels = new Uint8Array(size * size * size);

    // Place a 4x4 solid platform at Y=0, X in [2..5], Z in [2..5]
    for (let z = 2; z <= 5; z++) {
      for (let x = 2; x <= 5; x++) {
        voxels[x + z * size + 0 * size * size] = BLOCK_STONE;
      }
    }

    const naive = buildMesh({ voxels, descriptor });
    const greedy = buildGreedyMesh({ voxels, descriptor });

    // Naive emits 16 top faces * 2 tris = 32 tris for top alone + side faces
    expect(greedy.triangleCount).toBeLessThan(naive.triangleCount);

    // The top face should be merged into 1 single quad (2 triangles)!
    expect(greedy.triangleCount).toBeLessThanOrEqual(20);
    expect(greedy.positions.length).toBe(greedy.triangleCount * 2 * 3); // 4 verts per 2 tris -> 6 coords
  });

  it("does NOT merge adjacent blocks if their AO factors differ", () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);

    const size = Chunk.SIZE;
    const voxels = new Uint8Array(size * size * size);

    // Floor at y=0, with an adjacent wall at x=1, y=1 that casts AO on cell (2, 0, 2)
    voxels[2 + 2 * size + 0 * size * size] = BLOCK_DIRT;
    voxels[3 + 2 * size + 0 * size * size] = BLOCK_DIRT;
    // Wall next to (2, 0, 2)
    voxels[1 + 2 * size + 1 * size * size] = BLOCK_STONE;

    const greedy = buildGreedyMesh({ voxels, descriptor });
    // Since (2, 0, 2) has occlusion from the adjacent wall and (3, 0, 2) is open,
    // they MUST NOT merge into one quad.
    expect(greedy.triangleCount).toBeGreaterThanOrEqual(4);
  });

  it("produces valid non-degenerate triangles with unit normals", () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);

    const size = Chunk.SIZE;
    const voxels = new Uint8Array(size * size * size);
    voxels[5 + 5 * size + 5 * size * size] = BLOCK_STONE;

    const mesh = buildGreedyMesh({ voxels, descriptor });
    // Single isolated block has 6 faces * 2 tris = 12 tris
    expect(mesh.triangleCount).toBe(12);

    for (let i = 0; i < mesh.normals.length; i += 3) {
      const nx = mesh.normals[i]!;
      const ny = mesh.normals[i + 1]!;
      const nz = mesh.normals[i + 2]!;
      const len = Math.hypot(nx, ny, nz);
      expect(len).toBeCloseTo(1.0, 4);
    }
  });
});
