import { describe, expect, it } from "vitest";
import {
  BlockRegistry,
  BLOCK_AIR,
  BLOCK_DIRT,
  BLOCK_GRASS,
  BLOCK_STONE,
} from "../src/voxel/BlockRegistry.js";
import { Chunk } from "../src/voxel/Chunk.js";
import {
  buildMesh,
  buildNeighborRim,
  descriptorFromRegistry,
  FACES,
  RIM_INDEX_ORDER,
  type FaceDir,
  type VoxelMeshData,
} from "../src/voxel/mesh/NaiveMesher.js";

/**
 * M1 seam tests: the naive mesher must cull chunk-border faces against the NEIGHBOR chunk's
 * data (via the extracted border-plane rims), never assume air -- otherwise two adjacent chunks
 * render a double wall ("crack") between them. These tests pin the exact boundary rule: for
 * every boundary cell pair, the exposed face is emitted EXACTLY once (0 when both or none are
 * solid, 1 when exactly one is). They also pin the rim extraction convention that both the mesh
 * worker and the main-thread rim builder share (`RIM_INDEX_ORDER`).
 */

function seededRegistry(): BlockRegistry {
  const registry = new BlockRegistry();
  BlockRegistry.seed(registry);
  return registry;
}

/**
 * Meshes a chunk the way ChunkWorld + the mesh worker will: own voxels + the border planes of
 * the four horizontal neighbors. The rim handed for a direction is the neighbor's plane FACING
 * this chunk (e.g. `px` -> the right neighbor's localX=0 plane, `nx` -> the left neighbor's
 * localX=15 plane). This is the single seam convention main/worker both follow.
 */
function meshWithNeighbors(
  voxels: Uint8Array,
  world: ReadonlyMap<string, Uint8Array>,
  cx: number,
  cz: number,
): VoxelMeshData {
  const neighbors: Partial<Record<FaceDir, Uint8Array>> = {};
  const left = world.get(`0,${cx - 1},${cz}`);
  const right = world.get(`0,${cx + 1},${cz}`);
  const back = world.get(`0,${cx},${cz - 1}`);
  const front = world.get(`0,${cx},${cz + 1}`);
  if (left) neighbors.nx = buildNeighborRim(left, "nx");
  if (right) neighbors.px = buildNeighborRim(right, "px");
  if (back) neighbors.nz = buildNeighborRim(back, "nz");
  if (front) neighbors.pz = buildNeighborRim(front, "pz");
  return buildMesh({
    voxels,
    descriptor: descriptorFromRegistry(seededRegistry()),
    neighbors,
  });
}

describe("buildNeighborRim — border-plane extraction convention (RIM_INDEX_ORDER)", () => {
  it("extracts the +X-facing plane (localX=0) of a neighbor, indexed y + z*16", () => {
    const n = new Chunk();
    // Distinctive pattern on n's local X=0 plane: value = 1 + y + z*4 (max 1+15+60=76, no
    // Uint8Array overflow) so every cell is unambiguous and unique per row family.
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y < 16; y++) {
        n.voxels[n.indexOf(0, y, z)] = 1 + y + z * 4;
      }
    }
    const rim = buildNeighborRim(n.voxels, "px"); // plane facing the -X observer = localX 0
    expect(rim.length).toBe(16 * 16);
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y < 16; y++) {
        // Free axes for px are (B=y, C=z) -> byte index = y + z*16 (RIM_INDEX_ORDER.px).
        expect(rim[y + z * 16]).toBe(1 + y + z * 4);
      }
    }
  });

  it("the opposite observer (nx) reads the LOCALX=15 plane, not X=0", () => {
    const n = new Chunk();
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y < 16; y++) {
        n.voxels[n.indexOf(0, y, z)] = 1 + y + z * 4; // X=0 plane
        n.voxels[n.indexOf(15, y, z)] = 101 + y + z * 4; // X=15 plane (different family)
      }
    }
    const rimNx = buildNeighborRim(n.voxels, "nx"); // the -X observer needs localX=15
    const rimPx = buildNeighborRim(n.voxels, "px"); // the +X observer needs localX=0
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y < 16; y++) {
        expect(rimNx[y + z * 16]).toBe(101 + y + z * 4);
        expect(rimPx[y + z * 16]).toBe(1 + y + z * 4);
      }
    }
  });

  it("rim ordering table is self-consistent for all six directions", () => {
    const axisOf = (d: FaceDir): "x" | "y" | "z" =>
      d === "px" || d === "nx" ? "x" : d === "py" || d === "ny" ? "y" : "z";
    for (const dir of ["px", "nx", "py", "ny", "pz", "nz"] as const) {
      const { b, c } = RIM_INDEX_ORDER[dir];
      const used = new Set([axisOf(dir), b, c]);
      expect(used.size, `RIM_INDEX_ORDER.${dir} reuses the normal axis as a free axis`).toBe(3);
    }
  });

  it("every face template maps to an addressable FaceDir (no silent un-named faces)", () => {
    for (const face of FACES) {
      const key = face.neighborOffset.join("");
      const dir: FaceDir =
        key === "1,0,0"
          ? "px"
          : key === "-1,0,0"
            ? "nx"
            : key === "0,1,0"
              ? "py"
              : key === "0,-1,0"
                ? "ny"
                : key === "0,0,1"
                  ? "pz"
                  : "nz";
      expect(Object.hasOwn(RIM_INDEX_ORDER, dir), `${dir} must be addressable`).toBe(true);
    }
  });
});

