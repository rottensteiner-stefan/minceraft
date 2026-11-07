import { describe, expect, it } from "vitest";
import { BLOCK_STONE, BLOCK_WATER, BlockRegistry } from "../src/voxel/BlockRegistry.js";
import { Chunk } from "../src/voxel/Chunk.js";
import type { VoxelMeshData } from "../src/voxel/mesh/NaiveMesher.js";
import {
  buildMesh,
  buildNeighborCorner,
  buildNeighborRim,
  descriptorFromRegistry,
} from "../src/voxel/mesh/NaiveMesher.js";

/**
 * M2 baked vertex AO (Entscheid D5: Minceraft-treue 4 Stufen occ in {0..3} -> Faktor
 * {1, 2/3, 1/3, 0}). The AO factor travels in `colors.g` (`.r` stays the atlas layer). Tests
 * pin: the discretization, the fact that transparent blocks never occlude, the corner-column
 * consumption (a 4-chunk-corner vertex darkens EXACTLY when the diagonal column supplies a solid
 * cell -- no AO leak) and byte-determinism across repeated meshing.
 */

interface Quad {
  normal: [number, number, number];
  /** The 4 vertex AO factors of the quad, in emission order. */
  ao: [number, number, number, number];
  x: number;
  y: number;
  z: number;
}

function collectFaces(data: VoxelMeshData): Quad[] {
  const quads: Quad[] = [];
  const count = data.triangleCount / 2;
  for (let f = 0; f < count; f++) {
    const vi = f * 4;
    const nBase = vi * 3;
    const pBase = vi * 3;
    quads.push({
      normal: [data.normals[nBase]!, data.normals[nBase + 1]!, data.normals[nBase + 2]!],
      ao: [
        data.colors[vi * 4 + 1]!,
        data.colors[(vi + 1) * 4 + 1]!,
        data.colors[(vi + 2) * 4 + 1]!,
        data.colors[(vi + 3) * 4 + 1]!,
      ],
      x: data.positions[pBase]!,
      y: data.positions[pBase + 1]!,
      z: data.positions[pBase + 2]!,
    });
  }
  return quads;
}

function seeded(): { registry: BlockRegistry } {
  const registry = new BlockRegistry();
  BlockRegistry.seed(registry);
  return { registry };
}

function meshChunk(chunk: Chunk): VoxelMeshData {
  const { registry } = seeded();
  return buildMesh({ voxels: chunk.voxels, descriptor: descriptorFromRegistry(registry) });
}

/** The +Y face of a single stones block placed at (x,y,z) (helper assumes exactly one block). */
function topAo(x: number, y: number, z: number): [number, number, number, number] {
  const chunk = new Chunk();
  chunk.setBlock(x, y, z, BLOCK_STONE);
  const quads = collectFaces(meshChunk(chunk));
  const top = quads.find((q) => q.normal.join(",") === "0,1,0")!;
  expect(top).toBeDefined();
  return top.ao;
}

describe("Vertex AO — exposure and discretization (Minceraft scheme)", () => {
  it("a fully exposed top face stays bright on every vertex (factor 1, occ 0)", () => {
    const ao = topAo(8, 5, 8);
    expect(ao).toEqual([1, 1, 1, 1]);
  });

  it("a pocketed corner drops to occ 3 (factor 0) when BOTH in-plane edge neighbors are solid", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 5, 8, BLOCK_STONE);
    // Both edge-neighbor cells of the top-face corner (cu=0, cv=0) in the OUTER layer (y=6):
    // the +Z-tangent neighbor (8,6,7) and the +X-tangent neighbor (7,6,8).
    chunk.setBlock(8, 6, 7, BLOCK_STONE);
    chunk.setBlock(7, 6, 8, BLOCK_STONE);
    const ao = collectFaces(meshChunk(chunk)).find((q) => q.normal.join(",") === "0,1,0")!.ao;
    // AO factors are stored as float32 (colors is a Float32Array): snap to the discrete
    // Minceraft set before comparing.
    const sorted = [...ao].map((v) => Math.round(v * 3) / 3).sort((a, b) => a - b);
    expect(sorted).toEqual([0, 2 / 3, 2 / 3, 1]); // {occ 3, 1, 1, 0} -> {0, 2/3, 2/3, 1}
  });

  it("a corner with one edge neighbor AND the diagonal solid reaches occ 2 (factor 1/3)", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 5, 8, BLOCK_STONE);
    chunk.setBlock(8, 6, 7, BLOCK_STONE); // +Z-tangent edge neighbor solid
    chunk.setBlock(7, 6, 7, BLOCK_STONE); // in-plane diagonal solid
    const ao = collectFaces(meshChunk(chunk)).find((q) => q.normal.join(",") === "0,1,0")!.ao;
    const discrete = ao.map((v) => Math.round(v * 3) / 3); // float32 -> Minceraft set
    expect(discrete).toContain(1 / 3);
    expect(discrete).toContain(2 / 3);
  });

  it("never produces a factor outside the discrete Minceraft set {0, 1/3, 2/3, 1}", () => {
    const chunk = new Chunk();
    // A dense interior cluster produces every occlusion level.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) chunk.setBlock(8 + dx, 6 + dy, 8 + dz, BLOCK_STONE);
      }
    }
    const quads = collectFaces(meshChunk(chunk));
    expect(quads.length).toBeGreaterThan(0);
    for (const q of quads) {
      for (const v of q.ao) {
        const nearest = Math.round(v * 3) / 3;
        expect(Math.abs(v - nearest), `factor ${v}`).toBeLessThan(1e-6);
      }
    }
  });

  it("a transparent (water) neighbor NEVER occludes -- it is not in the opaque sampler", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 5, 8, BLOCK_STONE);
    chunk.setBlock(8, 6, 7, BLOCK_WATER); // would occlude if solid
    chunk.setBlock(7, 6, 8, BLOCK_WATER);
    const ao = collectFaces(meshChunk(chunk)).find((q) => q.normal.join(",") === "0,1,0")!.ao;
    expect(ao).toEqual([1, 1, 1, 1]);
  });
});

