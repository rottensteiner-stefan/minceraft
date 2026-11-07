import { describe, expect, it } from "vitest";
import {
  BlockRegistry,
  BLOCK_AIR,
  BLOCK_DIRT,
  BLOCK_GRASS,
  BLOCK_STONE,
  BLOCK_TEX_LAYER,
} from "../src/voxel/BlockRegistry.js";
import { Chunk } from "../src/voxel/Chunk.js";
import type { VoxelMeshData } from "../src/voxel/mesh/NaiveMesher.js";
import { NaiveMesher } from "../src/voxel/mesh/NaiveMesher.js";

/**
 * Decodes mesher output into per-face tuples. The M0 mesher emits one face as exactly 4
 * consecutive vertices (positions/normals/uvs/colors aligned) + 2 triangles (6 indices).
 */
interface Face {
  normal: [number, number, number];
  layer: number;
}

function collectFaces(data: VoxelMeshData): Face[] {
  const faces: Face[] = [];
  const faceCount = data.triangleCount / 2;
  for (let f = 0; f < faceCount; f++) {
    const vi = f * 4;
    const nBase = vi * 3;
    faces.push({
      normal: [data.normals[nBase]!, data.normals[nBase + 1]!, data.normals[nBase + 2]!],
      layer: data.colors[vi * 4]!,
    });
  }
  return faces;
}

function buildOne(x: number, y: number, z: number, id: number): VoxelMeshData {
  const registry = new BlockRegistry();
  BlockRegistry.seed(registry);
  const chunk = new Chunk();
  chunk.setBlock(x, y, z, id);
  return new NaiveMesher(registry).build(chunk);
}

function seededMesher(): { registry: BlockRegistry; mesher: NaiveMesher } {
  const registry = new BlockRegistry();
  BlockRegistry.seed(registry);
  return { registry, mesher: new NaiveMesher(registry) };
}

describe("NaiveMesher — winding invariant", () => {
  it("every face keeps cross(tangentA, tangentB) === outward normal (back-face culling safety)", () => {
    for (const face of NaiveMesher.FACES) {
      const [ax, ay, az] = face.tangentA;
      const [bx, by, bz] = face.tangentB;
      const [nx, ny, nz] = face.normal;
      const cross = [ay! * bz! - az! * by!, az! * bx! - ax! * bz!, ax! * by! - ay! * bx!];
      expect(Math.abs(cross[0]! - nx!), `${face.normal} cross x`).toBeLessThan(1e-9);
      expect(Math.abs(cross[1]! - ny!), `${face.normal} cross y`).toBeLessThan(1e-9);
      expect(Math.abs(cross[2]! - nz!), `${face.normal} cross z`).toBeLessThan(1e-9);
    }
  });
});

