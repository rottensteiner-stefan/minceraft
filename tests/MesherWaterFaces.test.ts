import { describe, expect, it } from "vitest";
import {
  BLOCK_DIRT,
  BLOCK_STONE,
  BLOCK_TEX_LAYER,
  BLOCK_WATER,
  BlockRegistry,
} from "../src/voxel/BlockRegistry.js";
import { Chunk } from "../src/voxel/Chunk.js";
import type { VoxelMeshData } from "../src/voxel/mesh/NaiveMesher.js";
import { buildMesh, buildNeighborRim, descriptorFromRegistry } from "../src/voxel/mesh/NaiveMesher.js";

/**
 * M2 water faces (Entscheid D3): a transparent block draws a face ONLY when the axis neighbor
 * is LITERALLY AIR -- no internal water-water faces and no face against a solid body (prevents
 * z-fighting with the opaque pass by construction). Water faces carry NO block AO (colors.g = 1)
 * and use the WATER atlas layer. Border culling reads through the neighbor rim planes like the
 * opaque path, so a water body at a chunk seam is culled exactly like interior water.
 */

function seeded(): { registry: BlockRegistry } {
  const registry = new BlockRegistry();
  BlockRegistry.seed(registry);
  return { registry };
}

function faces(
  data: VoxelMeshData,
): Array<{ normal: [number, number, number]; layer: number; ao: number }> {
  const out: Array<{ normal: [number, number, number]; layer: number; ao: number }> = [];
  const count = data.triangleCount / 2;
  for (let f = 0; f < count; f++) {
    const vi = f * 4;
    out.push({
      normal: [data.normals[vi * 3]!, data.normals[vi * 3 + 1]!, data.normals[vi * 3 + 2]!],
      layer: data.colors[vi * 4]!,
      ao: data.colors[vi * 4 + 1]!,
    });
  }
  return out;
}

function mesh(chunk: Chunk): VoxelMeshData {
  const { registry } = seeded();
  return buildMesh({ voxels: chunk.voxels, descriptor: descriptorFromRegistry(registry) });
}

describe("Water faces — only against AIR", () => {
  it("a lone water block emits 6 faces (every neighbor is air)", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 5, 8, BLOCK_WATER);
    const f = faces(mesh(chunk));
    expect(f.length).toBe(6);
  });

  it("emits NO face toward a solid body and no face against another water block", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 5, 8, BLOCK_WATER);
    chunk.setBlock(9, 5, 8, BLOCK_STONE); // +X solid
    chunk.setBlock(8, 5, 7, BLOCK_WATER); // -Z water
    const f = faces(mesh(chunk));
    // Both water blocks emit: the (8,5,8) pool block culls ONLY its +X face (toward stone) and
    // its -Z face (toward the second water block) -> 4 faces; the (8,5,7) block emits its 5
    // faces toward air (its +Z face toward the other water is culled). Total water faces = 9.
    const waterFaces = f.filter((x) => x.layer === 7); // BLOCK_TEX_LAYER.WATER
    expect(waterFaces.length).toBe(9);
    // The solid block's +X-side -X face must still be present (stone faces toward the water,
    // exactly like MC where the soil wall is visible through the pool).
    expect(
      f.some((x) => x.normal.join(",") === "-1,0,0" && x.layer === BLOCK_TEX_LAYER.STONE),
    ).toBe(true);
  });

  it("water faces carry no block AO (colors.g = 1)", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 5, 8, BLOCK_WATER);
    const f = faces(mesh(chunk));
    expect(f.length).toBe(6);
    for (const face of f) expect(face.ao).toBe(1);
  });

  it("renders against open air at a chunk border only when the neighbor plane really is air (rim seam)", () => {
    const chunk = new Chunk();
    chunk.setBlock(15, 5, 8, BLOCK_WATER); // on the +X border
    const neighbor = new Chunk();
    neighbor.setBlock(0, 5, 8, BLOCK_DIRT); // the neighbor's facing plane cell is SOLID
    const { registry } = seeded();
    const data = buildMesh({
      voxels: chunk.voxels,
      descriptor: descriptorFromRegistry(registry),
      neighbors: { px: buildNeighborRim(neighbor.voxels, "px") },
    });
    // The water's +X face (toward the solid neighbor plane) must NOT be emitted.
    const f = faces(data);
    expect(f.some((x) => x.normal.join(",") === "1,0,0" && x.layer === 7)).toBe(false);
  });

  it("a water pool in isolation renders its top surface (face directly against sky air)", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 4, 8, BLOCK_WATER);
    chunk.setBlock(8, 3, 8, BLOCK_DIRT); // bed below
    const f = faces(mesh(chunk));
    // Water top (against air at y=5) is drawn; the bed contact below is not (against dirt).
    expect(f.some((x) => x.normal.join(",") === "0,1,0" && x.layer === 7)).toBe(true);
  });
});
