import { BLOCK_AIR, faceAxisForNormal } from "../BlockRegistry.js";
import { Chunk } from "../Chunk.js";
import {
  FLOOD_OFFSETS,
  combineLight,
  daylightFactorAt,
  floodSealedness,
} from "../light/daylight.js";
import type {
  CornerDir,
  FaceDir,
  FaceTemplate,
  MeshBlockDescriptorEntry,
  MeshBuildInput,
  VoxelMeshData,
} from "./NaiveMesher.js";
import { FACES, RIM_INDEX_ORDER, faceDirForOffset } from "./NaiveMesher.js";

interface QuadKey {
  blockId: number;
  layer: number;
  ao0: number;
  ao1: number;
  ao2: number;
  ao3: number;
  light: number;
  transparent: boolean;
}

function keysMatch(a: QuadKey | null, b: QuadKey | null): boolean {
  if (a === null || b === null) return false;
  if (a === b) return true;
  return (
    a.blockId === b.blockId &&
    a.layer === b.layer &&
    a.transparent === b.transparent &&
    Math.abs(a.ao0 - b.ao0) < 1e-4 &&
    Math.abs(a.ao1 - b.ao1) < 1e-4 &&
    Math.abs(a.ao2 - b.ao2) < 1e-4 &&
    Math.abs(a.ao3 - b.ao3) < 1e-4 &&
    Math.abs(a.light - b.light) < 1e-4
  );
}

interface MergedQuad {
  face: FaceTemplate;
  startX: number;
  startY: number;
  startZ: number;
  w: number;
  h: number;
  key: QuadKey;
}

/**
 * AO-kompatibles Greedy-Meshing (dossier §5.2 S3, §4.4 #3).
 *
 * Scans each chunk face orientation in 2D slices and merges adjacent quads if and only if
 * they share the exact same block ID, atlas layer, 4 vertex AO values, and daylight factor.
 * This guarantees zero visual degradation of the baked shading while dramatically reducing
 * vertex and triangle counts.
 */
