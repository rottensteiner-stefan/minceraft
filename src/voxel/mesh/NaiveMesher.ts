import type { BlockRegistry } from "../BlockRegistry.js";
import { BLOCK_AIR, faceAxisForNormal } from "../BlockRegistry.js";
import { Chunk } from "../Chunk.js";
import {
  FLOOD_OFFSETS,
  combineLight,
  daylightFactorAt,
  floodSealedness,
} from "../light/daylight.js";

/**
 * Output of the mesher: typed vertex/index arrays shaped exactly like the engine's
 * `GeometryDataInterface` but WITHOUT any engine import -- pure data so it stays testable in
 * node and structured-clone-able for the M1 worker meshing handoff (the mesh worker receives
 * this shape back via `postMessage`).
 *
 * Per-vertex `colors` packs the atlas layer in `.r` (the engine binds `colors` at the fixed
 * attribute location 11 / `a_color`, read by the block shader), the baked vertex-Occlusion
 * factor in `.g` (0..1, Minceraft 4-level scheme -- M2), and the M3 baked light factor in `.b`
 * (0..1, daylight height rule x cheapest point flood, worker-built like the AO). `.a` stays 1.
 * `colors.g` is 1 for transparent (water) faces, which get no block AO, and their `.b` is
 * always full light (a translucent surface is never shaded by the flood).
 */
export interface VoxelMeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint16Array | Uint32Array;
  triangleCount: number;
}

/** A face template: outward normal N, and tangent axes (TA, TB) with `cross(TA, TB) === N`.
 * A block at (x, y, z) occupies the unit cube [x, x+1] × [y, y+1] × [z, z+1]; `displacement`
 * moves the corner `(cu, cv) ∈ {0,1}²` basis onto the correct OUTWARD boundary plane, so the
 * quad corners always lie on the voxel's own faces -- never shifted into a neighbour cell
 * (regression: an all-zero/degenerate mesh would leave every triangle with zero area). */
export interface FaceTemplate {
  normal: readonly [number, number, number];
  tangentA: readonly [number, number, number];
  tangentB: readonly [number, number, number];
  /** Offset added to the block base so the quad sits on the outward face plane. */
  displacement: readonly [number, number, number];
  neighborOffset: readonly [number, number, number];
  /**
   * Explicit UV corners mapping (u, v) in {0, 1}² for quad corners k=0..3.
   * Ensures textures stand upright and un-rotated on all faces regardless of tangent basis.
   */
  uvCorners: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
}

/**
 * All six face templates. Exposed for the winding test (and imported by the mesh worker --
 * the worker must never duplicate this table).
 */