/**
 * Counts, per boundary column z (0..15), how many boundary faces the mesher emitted on the
 * given axis/sign side at the chunk border row y=8. Assumes the fixed emission order of
 * `buildMesh`: face f's first corner sits at positions[f*12].z for a +z/-z-free axis face.
 */
function boundaryFacesByColumn(mesh: VoxelMeshData, axis: "x" | "z", sign: 1 | -1): number[] {
  const perColumn = new Array<number>(16).fill(0);
  const axisIndex = axis === "x" ? 0 : 2;
  for (let f = 0; f < mesh.triangleCount / 2; f++) {
    const normalAxis = mesh.normals[f * 12 + axisIndex]!;
    if (normalAxis !== sign) continue;
    // First corner's z coordinate identifies the column this boundary face spans.
    const z = Math.round(mesh.positions[f * 12 + 2]!);
    if (z >= 0 && z < 16) perColumn[z] = (perColumn[z] ?? 0) + 1;
  }
  return perColumn;
}

describe("M1 seam culling — boundary emission follows the exactly-once truth table", () => {
  it("every boundary column emits exactly the XOR of the two solid states", () => {
    // Truth table across 16 columns: 0-3 both solid (0), 4-7 both air (0), 8-11 only C solid (1
    // on C's side), 12-15 only N solid (1 on N's side). All at y=8 to isolate the boundary.
    const c = new Chunk();
    const n = new Chunk();
    for (let z = 0; z < 16; z++) {
      const cSolid = z < 4 || (z >= 8 && z < 12);
      const nSolid = z < 4 || (z >= 12 && z < 16);
      if (cSolid) c.setBlock(15, 8, z, BLOCK_DIRT);
      if (nSolid) n.setBlock(0, 8, z, BLOCK_DIRT);
    }
    const world = new Map<string, Uint8Array>([
      ["0,0,0", c.voxels],
      ["0,1,0", n.voxels],
    ]);
    const cMesh = meshWithNeighbors(c.voxels, world, 0, 0);
    const nMesh = meshWithNeighbors(n.voxels, world, 1, 0);

    const cPlusX = boundaryFacesByColumn(cMesh, "x", 1); // C's +X boundary faces
    const nMinusX = boundaryFacesByColumn(nMesh, "x", -1); // N's -X boundary faces

    for (let z = 0; z < 16; z++) {
      const cSolid = z < 4 || (z >= 8 && z < 12);
      const nSolid = z < 4 || (z >= 12 && z < 16);
      const expected = cSolid !== nSolid ? 1 : 0; // XOR of the two solid states
      const actual = cPlusX[z]! + nMinusX[z]!;
      expect(actual, `boundary column z=${z}: exactly-once rule violated`).toBe(expected);
    }
    // Side-level breakdown: 8-11 emitted on C only, 12-15 on N only.
    for (let z = 8; z < 12; z++) {
      expect(cPlusX[z]).toBe(1);
      expect(nMinusX[z]).toBe(0);
    }
    for (let z = 12; z < 16; z++) {
      expect(cPlusX[z]).toBe(0);
      expect(nMinusX[z]).toBe(1);
    }
  });

  it("a fully solid pair across a boundary renders no boundary face (crack closed)", () => {
    // C solid at x=15, N solid at x=0, same column: both boundary faces must be culled (inner
    // wall) -- this is exactly the M0 seam bug (border=air would emit BOTH as a double wall).
    const c = new Chunk();
    const n = new Chunk();
    c.setBlock(15, 8, 8, BLOCK_DIRT);
    n.setBlock(0, 8, 8, BLOCK_DIRT);
    const world = new Map<string, Uint8Array>([
      ["0,0,0", c.voxels],
      ["0,1,0", n.voxels],
    ]);
    const cMesh = meshWithNeighbors(c.voxels, world, 0, 0);
    const nMesh = meshWithNeighbors(n.voxels, world, 1, 0);
    expect(boundaryFacesByColumn(cMesh, "x", 1)[8]).toBe(0);
    expect(boundaryFacesByColumn(nMesh, "x", -1)[8]).toBe(0);
  });

  it("an exposed boundary face is emitted by exactly one side", () => {
    // C solid at x=15, N empty at that column: the face is exposed and must appear ONCE (C side).
    const c = new Chunk();
    const n = new Chunk();
    c.setBlock(15, 8, 8, BLOCK_DIRT);
    const world = new Map<string, Uint8Array>([
      ["0,0,0", c.voxels],
      ["0,1,0", n.voxels],
    ]);
    const cMesh = meshWithNeighbors(c.voxels, world, 0, 0);
    const nMesh = meshWithNeighbors(n.voxels, world, 1, 0);
    expect(boundaryFacesByColumn(cMesh, "x", 1)[8]).toBe(1);
    expect(boundaryFacesByColumn(nMesh, "x", -1)[8]).toBe(0);
  });
});