describe("NaiveMesher — visible-face culling", () => {
  it("a lone solid voxel produces exactly 6 faces (12 triangles)", () => {
    const data = buildOne(5, 5, 5, BLOCK_DIRT);
    expect(data.triangleCount).toBe(12);
    expect(data.positions.length / 3).toBe(24);
    expect(data.indices.length).toBe(36);
  });

  it("two adjacent solid voxels cull the shared face (10 faces)", () => {
    const { mesher } = seededMesher();
    const chunk = new Chunk();
    chunk.setBlock(5, 5, 5, BLOCK_DIRT);
    chunk.setBlock(6, 5, 5, BLOCK_DIRT);
    const data = mesher.build(chunk);
    // 12 + 12 - 2 (the shared face is counted once per voxel) = 20 triangles / 10 faces.
    expect(data.triangleCount).toBe(20);
    const faces = collectFaces(data);
    expect(faces.length).toBe(10);
    // The shared face between both blocks is culled: exactly ONE +X face (on block B) and ONE
    // -X face (on block A) remain -- never the two that would face each other inside.
    const isPlusX = (f: Face): boolean => f.normal.join(",") === "1,0,0";
    const isMinusX = (f: Face): boolean => f.normal.join(",") === "-1,0,0";
    expect(faces.filter(isPlusX).length).toBe(1);
    expect(faces.filter(isMinusX).length).toBe(1);
  });

  it("exposes faces on the chunk border (out-of-bounds neighbour == air)", () => {
    const data = buildOne(0, 0, 0, BLOCK_STONE);
    expect(data.triangleCount).toBe(12); // corner voxel is still fully exposed
  });

  it("a transparent neighbour neither culls the opaque face nor renders against it", () => {
    const { registry, mesher } = seededMesher();
    registry.register({
      id: 6, // beyond the seeded M2 block set (0=AIR, 1..5 = grass/dirt/stone/wood/water)
      name: "glass",
      transparent: true,
      collidable: false,
      faceLayers: { top: 0, bottom: 0, side: 0 },
    });
    const chunk = new Chunk();
    chunk.setBlock(5, 5, 5, BLOCK_DIRT);
    chunk.setBlock(6, 5, 5, 6); // transparent neighbour
    const data = mesher.build(chunk);
    // M2 (D3): the opaque block meshes ALL its faces (the transparent neighbour is non-opaque),
    // AND the transparent block meshes only its faces DIRECTLY AGAINST AIR. So: 12 (dirt, fully
    // exposed) + 10 (glass: its -X face toward dirt is culled on both sides -> 5 faces) = 22.
    expect(data.triangleCount).toBe(22);
    const faces = collectFaces(data);
    // The +X face of the dirt block survives the transparent neighbour (never culled by glass).
    expect(faces.some((f) => f.normal.join(",") === "1,0,0")).toBe(true);
    // Exactly one -X face remains: the dirt block's face toward open air. The glass block emits
    // NO face against the dirt block (no water-into-solid z-fighting).
    expect(faces.filter((f) => f.normal.join(",") === "-1,0,0").length).toBe(1);
  });
});

describe("NaiveMesher — per-face atlas layers", () => {
  it("maps grass-cap faces to the correct palette layers (top=GRASS_TOP, bottom=DIRT, side=GRASS_SIDE)", () => {
    const data = buildOne(5, 5, 5, BLOCK_GRASS);
    const byNormal = new Map<string, number>();
    for (const f of collectFaces(data)) byNormal.set(f.normal.join(","), f.layer);
    expect(byNormal.get("0,1,0")).toBe(BLOCK_TEX_LAYER.GRASS_TOP); // grass top
    expect(byNormal.get("0,-1,0")).toBe(BLOCK_TEX_LAYER.DIRT); // dirt underside (M2 atlas)
    expect(byNormal.get("1,0,0")).toBe(BLOCK_TEX_LAYER.GRASS_SIDE); // dedicated grass side
    expect(byNormal.get("-1,0,0")).toBe(BLOCK_TEX_LAYER.GRASS_SIDE);
    expect(byNormal.get("0,0,1")).toBe(BLOCK_TEX_LAYER.GRASS_SIDE);
    expect(byNormal.get("0,0,-1")).toBe(BLOCK_TEX_LAYER.GRASS_SIDE);
  });

  it("keeps face normals axis-aligned unit vectors", () => {
    const data = buildOne(5, 6, 7, BLOCK_STONE);
    for (const f of collectFaces(data)) {
      expect(Math.hypot(f.normal[0], f.normal[1], f.normal[2])).toBeCloseTo(1, 9);
      expect(f.normal.filter((c) => c !== 0).length).toBe(1);
    }
  });
});

describe("NaiveMesher — output sanitation", () => {
  it("an empty chunk produces zero triangles and zero vertices", () => {
    const { mesher } = seededMesher();
    const data = mesher.build(new Chunk());
    expect(data.triangleCount).toBe(0);
    expect(data.positions.length).toBe(0);
    expect(data.indices.length).toBe(0);
  });

  it("BLOCK_AIR is never meshed; a solid-filled chunk culls all interior faces", () => {
    const { mesher } = seededMesher();

    const chunkAir = new Chunk();
    chunkAir.fill(BLOCK_AIR);
    expect(mesher.build(chunkAir).triangleCount).toBe(0);

    // 16x16x16 = 4096 voxels; only the six outermost shell faces remain: 6 * 16*16 = 1536 faces
    // -> 3072 triangles. This is the strongest possible proof that neighbouring solids fully
    // cull interior faces.
    const chunkSolid = new Chunk();
    chunkSolid.fill(BLOCK_DIRT);
    expect(mesher.build(chunkSolid).triangleCount).toBe(3072);
  });
});