export const FACES: readonly FaceTemplate[] = [
  // +X -- plane x+1
  {
    normal: [1, 0, 0],
    tangentA: [0, 1, 0],
    tangentB: [0, 0, 1],
    displacement: [1, 0, 0],
    neighborOffset: [1, 0, 0],
    uvCorners: [
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  },
  // -X -- plane x
  {
    normal: [-1, 0, 0],
    tangentA: [0, 0, 1],
    tangentB: [0, 1, 0],
    displacement: [0, 0, 0],
    neighborOffset: [-1, 0, 0],
    uvCorners: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  },
  // +Y -- plane y+1
  {
    normal: [0, 1, 0],
    tangentA: [0, 0, 1],
    tangentB: [1, 0, 0],
    displacement: [0, 1, 0],
    neighborOffset: [0, 1, 0],
    uvCorners: [
      [0, 1],
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  },
  // -Y -- plane y
  {
    normal: [0, -1, 0],
    tangentA: [1, 0, 0],
    tangentB: [0, 0, 1],
    displacement: [0, 0, 0],
    neighborOffset: [0, -1, 0],
    uvCorners: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  },
  // +Z -- plane z+1
  {
    normal: [0, 0, 1],
    tangentA: [1, 0, 0],
    tangentB: [0, 1, 0],
    displacement: [0, 0, 1],
    neighborOffset: [0, 0, 1],
    uvCorners: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  },
  // -Z -- plane z
  {
    normal: [0, 0, -1],
    tangentA: [0, 1, 0],
    tangentB: [1, 0, 0],
    displacement: [0, 0, 0],
    neighborOffset: [0, 0, -1],
    uvCorners: [
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  },
];

/**
 * M1 neighbor-seam convention (dossier §4.2 M1 "keine Naht"). A chunk that would mesh a face on
 * its border must consult the ADJACENT chunk's block data instead of assuming air -- but it must
 * never import the neighbor chunk wholesale. The protocol therefore passes, per neighbor, only
 * the single 16×16 border plane facing this chunk (256 block ids) as an opaque `Uint8Array`.
 *
 * A rim is indexed with the two FREE local axes of the neighbor in a fixed (B, C) order:
 *
 *   - px / nx (normal axis x)   -> B = y, C = z,  rim[...] = neighbor.voxels[localX + z*16 + y*256]
 *   - py / ny (normal axis y)   -> B = x, C = z,  rim[...] = neighbor.voxels[localX + z*16 + y*256]
 *   - pz / nz (normal axis z)   -> B = x, C = y,  rim[...] = neighbor.voxels[localX + z*16 + y*256]
 *
 * Byte index = B + C*SIZE. Both the mesher (inside the worker) and the rim builder (main
 * thread, see `buildNeighborRims`) resolve this table -- a mismatch would instantly show up as a
 * seam/crack, which the seam-parity test pins.
 */
export const RIM_INDEX_ORDER: Readonly<
  Record<FaceDir, { readonly b: "x" | "y" | "z"; readonly c: "x" | "y" | "z" }>
> = {
  px: { b: "y", c: "z" },
  nx: { b: "y", c: "z" },
  py: { b: "x", c: "z" },
  ny: { b: "x", c: "z" },
  pz: { b: "x", c: "y" },
  nz: { b: "x", c: "y" },
};

/** Which of the six axis-neighbors a border cell points at. */
export type FaceDir = "px" | "nx" | "py" | "ny" | "pz" | "nz";

/** Maps a face's `neighborOffset` to its `FaceDir` (single source of truth for both directions). */
export function faceDirForOffset(offset: readonly [number, number, number]): FaceDir {
  if (offset[0] !== 0) return offset[0]! > 0 ? "px" : "nx";
  if (offset[1] !== 0) return offset[1]! > 0 ? "py" : "ny";
  return offset[2]! > 0 ? "pz" : "nz";
}

/**
 * Serializable registry subset the mesher needs: opacity (for culling) and the atlas layer per
 * face axis. Deliberately NOT the `BlockRegistry` class -- this plain array survives structured
 * clone into the mesh worker, and keeps the worker free of app imports beyond the pure mesher.
 */
export interface MeshBlockDescriptorEntry {
  id: number;
  opaque: boolean;
  /** Whether a player AABB collides with the block (used by the M1 sweep; ignored by the mesher). */
  collidable: boolean;
  /** Atlas layer per face axis in `FACE_AXIS` order (UP=0, DOWN=1, SIDE=2), see `layersFor`. */
  layers: readonly [number, number, number];
}

/** Builds the transferable descriptor from a registry. `Map` is avoided on purpose (transport). */
export function descriptorFromRegistry(registry: BlockRegistry): MeshBlockDescriptorEntry[] {
  return registry.definitions().map((def) => ({
    id: def.id,
    opaque: !def.transparent,
    collidable: def.collidable,
    layers: layersFor(def),
  }));
}

function layersFor(def: {
  faceLayers: { top: number; bottom: number; side: number };
}): readonly [number, number, number] {
  return [def.faceLayers.top, def.faceLayers.bottom, def.faceLayers.side];
}

/**
 * Extracts the 16×16 border plane of `neighborVoxels` (a full chunk, Chunk.SIZE³) that faces
 * THIS chunk across the given direction. The returned plane is indexed per `RIM_INDEX_ORDER` and
 * is what gets handed to the worker (M1 seam culling). Pure copy -- never aliases the source.
 */
export function buildNeighborRim(neighborVoxels: Uint8Array, dir: FaceDir): Uint8Array {
  const size = Chunk.SIZE;
  const rim = new Uint8Array(size * size);
  for (let c = 0; c < size; c++) {
    for (let b = 0; b < size; b++) {
      // Local coordinate of the plane inside the neighbor:
      //   px -> x=0   nx -> x=size-1   py -> y=0   ny -> y=size-1   pz -> z=0   nz -> z=size-1
      let lx = b;
      let ly = c;
      let lz = b;
      switch (dir) {
        case "px":
          lx = 0;
          ly = b;
          lz = c;
          break;
        case "nx":
          lx = size - 1;
          ly = b;
          lz = c;
          break;
        case "py":
          lx = b;
          ly = 0;
          lz = c;
          break;
        case "ny":
          lx = b;
          ly = size - 1;
          lz = c;
          break;
        case "pz":
          lx = b;
          ly = c;
          lz = 0;
          break;
        case "nz":
          lx = b;
          ly = c;
          lz = size - 1;
          break;
      }
      rim[b + c * size] = neighborVoxels[lx + lz * size + ly * size * size]!;
    }
  }
  return rim;
}

/**
 * M2 AO seam extension: the four horizontal DIAGONAL neighbors, tagged by the signs of their
 * offset from this chunk ("p" = +, "n" = -; first char is X, second Z). Each diagonal chunk
 * hands over ONLY the 16-tall vertical column at ITS corner adjacent to this chunk -- that is
 * the single cell column the vertex-AO of a 4-chunk-corner face would otherwise miss, which
 * would show as a bright "AO leak". Shipping 4 × 16 bytes keeps the AO seam-exact for every
 * vertex without importing any neighbor chunk wholesale (M1 rim contract, extended).
 */
export type CornerDir = "pp" | "pn" | "np" | "nn";

/** Local (x, z) corner of the diagonal chunk that faces THIS chunk, per `CornerDir`. */
export const CORNER_COLUMNS: Readonly<Record<CornerDir, readonly [number, number]>> = {
  pp: [0, 0], // diagonal at +X, +Z  -> its (0, 0) corner
  pn: [0, 15], // diagonal at +X, -Z  -> its (0, 15) corner
  np: [15, 0], // diagonal at -X, +Z  -> its (15, 0) corner
  nn: [15, 15], // diagonal at -X, -Z  -> its (15, 15) corner
};

/** Extracts the 16-tall corner column of `neighborVoxels` (a full chunk) that faces THIS chunk
 *  across the given diagonal. Pure copy, indexed by local Y (0..15) -- never aliases the source. */
export function buildNeighborCorner(neighborVoxels: Uint8Array, corner: CornerDir): Uint8Array {
  const size = Chunk.SIZE;
  const pos = CORNER_COLUMNS[corner];
  const column = new Uint8Array(size);
  for (let y = 0; y < size; y++) {
    column[y] = neighborVoxels[pos[0] + pos[1] * size + y * size * size]!;
  }
  return column;
}

/**
 * Input of the pure mesher. `voxels` is the chunk's raw block-id buffer (Chunk.SIZE³),
 * `descriptor` the transferable registry subset, `neighbors` the optional border planes of the
 * six axis-neighbors and `neighborCorners` the optional AO corner columns of the four diagonal
 * neighbors. A missing neighbor plane/corner means "air" (a world/vertical edge, or the M0
 * single-chunk semantics) -- the seam contract is exact once the caller supplies all of them
 * (`ChunkWorld` gates meshing on all 8 neighbors being present, M2).
 */
export interface MeshBuildInput {
  voxels: Uint8Array;
  descriptor: readonly MeshBlockDescriptorEntry[];
  neighbors?: Partial<Record<FaceDir, Uint8Array>>;
  /** `undefined` (or absent) means "no corner data": the M0/M1 single-chunk air semantics. */
  neighborCorners?: Partial<Record<CornerDir, Uint8Array>> | undefined;
}

/**
 * Naive visible-face mesher (dossier §1.4 method (b), the production baseline; greedy is a later
 * milestone -- M5, §4.4 #3). Pure function: no engine import, no class, no global state -- this
 * exact code path runs on the main thread (unit tests, foreground fallback) AND inside the mesh
 * worker (M1). Faces are emitted only where the neighbor cell is non-opaque; neighbor cells on
 * the chunk border resolve through the `neighbors` rim planes so chunk boundaries cull exactly
 * like interior faces (no cracks, no seams, no double faces).
 *
 * The derived `cross(tangentA, tangentB) === normal` constraint guarantees correct winding for
 * the engine's back-face culling by construction (asserted in `NaiveMesher.test.ts`).
 */
export function buildMesh(input: MeshBuildInput): VoxelMeshData {
  const size = Chunk.SIZE;
  if (input.voxels.length !== size * size * size) {
    throw new Error(
      `[buildMesh] expected a ${size}^3 voxel buffer (${size * size * size} bytes), got ${input.voxels.length}`,
    );
  }

  const descriptor = new Map<number, MeshBlockDescriptorEntry>();
  for (const entry of input.descriptor) descriptor.set(entry.id, entry);
  const neighbors: Partial<Record<FaceDir, Uint8Array>> = input.neighbors ?? {};

  /** Whether the cell at (x,y,z) -- local OR across a border -- is opaque. Missing neighbor
   *  data and unknown ids read as non-opaque (the cell does not cull). */
  const isSolidAt = (x: number, y: number, z: number): boolean => {
    if (x < 0 || y < 0 || z < 0 || x >= size || y >= size || z >= size) {
      const dir = faceDirForOffset([
        Math.sign(x) as 1 | 0 | -1,
        Math.sign(y) as 1 | 0 | -1,
        Math.sign(z) as 1 | 0 | -1,
      ]);
      const rim = neighbors[dir];
      if (!rim) return false; // no neighbor data -> exposed (M0 edge semantics)
      const order = RIM_INDEX_ORDER[dir];
      const b = order.b === "x" ? x : order.b === "y" ? y : z;
      const c = order.c === "x" ? x : order.c === "y" ? y : z;
      const id = rim[b + c * size];
      if (id === undefined) return false;
      return descriptor.get(id)?.opaque ?? false;
    }
    return descriptor.get(input.voxels[x + z * size + y * size * size]!)?.opaque ?? false;
  };

  /** Raw block id at (x,y,z), local or across a border: axis-out cells resolve through the
   *  `neighbors` rim planes, a 4-chunk-corner cell through the `neighborCorners` AO columns
   *  (M2 seam-exact AO), and out-of-world Y reads as air. Missing planes/corners read as air
   *  (M0/world-edge semantics). This is the ONLY border-aware raw-id accessor; the AO and the
   *  transparent-face passes use it -- never `input.voxels` directly. */
  const cellIdAt = (x: number, y: number, z: number): number => {
    if (y < 0 || y >= size) return BLOCK_AIR;
    const xOut = x < 0 ? -1 : x >= size ? 1 : 0;
    const zOut = z < 0 ? -1 : z >= size ? 1 : 0;
    if (xOut !== 0 && zOut !== 0) {
      const cornerDir = `${xOut > 0 ? "p" : "n"}${zOut > 0 ? "p" : "n"}` as CornerDir;
      const column = input.neighborCorners?.[cornerDir];
      return column ? column[y]! : BLOCK_AIR;
    }
    if (xOut !== 0) {
      const dir: FaceDir = xOut > 0 ? "px" : "nx";
      const rim = neighbors[dir];
      if (!rim) return BLOCK_AIR;
      return rim[y + z * size] ?? BLOCK_AIR;
    }
    if (zOut !== 0) {
      const dir: FaceDir = zOut > 0 ? "pz" : "nz";
      const rim = neighbors[dir];
      if (!rim) return BLOCK_AIR;
      return rim[x + y * size] ?? BLOCK_AIR;
    }
    return input.voxels[x + z * size + y * size * size]!;
  };

  // M3 baked light (D4/D5): per FACE, lightFactor = daylight height rule (the cell's OWN column
  // -- seam-exact by construction, no cross-chunk data) x cheapest point flood. The flood probes
  // the AIR RING on the face's OUTER side (single-axis FLOOD_OFFSETS around the adjacent air
  // cell): a truly sealed pocket (0 open ring cells) darkens hard, ANY openness keeps full flood
  // weight (D5 hard cut, no exact flooding). Every visible face implies an open neighbor, so on
  // heightfield terrain the flood stays inert (vertical openness in the ring) -- it only fires on
  // genuinely enclosed volumes (sealed rooms/pockets), which is exactly D5's scope.
  const columnSurfaceY = new Map<number, number>();
  const surfaceOfColumn = (x: number, z: number): number => {
    const key = x + z * size;
    const cached = columnSurfaceY.get(key);
    if (cached !== undefined) return cached;
    let surf = -1;
    for (let y = size - 1; y >= 0; y--) {
      const id = input.voxels[x + z * size + y * size * size]!;
      if (descriptor.get(id)?.opaque ?? false) {
        surf = y;
        break;
      }
    }
    columnSurfaceY.set(key, surf);
    return surf;
  };

  const lightForFace = (x: number, y: number, z: number, face: FaceTemplate): number => {
    const ax = x + face.neighborOffset[0]!;
    const ay = y + face.neighborOffset[1]!;
    const az = z + face.neighborOffset[2]!;
    let open = 0;
    for (const [dx, dy, dz] of FLOOD_OFFSETS) {
      if (!isSolidAt(ax + dx, ay + dy, az + dz)) open++;
    }
    return combineLight(daylightFactorAt(y, surfaceOfColumn(x, z)), floodSealedness(open));
  };

  /** Minceraft-treue 4-Level-Vertex-Occlusion (D5): occ in {0..3} -> Faktor in {1, 2/3, 1/3, 0},
   *  0 = dunkelste Vertiefung. Stichproben sind die beiden In-Ebene-Kanten-Nachbarn und der
   *  In-Ebene-Corner in der AUSSEREN-Face-Schicht (block + Face-Normale): ein komplett
   *  eingeschlossener Corner ist am dunkelsten, ein offener bleibt hell (MC-Look). Eine
   *  Own-Plane-Stichprobe würde jede geteilte Blockkante von flachem Gelände verdunkeln --
   *  bewusst die Aussen-Schicht. Rand-Scheitel greifen über die Rims + Ecken-Spalten und sind
   *  damit byte-identisch zum Nachbar-Chunk (ChunkWorld gated auf 8 Nachbarn). */
  const vertexOcclusionFactors = (
    x: number,
    y: number,
    z: number,
    face: FaceTemplate,
  ): readonly [number, number, number, number] => {
    const n = face.normal;
    const ta = face.tangentA;
    const tb = face.tangentB;
    const factors: [number, number, number, number] = [1, 1, 1, 1];
    const corners: readonly (readonly [number, number])[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let k = 0; k < 4; k++) {
      const sA = corners[k]![0] === 0 ? -1 : 1;
      const sB = corners[k]![1] === 0 ? -1 : 1;
      const sideAX = x + n[0]! + sA * ta[0]!;
      const sideAY = y + n[1]! + sA * ta[1]!;
      const sideAZ = z + n[2]! + sA * ta[2]!;
      const sideBX = x + n[0]! + sB * tb[0]!;
      const sideBY = y + n[1]! + sB * tb[1]!;
      const sideBZ = z + n[2]! + sB * tb[2]!;
      const cornerX = x + n[0]! + sA * ta[0]! + sB * tb[0]!;
      const cornerY = y + n[1]! + sA * ta[1]! + sB * tb[1]!;
      const cornerZ = z + n[2]! + sA * ta[2]! + sB * tb[2]!;
      const a = (descriptor.get(cellIdAt(sideAX, sideAY, sideAZ))?.opaque ?? false) ? 1 : 0;
      const b = (descriptor.get(cellIdAt(sideBX, sideBY, sideBZ))?.opaque ?? false) ? 1 : 0;
      const d = (descriptor.get(cellIdAt(cornerX, cornerY, cornerZ))?.opaque ?? false) ? 1 : 0;
      const occ = a === 1 && b === 1 ? 3 : a + b + d;
      factors[k] = 1 - occ / 3;
    }
    return factors;
  };

  const visibleFaces: Array<{
    x: number;
    y: number;
    z: number;
    face: FaceTemplate;
    layer: number;
    ao: readonly [number, number, number, number];
    light: number;
  }> = [];

  // Pass 1 -- collect opaque visible faces (also sizes the output arrays exactly). AO is baked
  // per vertex; border faces sample the neighbor planes through the rims + 4-chunk-corner
  // column, so the seam vertices are byte-identical to what the neighbor chunk would compute.
  for (let y = 0; y < size; y++) {
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const id = input.voxels[x + z * size + y * size * size]!;
        if (!(descriptor.get(id)?.opaque ?? false)) continue;

        for (const face of FACES) {
          const nx = x + face.neighborOffset[0]!;
          const ny = y + face.neighborOffset[1]!;
          const nz = z + face.neighborOffset[2]!;
          if (isSolidAt(nx, ny, nz)) continue;

          const axis = faceAxisForNormal(face.normal[1]!);
          const layers = descriptor.get(id)!.layers;
          const layer = layers[axis]!;
          visibleFaces.push({
            x,
            y,
            z,
            face,
            layer,
            ao: vertexOcclusionFactors(x, y, z, face),
            light: lightForFace(x, y, z, face),
          });
        }
      }
    }
  }

  // Pass 1.5 -- collect TRANSPARENT (water) faces (D3): only faces directly against AIR are
  // emitted -- no water-water or water-solid surfaces, which avoids z-fighting with the opaque
  // pass by construction. Water carries no block AO (ao = 1,1,1,1): a translucent surface must
  // not be crevice-darkened, and the transparent pass stays free of the corner-column logic.
  for (let y = 0; y < size; y++) {
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const id = input.voxels[x + z * size + y * size * size]!;
        const def = descriptor.get(id);
        if (!def || def.opaque) continue;

        for (const face of FACES) {
          const nx = x + face.neighborOffset[0]!;
          const ny = y + face.neighborOffset[1]!;
          const nz = z + face.neighborOffset[2]!;
          if (cellIdAt(nx, ny, nz) !== BLOCK_AIR) continue;

          const axis = faceAxisForNormal(face.normal[1]!);
          const layer = def.layers[axis]!;
          // Water faces carry no AO and no flood shading (translucent surfaces stay fully lit).
          visibleFaces.push({ x, y, z, face, layer, ao: [1, 1, 1, 1], light: 1 });
        }
      }
    }
  }

  const vertexCount = visibleFaces.length * 4;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 4);
  const indices =
    vertexCount > 65535
      ? new Uint32Array(visibleFaces.length * 6)
      : new Uint16Array(visibleFaces.length * 6);

  // Pass 2 -- emit geometry. Each face spans the full atlas swatch (uv 0..1); the atlas
  // layer travels in `colors.r`. Winding follows the (TA, TB) basis so `cross` of the
  // first triangle equals the outward normal (front faces under back-face culling).
  let vi = 0;
  let ii = 0;
  for (let f = 0; f < visibleFaces.length; f++) {
    const entry = visibleFaces[f]!;
    const { x, y, z, face, layer, ao, light } = entry;
    const n = face.normal;
    const ta = face.tangentA;
    const tb = face.tangentB;

    // Quad corners in (u, v) parameter space: (0,0), (1,0), (1,1), (0,1).
    const corners: readonly [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let k = 0; k < 4; k++) {
      const cu = corners[k]![0];
      const cv = corners[k]![1];
      positions[(vi + k) * 3 + 0] = x + face.displacement[0]! + ta[0]! * cu + tb[0]! * cv;
      positions[(vi + k) * 3 + 1] = y + face.displacement[1]! + ta[1]! * cu + tb[1]! * cv;
      positions[(vi + k) * 3 + 2] = z + face.displacement[2]! + ta[2]! * cu + tb[2]! * cv;
    }
    for (let k = 0; k < 4; k++) {
      normals[(vi + k) * 3] = n[0]!;
      normals[(vi + k) * 3 + 1] = n[1]!;
      normals[(vi + k) * 3 + 2] = n[2]!;
    }
    // UV corners use face-specific alignment so all textures stand upright and un-rotated.
    const uvCorners = face.uvCorners;
    for (let k = 0; k < 4; k++) {
      uvs[(vi + k) * 2] = uvCorners[k]![0];
      uvs[(vi + k) * 2 + 1] = uvCorners[k]![1];
    }
    for (let k = 0; k < 4; k++) {
      colors[(vi + k) * 4] = layer;
      colors[(vi + k) * 4 + 1] = ao[k]!;
      colors[(vi + k) * 4 + 2] = light;
      colors[(vi + k) * 4 + 3] = 1;
    }

    // Two triangles, CCW in the (TA, TB) parameter plane (== facing outward).
    indices[ii++] = vi;
    indices[ii++] = vi + 1;
    indices[ii++] = vi + 2;
    indices[ii++] = vi;
    indices[ii++] = vi + 2;
    indices[ii++] = vi + 3;
    vi += 4;
  }

  return { positions, normals, uvs, colors, indices, triangleCount: visibleFaces.length * 2 };
}

/**
 * M0-compatible convenience wrapper around `buildMesh` (kept so the committed M0 tests and any
 * demo path that meshes on the main thread keep working unchanged). Meshes a `Chunk` WITHOUT
 * neighbor data -- border faces therefore count as exposed, exactly the M0 single-chunk
 * contract. M1 production code calls `buildMesh` directly (with neighbor rims, in the worker).
 */
export class NaiveMesher {
  /** All six face templates -- re-exported so existing tests keep reading this table. */
  public static readonly FACES: readonly FaceTemplate[] = FACES;

  private readonly _registry: BlockRegistry;

  constructor(registry: BlockRegistry) {
    this._registry = registry;
  }

  /** Meshes a chunk into plain typed arrays (no neighbor awareness -- border = exposed). */
  public build(chunk: Chunk): VoxelMeshData {
    return buildMesh({ voxels: chunk.voxels, descriptor: descriptorFromRegistry(this._registry) });
  }
}