describe("M1 worker payload — single source of truth across the structured-clone boundary", () => {
  it("descriptorFromRegistry matches registry/face-layer semantics exactly", () => {
    const descriptor = descriptorFromRegistry(seededRegistry());
    const byId = new Map(descriptor.map((e) => [e.id, e]));
    expect(byId.has(BLOCK_AIR)).toBe(false); // AIR is never registered
    expect(byId.get(BLOCK_GRASS)).toMatchObject({
      opaque: true,
      layers: [0, 1, 3], // top=grass, bottom=dirt, side=grass_side (M2 MC-korrekt)
    });
    expect(byId.get(BLOCK_DIRT)).toMatchObject({ opaque: true, layers: [1, 1, 1] });
    expect(byId.get(BLOCK_STONE)).toMatchObject({ opaque: true, layers: [2, 2, 2] });
  });

  it("meshing with a transferred (cloned) descriptor produces byte-identical output", () => {
    const c = new Chunk();
    c.setBlock(5, 5, 5, BLOCK_GRASS);
    c.setBlock(5, 6, 5, BLOCK_DIRT);
    const descriptor = descriptorFromRegistry(seededRegistry());

    // Structured clone round-trip (the worker receives deep copies of descriptor + voxels).
    const clonedDescriptor = JSON.parse(JSON.stringify(descriptor)) as typeof descriptor;
    const expected = buildMesh({ voxels: c.voxels, descriptor });
    const cloned = buildMesh({ voxels: c.voxels.slice(), descriptor: clonedDescriptor });
    expect(cloned.triangleCount).toBe(expected.triangleCount);
    expect(Array.from(cloned.positions)).toEqual(Array.from(expected.positions));
    expect(Array.from(cloned.colors)).toEqual(Array.from(expected.colors));
    expect(Array.from(cloned.indices)).toEqual(Array.from(expected.indices));
  });

  it("a chunk meshed twice with the same neighbor rims is deterministic", () => {
    const c = new Chunk();
    const n = new Chunk();
    c.setBlock(15, 8, 8, BLOCK_DIRT);
    const world = new Map<string, Uint8Array>([
      ["0,0,0", c.voxels],
      ["0,1,0", n.voxels],
    ]);
    const a = meshWithNeighbors(c.voxels, world, 0, 0);
    const b = meshWithNeighbors(c.voxels, world, 0, 0);
    expect(a.triangleCount).toBe(b.triangleCount);
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
});
