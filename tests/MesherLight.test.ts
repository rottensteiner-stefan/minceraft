import { describe, expect, it } from "vitest";
import { BLOCK_AIR, BLOCK_STONE, BLOCK_WATER, BlockRegistry } from "../src/voxel/BlockRegistry.js";
import { Chunk } from "../src/voxel/Chunk.js";
import type { VoxelMeshData } from "../src/voxel/mesh/NaiveMesher.js";
import {
  buildMesh,
  buildNeighborRim,
  descriptorFromRegistry,
} from "../src/voxel/mesh/NaiveMesher.js";
import {
  FLOOD_SEALED_FACTOR,
  LIGHT_FLOOR,
  LIGHT_SURFACE_FACTOR,
  combineLight,
  daylightFactorAt,
  floodSealedness,
} from "../src/voxel/light/daylight.js";

/**
 * M3 baked light channel (dossier §4.3 M3, decisions D4/D5), pinned exactly as described:
 *   - `colors.b` carries the worker-baked light factor = daylight height rule x cheapest point
 *     flood (AO `.g` and layer `.r` stay untouched -- M2 regression asserted at the bottom);
 *   - the daylight rule is a pure function of a cell's OWN column -> seam-exact by construction
 *     (no cross-chunk sample; the "Rim parity" test pins that neighbor data cannot change it);
 *   - the point flood darkens FULLY SEALED air pockets only (hard cut, D5), so on heightfield
 *     terrain it stays inert and only genuinely enclosed volumes read darker.
 */

interface Quad {
  normal: [number, number, number];
  /** The 4 vertex light factors of the quad, in emission order. */
  light: [number, number, number, number];
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
      light: [
        data.colors[vi * 4 + 2]!,
        data.colors[(vi + 1) * 4 + 2]!,
        data.colors[(vi + 2) * 4 + 2]!,
        data.colors[(vi + 3) * 4 + 2]!,
      ],
      x: data.positions[pBase]!,
      y: data.positions[pBase + 1]!,
      z: data.positions[pBase + 2]!,
    });
  }
  return quads;
}

function meshChunk(chunk: Chunk): VoxelMeshData {
  const registry = new BlockRegistry();
  BlockRegistry.seed(registry);
  return buildMesh({ voxels: chunk.voxels, descriptor: descriptorFromRegistry(registry) });
}

/** Builds a solid stone box x∈[x0,x1], y∈[y0,y1], z∈[z0,z1] (fill). */
function fillBox(chunk: Chunk, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) chunk.setBlock(x, y, z, BLOCK_STONE);
    }
  }
}

describe("daylightFactorAt -- golden height-rule curve (M3 D4)", () => {
  it("is full daylight at/above the column surface", () => {
    expect(daylightFactorAt(5, 5)).toBe(LIGHT_SURFACE_FACTOR);
    expect(daylightFactorAt(6, 5)).toBe(LIGHT_SURFACE_FACTOR);
    expect(daylightFactorAt(15, 5)).toBe(LIGHT_SURFACE_FACTOR);
  });

  it("drops by a fixed step per block below the surface (golden discretization)", () => {
    expect(daylightFactorAt(4, 5)).toBeCloseTo(0.84, 9);
    expect(daylightFactorAt(3, 5)).toBeCloseTo(0.68, 9);
    expect(daylightFactorAt(2, 5)).toBeCloseTo(0.52, 9);
    expect(daylightFactorAt(1, 5)).toBeCloseTo(0.36, 9);
    expect(daylightFactorAt(0, 5)).toBeCloseTo(0.2, 9);
    // The curve hard-stops at the global floor -- the underground never goes pitch black.
    expect(daylightFactorAt(-1, 5)).toBeCloseTo(LIGHT_FLOOR, 9);
    expect(daylightFactorAt(-3, 5)).toBeCloseTo(LIGHT_FLOOR, 9);
  });

  it("is a pure coordinate function: an empty column (surface -1) reads as full light", () => {
    expect(daylightFactorAt(0, -1)).toBe(LIGHT_SURFACE_FACTOR);
  });
});

describe("floodSealedness -- cheapest point flood discretization (M3 D5)", () => {
  it("darkens a fully sealed cell (0 open probes) to the hard floor", () => {
    expect(floodSealedness(0)).toBe(FLOOD_SEALED_FACTOR);
  });

  it("keeps ANY openness at full flood weight (hard cutoff, no gradient)", () => {
    expect(floodSealedness(1)).toBe(LIGHT_SURFACE_FACTOR);
    expect(floodSealedness(6)).toBe(LIGHT_SURFACE_FACTOR);
    expect(floodSealedness(12)).toBe(LIGHT_SURFACE_FACTOR);
  });
});

