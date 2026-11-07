/**
 * M2 voxel raycast (dossier §4.2 M2 "Break/Place"): volumetric DDA (Amanatides & Woo, with the
 * canonical "advance the nearest axis boundary" rule) from an eye position along a unit view
 * direction against a `RaycastWorld` of SOLID cells. Pure function, no engine import, no class,
 * node-testable -- the same collision semantics as `VoxelSweep` (a cell is solid iff the block
 * registry says `collidable`; water passes through).
 *
 * `dir` MUST be a unit vector (the caller derives it from the FPS view angles, which is already
 * unit by construction). `maxDistance`/`distance` are therefore in world units along `dir`.
 *
 * Deliberate simplifications, documented: on an exact boundary tie between two axes the search
 * advances ONE axis (Royston-style multi-axis tracing is not needed -- a missed corner cell is
 * visually indistinguishable and has no seam/waterline impact). A ray starting inside a solid
 * cell resolves to that cell at distance 0 (MC-like block-overlap behavior).
 */
export interface RaycastWorld {
  isSolidCell(x: number, y: number, z: number): boolean;
}

export interface VoxelRayHit {
  /** Solid cell that was hit (block coordinates). */
  x: number;
  y: number;
  z: number;
  /** Unit normal of the face ENTERED (the hit block's face toward the origin). Zero vector when
   *  the ray already starts inside the block. */
  normal: { x: number; y: number; z: number };
  /** Distance of the hit along the (normalized) direction, in world units. */
  distance: number;
  /** Cell a placed block would occupy (hit cell + normal) -- Minceraft placement semantics. */
  placeX: number;
  placeY: number;
  placeZ: number;
}

export function raycastVoxel(
  world: RaycastWorld,
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  maxDistance: number,
): VoxelRayHit | null {
  if (maxDistance <= 0) return null;
  const x0 = Math.floor(origin.x);
  const y0 = Math.floor(origin.y);
  const z0 = Math.floor(origin.z);

  if (world.isSolidCell(x0, y0, z0)) {
    return {
      x: x0,
      y: y0,
      z: z0,
      normal: { x: 0, y: 0, z: 0 },
      distance: 0,
      placeX: x0,
      placeY: y0,
      placeZ: z0,
    };
  }

  // Per-axis DDA state. Zero-direction components never step (tDelta/tMax stay +∞).
  let stepX = 0;
  let stepY = 0;
  let stepZ = 0;
  let tMaxX = Number.POSITIVE_INFINITY;
  let tMaxY = Number.POSITIVE_INFINITY;
  let tMaxZ = Number.POSITIVE_INFINITY;
  let tDeltaX = Number.POSITIVE_INFINITY;
  let tDeltaY = Number.POSITIVE_INFINITY;
  let tDeltaZ = Number.POSITIVE_INFINITY;

  if (dir.x !== 0) {
    stepX = dir.x > 0 ? 1 : -1;
    tDeltaX = Math.abs(1 / dir.x);
    tMaxX = tDeltaX * (dir.x > 0 ? x0 + 1 - origin.x : origin.x - x0);
  }
  if (dir.y !== 0) {
    stepY = dir.y > 0 ? 1 : -1;
    tDeltaY = Math.abs(1 / dir.y);
    tMaxY = tDeltaY * (dir.y > 0 ? y0 + 1 - origin.y : origin.y - y0);
  }
  if (dir.z !== 0) {
    stepZ = dir.z > 0 ? 1 : -1;
    tDeltaZ = Math.abs(1 / dir.z);
    tMaxZ = tDeltaZ * (dir.z > 0 ? z0 + 1 - origin.z : origin.z - z0);
  }

  // Guard: degenerate zero direction (all components 0) -- nothing to trace.
  if (stepX === 0 && stepY === 0 && stepZ === 0) return null;

  let x = x0;
  let y = y0;
  let z = z0;

  for (;;) {
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      if (tMaxX > maxDistance) return null;
      x += stepX;
      const t = tMaxX;
      tMaxX += tDeltaX;
      if (world.isSolidCell(x, y, z)) {
        return {
          x,
          y,
          z,
          normal: { x: -stepX, y: 0, z: 0 },
          distance: t,
          placeX: x - stepX,
          placeY: y,
          placeZ: z,
        };
      }
    } else if (tMaxY <= tMaxX && tMaxY <= tMaxZ) {
      if (tMaxY > maxDistance) return null;
      y += stepY;
      const t = tMaxY;
      tMaxY += tDeltaY;
      if (world.isSolidCell(x, y, z)) {
        return {
          x,
          y,
          z,
          normal: { x: 0, y: -stepY, z: 0 },
          distance: t,
          placeX: x,
          placeY: y - stepY,
          placeZ: z,
        };
      }
    } else {
      if (tMaxZ > maxDistance) return null;
      z += stepZ;
      const t = tMaxZ;
      tMaxZ += tDeltaZ;
      if (world.isSolidCell(x, y, z)) {
        return {
          x,
          y,
          z,
          normal: { x: 0, y: 0, z: -stepZ },
          distance: t,
          placeX: x,
          placeY: y,
          placeZ: z - stepZ,
        };
      }
    }
  }
}