describe("NaiveMesher — emitted vertex data (regression: M0 all-zero positions)", () => {
  it("every face emits 4 distinct, real voxel-corner vertices (no (0,0,0) leftovers)", () => {
    // Regression: pass 2 wrote all four quad corners into a single position slot, leaving
    // three of every four vertices at (0,0,0) -- every triangle collapsed to zero area and
    // the chunk rendered nothing (the M0 black screen). Assert real, distinct corners.
    const data = buildOne(5, 5, 5, BLOCK_DIRT);
    const faceCount = data.triangleCount / 2;
    expect(faceCount).toBe(6);
    for (let f = 0; f < faceCount; f++) {
      const corners: string[] = [];
      for (let k = 0; k < 4; k++) {
        const base = (f * 4 + k) * 3;
        const px = data.positions[base]!;
        const py = data.positions[base + 1]!;
        const pz = data.positions[base + 2]!;
        // Every corner coordinate must be a real voxel corner (exactly 5 or 6 here), never 0.
        expect(px).toBeGreaterThanOrEqual(5);
        expect(px).toBeLessThanOrEqual(6);
        expect(py).toBeGreaterThanOrEqual(5);
        expect(py).toBeLessThanOrEqual(6);
        expect(pz).toBeGreaterThanOrEqual(5);
        expect(pz).toBeLessThanOrEqual(6);
        corners.push(`${px},${py},${pz}`);
      }
      // The 4 corners of a quad must be mutually distinct.
      expect(new Set(corners).size).toBe(4);
    }
  });

  it("every emitted triangle winds counter-clockwise around its outward normal (real data)", () => {
    const data = buildOne(7, 8, 9, BLOCK_STONE);
    const faceCount = data.triangleCount / 2;
    expect(faceCount).toBe(6);
    for (let f = 0; f < faceCount; f++) {
      const p = (k: number): [number, number, number] => {
        const base = (f * 4 + k) * 3;
        return [data.positions[base]!, data.positions[base + 1]!, data.positions[base + 2]!];
      };
      const n = (): [number, number, number] => {
        const base = f * 4 * 3;
        return [data.normals[base]!, data.normals[base + 1]!, data.normals[base + 2]!];
      };
      const [nx, ny, nz] = n();
      for (const tri of [
        [0, 1, 2],
        [0, 2, 3],
      ] as const) {
        const [x0, y0, z0] = p(tri[0]);
        const [x1, y1, z1] = p(tri[1]);
        const [x2, y2, z2] = p(tri[2]);
        const ux = x1 - x0;
        const uy = y1 - y0;
        const uz = z1 - z0;
        const vx = x2 - x0;
        const vy = y2 - y0;
        const vz = z2 - z0;
        const cx = uy * vz - uz * vy;
        const cy = uz * vx - ux * vz;
        const cz = ux * vy - uy * vx;
        // cross(edge1, edge2) must point ALONG the face's outward normal, never against it
        // and never zero (zero area == the all-zero-positions regression).
        const dot = cx * nx + cy * ny + cz * nz;
        expect(dot, `face ${f} tri ${tri.join("")} degenerate or inverted`).toBeGreaterThan(0);
      }
    }
  });

  it("maps UVs upright on all vertical side faces (top vertex has V=1, bottom vertex has V=0)", () => {
    const data = buildOne(5, 5, 5, BLOCK_STONE);
    const faceCount = data.triangleCount / 2;
    for (let f = 0; f < faceCount; f++) {
      const normalY = data.normals[f * 12 + 1]!;
      // Side faces have normal Y == 0
      if (normalY !== 0) continue;

      for (let k = 0; k < 4; k++) {
        const py = data.positions[(f * 4 + k) * 3 + 1]!;
        const v = data.uvs[(f * 4 + k) * 2 + 1]!;
        if (py === 6) {
          // Top edge of block at y=5..6
          expect(
            v,
            `top vertex must have V=1 (face normal ${data.normals[f * 12]},${normalY},${data.normals[f * 12 + 2]})`,
          ).toBe(1);
        } else if (py === 5) {
          // Bottom edge of block at y=5..6
          expect(
            v,
            `bottom vertex must have V=0 (face normal ${data.normals[f * 12]},${normalY},${data.normals[f * 12 + 2]})`,
          ).toBe(0);
        }
      }
    }
  });
});