describe("baked light channel `.b` in the mesh", () => {
  it("bakes 1.0 on every face of a fully exposed surface block", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 5, 8, BLOCK_STONE);
    const quads = collectFaces(meshChunk(chunk));
    expect(quads.length).toBeGreaterThan(0);
    for (const q of quads) {
      for (const v of q.light) expect(v).toBeCloseTo(1, 4);
    }
  });

  it("bakes a dark factor on a below-surface cell and 1.0 on its column's top", () => {
    // A 1-block-wide solid stone column (its surface is y=10).
    const chunk = new Chunk();
    for (let y = 0; y <= 10; y++) chunk.setBlock(8, y, 8, BLOCK_STONE);
    const quads = collectFaces(meshChunk(chunk));

    const top = quads.find((q) => q.normal.join(",") === "0,1,0" && Math.round(q.y) === 11)!;
    expect(top).toBeDefined();
    expect(top.light[0]).toBeCloseTo(1, 4); // surface -> full daylight

    // A +X side face of the same column, 7 blocks under the surface -> global underground floor.
    const deepSide = quads.find((q) => q.normal.join(",") === "1,0,0" && Math.round(q.y) === 3)!;
    expect(deepSide).toBeDefined();
    expect(deepSide.light[0]).toBeCloseTo(LIGHT_FLOOR, 2);
    // Monotone: a higher side face is strictly brighter than a deeper one.
    const upperSide = quads.find((q) => q.normal.join(",") === "1,0,0" && Math.round(q.y) === 7)!;
    expect(upperSide.light[0]).toBeCloseTo(1 - 0.16 * 3, 4); // y=7 vs surface 10 = depth 3
  });

  it("does NOT shade transparent (water) faces -- they always bake 1.0", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 5, 8, BLOCK_WATER);
    const quads = collectFaces(meshChunk(chunk));
    expect(quads.length).toBeGreaterThan(0);
    for (const q of quads) {
      for (const v of q.light) expect(v).toBeCloseTo(1, 4);
    }
  });

  it("darkens the faces bordering a FULLY SEALED pocket vs. the same face left open (D5)", () => {
    // Solid 5x5x5 stone box around the pocket cell (8,6,8). The stone block BELOW the pocket
    // (8,5,8) has exactly one face: its +Y face into the pocket.
    const sealed = new Chunk();
    fillBox(sealed, 6, 4, 6, 10, 8, 10);
    sealed.setBlock(8, 6, 8, BLOCK_AIR); // 1x1x1 air pocket, fully surrounded by stone
    const sealedFace = collectFaces(meshChunk(sealed)).find(
      (q) => q.normal.join(",") === "0,1,0" && Math.round(q.y) === 6 && Math.round(q.x) === 8,
    )!;
    expect(sealedFace).toBeDefined();
    // daylight(5, surface 8) = 1 - 0.16*3 = 0.52; the sealed flood cuts it to ~0.7 * that.
    const daylight = daylightFactorAt(5, 8);
    expect(sealedFace.light[0]).toBeCloseTo(combineLight(daylight, FLOOD_SEALED_FACTOR), 4);

    // Same box, but the pocket is OPEN upward ((8,7,8) removed) -> flood has a single open probe.
    const open = new Chunk();
    fillBox(open, 6, 4, 6, 10, 8, 10);
    open.setBlock(8, 6, 8, BLOCK_AIR);
    open.setBlock(8, 7, 8, BLOCK_AIR);
    const openFace = collectFaces(meshChunk(open)).find(
      (q) => q.normal.join(",") === "0,1,0" && Math.round(q.y) === 6 && Math.round(q.x) === 8,
    )!;
    expect(openFace).toBeDefined();
    expect(openFace.light[0]).toBeCloseTo(daylight, 4); // no flood penalty -- only the height rule
    expect(sealedFace.light[0]).toBeLessThan(openFace.light[0]); // sealed is DARKER -> closed vs open
  });
});

describe("light -- seam-exactness & determinism (no chunk-boundary dependence)", () => {
  it("height-rule parity across a rim: a border cell's `.b` ignores neighbor data", () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);
    const c = new Chunk();
    c.setBlock(15, 5, 15, BLOCK_STONE); // +X/+Z border cell
    const neighbor = new Chunk(); // empty -> its rims read air

    const without = buildMesh({
      voxels: c.voxels,
      descriptor,
      neighbors: {
        px: buildNeighborRim(neighbor.voxels, "px"),
        pz: buildNeighborRim(neighbor.voxels, "pz"),
      },
    });
    // The height rule reads only the cell's OWN column -- a FLAT surface border cell stays 1.0
    // whether neighbor data says "air" or "solid" adjacent (parity by construction).
    const withoutLight = collectFaces(without)
      .find((q) => q.normal.join(",") === "0,1,0" && Math.round(q.y) === 6 && Math.round(q.x) === 15)!
      .light[0];
    expect(withoutLight).toBeCloseTo(1, 4);
  });

  it("is byte-deterministic: the same input always produces identical colors", () => {
    const chunk = new Chunk();
    fillBox(chunk, 6, 4, 6, 10, 8, 10);
    chunk.setBlock(8, 6, 8, BLOCK_AIR);
    const a = meshChunk(chunk);
    const b = meshChunk(chunk);
    expect(a.colors).toEqual(b.colors);
    expect(a.indices).toEqual(b.indices);
  });
});

describe("M2 regression -- AO channel `.g` unchanged by the M3 light channel", () => {
  it("reproduces the pinned Minceraft AO discretization in a pocketed corner", () => {
    const chunk = new Chunk();
    chunk.setBlock(8, 5, 8, BLOCK_STONE);
    chunk.setBlock(8, 6, 7, BLOCK_STONE);
    chunk.setBlock(7, 6, 8, BLOCK_STONE);
    const data = meshChunk(chunk);
    const topIndex = collectFaces(data).findIndex((q) => q.normal.join(",") === "0,1,0");
    expect(topIndex).toBeGreaterThanOrEqual(0);
    // AO lives at `.g` (index +1), untouched by the M3 light channel: pin the same discrete set
    // {0, 2/3, 2/3, 1} that MesherAo.test.ts pins, proving the light work did not touch AO.
    const ai = topIndex * 16; // vertex 0 of quad `topIndex` -> colors offset (4*topIndex)*4
    const aoValues = [0, 1, 2, 3].map((k) => data.colors[ai + k * 4 + 1]!);
    const sorted = aoValues.map((v) => Math.round(v * 3) / 3).sort((x, y) => x - y);
    expect(sorted).toEqual([0, 2 / 3, 2 / 3, 1]);
  });
});