describe("Vertex AO — seam-exactness via corner columns (no AO leak)", () => {
  it("consumes the diagonal corner column: a 4-chunk-corner vertex darkens by exactly one level", () => {
    const { registry } = seeded();
    const descriptor = descriptorFromRegistry(registry);

    // Chunk C owns a block at its +X/+Z local corner (15, 5, 15) whose top face corner
    // (cu=1, cv=1) samples the +X and +Z neighbor rims AND the +X,+Z DIAGONAL chunk's corner.
    const c = new Chunk();
    c.setBlock(15, 5, 15, BLOCK_STONE);
    // Lateral neighbors are empty (their rims read air) -- only the diagonal column differs.
    const nx = new Chunk();
    const nz = new Chunk();
    const diagonal = new Chunk();
    diagonal.setBlock(0, 6, 0, BLOCK_STONE); // the corner cell (16,6,16) in world = diag.local (0,6,0)

    const base = {
      voxels: c.voxels,
      descriptor,
      neighbors: {
        px: buildNeighborRim(nx.voxels, "px"),
        pz: buildNeighborRim(nz.voxels, "pz"),
      },
    };

    const withoutCorner = buildMesh(base);
    const withCorner = buildMesh({
      ...base,
      neighborCorners: { pp: buildNeighborCorner(diagonal.voxels, "pp") },
    });

    const topBright = collectFaces(withoutCorner).find((q) => q.normal.join(",") === "0,1,0")!;
    const topDark = collectFaces(withCorner).find((q) => q.normal.join(",") === "0,1,0")!;

    // Quad emission order is (cu,cv) = [0,0],[1,0],[1,1],[0,1]; with tangentA=[0,0,1] and
    // tangentB=[1,0,0] the +X/+Z world corner (16,6,16) is EMISSION INDEX 2 (not 3).
    // Without the diagonal data that corner cell reads AIR (no leak prevention available):
    // occ 0 -> factor 1. With the diagonal column the vertex becomes occ 1 -> factor 2/3.
    expect(topBright.ao[2]).toBeCloseTo(1, 6);
    expect(topDark.ao[2]).toBeCloseTo(2 / 3, 6);
    // The opposite corner (-X/-Z, emission index 0) is unaffected by the +X/+Z diagonal column.
    expect(topDark.ao[0]).toBeCloseTo(1, 6);
  });

  it("is byte-deterministic: the same input (incl. corner columns) always produces identical colors", () => {
    const { registry } = seeded();
    const descriptor = descriptorFromRegistry(registry);
    const c = new Chunk();
    c.setBlock(15, 5, 15, BLOCK_STONE);
    const diagonal = new Chunk();
    diagonal.setBlock(0, 6, 0, BLOCK_STONE);
    const build = (): VoxelMeshData =>
      buildMesh({
        voxels: c.voxels,
        descriptor,
        neighborCorners: { pp: buildNeighborCorner(diagonal.voxels, "pp") },
      });
    const a = build();
    const b = build();
    expect(a.colors).toEqual(b.colors);
    expect(a.indices).toEqual(b.indices);
  });
});