export function buildGreedyMesh(input: MeshBuildInput): VoxelMeshData {
  const size = Chunk.SIZE;
  if (input.voxels.length !== size * size * size) {
    throw new Error(
      `[buildGreedyMesh] expected ${size}^3 buffer (${size * size * size} bytes), got ${input.voxels.length}`,
    );
  }

  const descriptor = new Map<number, MeshBlockDescriptorEntry>();
  for (const entry of input.descriptor) descriptor.set(entry.id, entry);
  const neighbors: Partial<Record<FaceDir, Uint8Array>> = input.neighbors ?? {};

  const isSolidAt = (x: number, y: number, z: number): boolean => {
    if (x < 0 || y < 0 || z < 0 || x >= size || y >= size || z >= size) {
      const dir = faceDirForOffset([
        Math.sign(x) as 1 | 0 | -1,
        Math.sign(y) as 1 | 0 | -1,
        Math.sign(z) as 1 | 0 | -1,
      ]);
      const rim = neighbors[dir];
      if (!rim) return false;
      const order = RIM_INDEX_ORDER[dir];
      const b = order.b === "x" ? x : order.b === "y" ? y : z;
      const c = order.c === "x" ? x : order.c === "y" ? y : z;
      const id = rim[b + c * size];
      if (id === undefined) return false;
      return descriptor.get(id)?.opaque ?? false;
    }
    return descriptor.get(input.voxels[x + z * size + y * size * size]!)?.opaque ?? false;
  };

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

  const mergedQuads: MergedQuad[] = [];

  // For each of the 6 face orientations
  for (const face of FACES) {
    const normalAxis = face.normal[0] !== 0 ? 0 : face.normal[1] !== 0 ? 1 : 2;
    const uAxis = face.tangentA[0] !== 0 ? 0 : face.tangentA[1] !== 0 ? 1 : 2;
    const vAxis = face.tangentB[0] !== 0 ? 0 : face.tangentB[1] !== 0 ? 1 : 2;
    const faceAxis = faceAxisForNormal(face.normal[1]!);

    // 2D slice buffer (16x16)
    const mask: Array<QuadKey | null> = new Array<QuadKey | null>(size * size).fill(null);

    // Iterate through all slices along the normal axis
    for (let slice = 0; slice < size; slice++) {
      mask.fill(null);

      // 1. Build mask for this 2D slice
      for (let v = 0; v < size; v++) {
        for (let u = 0; u < size; u++) {
          const coords = [0, 0, 0];
          coords[normalAxis] = slice;
          coords[uAxis] = u;
          coords[vAxis] = v;
          const x = coords[0]!;
          const y = coords[1]!;
          const z = coords[2]!;

          const id = input.voxels[x + z * size + y * size * size]!;
          if (id === BLOCK_AIR) continue;
          const entry = descriptor.get(id);
          if (!entry) continue;

          const nx = x + face.neighborOffset[0]!;
          const ny = y + face.neighborOffset[1]!;
          const nz = z + face.neighborOffset[2]!;

          if (entry.opaque) {
            // Opaque block: emit face if neighbor is non-opaque
            if (!isSolidAt(nx, ny, nz)) {
              const ao = vertexOcclusionFactors(x, y, z, face);
              const light = lightForFace(x, y, z, face);
              mask[u + v * size] = {
                blockId: id,
                layer: entry.layers[faceAxis]!,
                ao0: ao[0]!,
                ao1: ao[1]!,
                ao2: ao[2]!,
                ao3: ao[3]!,
                light,
                transparent: false,
              };
            }
          } else {
            // Transparent block (e.g. water): emit face only against AIR
            if (cellIdAt(nx, ny, nz) === BLOCK_AIR) {
              mask[u + v * size] = {
                blockId: id,
                layer: entry.layers[faceAxis]!,
                ao0: 1,
                ao1: 1,
                ao2: 1,
                ao3: 1,
                light: 1,
                transparent: true,
              };
            }
          }
        }
      }

      // 2. Greedy merge rectangles in the 2D slice mask
      for (let v = 0; v < size; v++) {
        for (let u = 0; u < size;) {
          const key = mask[u + v * size];
          if (!key) {
            u++;
            continue;
          }

          // Find maximum width along u with identical key
          let w = 1;
          while (u + w < size && keysMatch(mask[u + w + v * size] ?? null, key)) {
            w++;
          }

          // Find maximum height along v with identical row of keys
          let h = 1;
          outerH: while (v + h < size) {
            for (let k = 0; k < w; k++) {
              if (!keysMatch(mask[u + k + (v + h) * size] ?? null, key)) {
                break outerH;
              }
            }
            h++;
          }

          // Clear merged cells from mask
          for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) {
              mask[u + dx + (v + dy) * size] = null;
            }
          }

          const startCoords = [0, 0, 0];
          startCoords[normalAxis] = slice;
          startCoords[uAxis] = u;
          startCoords[vAxis] = v;

          mergedQuads.push({
            face,
            startX: startCoords[0]!,
            startY: startCoords[1]!,
            startZ: startCoords[2]!,
            w,
            h,
            key,
          });

          u += w;
        }
      }
    }
  }

  // 3. Emit geometry buffers from merged quads
  const quadCount = mergedQuads.length;
  const vertexCount = quadCount * 4;
  const indexCount = quadCount * 6;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 4);
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  let vOffset = 0;
  let iOffset = 0;

  for (let q = 0; q < quadCount; q++) {
    const quad = mergedQuads[q]!;
    const f = quad.face;
    const k = quad.key;
    const baseVertex = vOffset;

    const n = f.normal;
    const ta = f.tangentA;
    const tb = f.tangentB;
    const disp = f.displacement;

    // Corner definitions in (cu * w, cv * h) space
    const cornerUVs: readonly (readonly [number, number])[] = [
      [0, 0],
      [quad.w, 0],
      [quad.w, quad.h],
      [0, quad.h],
    ];

    const aoValues = [k.ao0, k.ao1, k.ao2, k.ao3];

    for (let c = 0; c < 4; c++) {
      const cu = cornerUVs[c]![0]!;
      const cv = cornerUVs[c]![1]!;

      // Position: start + displacement + cu * tangentA + cv * tangentB
      const px = quad.startX + disp[0]! + cu * ta[0]! + cv * tb[0]!;
      const py = quad.startY + disp[1]! + cu * ta[1]! + cv * tb[1]!;
      const pz = quad.startZ + disp[2]! + cu * ta[2]! + cv * tb[2]!;

      const vi3 = (baseVertex + c) * 3;
      positions[vi3] = px;
      positions[vi3 + 1] = py;
      positions[vi3 + 2] = pz;

      normals[vi3] = n[0]!;
      normals[vi3 + 1] = n[1]!;
      normals[vi3 + 2] = n[2]!;

      const vi2 = (baseVertex + c) * 2;
      uvs[vi2] = cu;
      uvs[vi2 + 1] = cv;

      const vi4 = (baseVertex + c) * 4;
      colors[vi4] = k.layer;
      colors[vi4 + 1] = aoValues[c]!;
      colors[vi4 + 2] = k.light;
      colors[vi4 + 3] = 1.0;
    }

    // Two triangles per quad: (0, 1, 2) and (0, 2, 3)
    indices[iOffset++] = baseVertex;
    indices[iOffset++] = baseVertex + 1;
    indices[iOffset++] = baseVertex + 2;
    indices[iOffset++] = baseVertex;
    indices[iOffset++] = baseVertex + 2;
    indices[iOffset++] = baseVertex + 3;

    vOffset += 4;
  }

  return {
    positions,
    normals,
    uvs,
    colors,
    indices,
    triangleCount: quadCount * 2,
  };
}
