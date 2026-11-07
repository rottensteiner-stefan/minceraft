/**
 * Voxel-grid AABB sweep (M1, dossier §4.2 "VoxelSweep-Kollisions-Resolver" / §3.2).
 *
 * A faithful, SIMPLIFIED port of Luanti's `collisionMoveSimple` + `axisAlignedCollision`
 * (source: `.agents/collaborate/minceraft/sources/charly-voxel-gameplay-luanti-collision.cpp`,
 * LGPL-2.1-or-later -- the canonical per-axis swept collision method the dossier mandates).
 * Pure TS, no engine import, fully node-testable.
 *
 * Targeted simplifications vs. Luanti, each a documented M1 scope decision (NOT silent cuts):
 *   - Static geometry is integer unit cubes only (no custom node boxes, no dynamic objects).
 *   - `bouncy = 0` for every voxel, so a colliding axis zeroes its velocity (no bounce).
 *   - No step-up / auto-jump: M1's gate is "the player STANDS on terrain" plus the streaming
 *     fly path; walking over 1-block lips is deferred to the M4 survival loop (documented).
 *   - No parabola peak-splitting (handles mid-frame velocity turn-overs for jumps); M1 has no
 *     jump. Deferred with the jump feature.
 *
 * The core is kept verbatim in spirit: the per-axis `axisAlignedCollision` (slab-style time-of-
 * impact against the nearest static box, reporting the EARLIEST colliding axis), the nearest-
 * impact resolution loop with bounded iterations, the collide_with snap (position corrected to
 * the blocking face + colliding axis velocity zeroed), 1e-5 position truncation to kill
 * accumulated float drift, and the FINAL-TOUCHES ground contact scan as the ground detection.
 *
 * GROUND DETECTION DIVERGENCE (documented, not a silent cut): Luanti flags `touching_ground`
 * twice -- once mid-loop with `accel_f.Y == 0 && aspeed_f.Y < 0`, once in the final-touches scan
 * (`fabs(sbox.MaxEdge.Y - mbox.MinEdge.Y) < 0.05` over every X-Z-overlapping node box). The
 * mid-loop clause exists because Luanti's caller bakes gravity INTO `speed_f` before the call
 * (`accel_f.Y == 0` is the "no thrust on Y right now" guard). Our model passes gravity as
 * `options.accel`, so that clause would be permanently false (dead code); the final-touches
 * scan is the authoritative check both sides share ("players rely on this check", upstream
 * comment at the 0.05 test) and is reproduced here: `onGround` is set exactly when the body's
 * feet sit within GROUND_CONTACT_EPS of a solid block top with X-Z overlap.
 */

/** Voxel-world collision query the sweep needs. `world` must be cheap + thread-local safe. */
export interface SweepWorld {
  isSolidCell(x: number, y: number, z: number): boolean;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export interface SweepOptions {
  /** Player AABB as (min, max) OFFSETS relative to the body origin (the AABB center). */
  boxOffset: { min: Vec3; max: Vec3 };
  /** Accumulate this acceleration into the velocity this tick (e.g. gravity on Y). */
  accel: Vec3;
  /** Maximum dt the solver may consume in one call (frame clamp, like Luanti's DTIME_LIMIT). */
  maxDtime?: number;
  /** Upper bound on solver iterations (collision chaining guard). Default 24. */
  maxIterations?: number;
}

export interface SweepInput {
  world: SweepWorld;
  options: SweepOptions;
  position: Vec3;
  velocity: Vec3;
  dt: number;
}

export interface SweepResult {
  /** Body origin (AABB center) after resolution. */
  position: Vec3;
  /** Velocity after resolution (colliding axes zeroed). */
  velocity: Vec3;
  /** True only when the resolved collision axis was downward Y (standing on ground). */
  onGround: boolean;
  /** Number of collisions resolved this tick. */
  collisionCount: number;
  /** True when the whole frame could not be consumed (still moving at loop end). */
  blocked: boolean;
}

const TRUNCATE_POSITION = 100000.0; // Luanti: kill float drift by quantizing to 1e-5
const EPS = 1e-12;
/** Luanti's final-touches ground band (`... < 0.05f`): feet within this gap of a block top. */
const GROUND_CONTACT_EPS = 0.05;

function truncate(v: number, factor: number): number {
  return Math.trunc(v * factor) / factor;
}

/** Lexical snapshot so callers never alias an engine vector they still own. */
function clone(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** Per-axis swept time-of-impact, ported from Luanti `axisAlignedCollision`. Returns the
 *  distance-adjusted `dtime` and which axis collides first, or null if none within `dtimeMax`. */
function axisAlignedCollision(
  staticBox: Aabb,
  movingBox: Aabb,
  speed: Vec3,
  dtimeMax: number,
): { axis: 0 | 1 | 2; dtime: number } | null {
  // "Relbox": the sum of the box widths vs. the outer bounding extent -- their difference is the
  // gap the moving box must close along each axis.
  const relMin = {
    x: movingBox.max.x - movingBox.min.x + (staticBox.max.x - staticBox.min.x),
    y: movingBox.max.y - movingBox.min.y + (staticBox.max.y - staticBox.min.y),
    z: movingBox.max.z - movingBox.min.z + (staticBox.max.z - staticBox.min.z),
  };
  const relMax = {
    x: Math.max(movingBox.max.x, staticBox.max.x) - Math.min(movingBox.min.x, staticBox.min.x),
    y: Math.max(movingBox.max.y, staticBox.max.y) - Math.min(movingBox.min.y, staticBox.min.y),
    z: Math.max(movingBox.max.z, staticBox.max.z) - Math.min(movingBox.min.z, staticBox.min.z),
  };

  const consider = (axis: 0 | 1 | 2): { axis: 0 | 1 | 2; dtime: number } | null => {
    const s = axis === 0 ? speed.x : axis === 1 ? speed.y : speed.z;
    if (s === 0) return null;
    const gap = relMax[axisKey(axis)] - relMin[axisKey(axis)];
    const dtime = gap / Math.abs(s);
    const time = Math.max(dtime, 0);
    if (dtime > dtimeMax) return null; // cannot close the gap within this frame
    const innerMargin = Math.max(
      -0.5 * (staticBox.max[axisKey(axis)] - staticBox.min[axisKey(axis)]),
      -2.0,
    );

    // The moving box must be APPROACHING the static box on this axis (not already intersecting).
    if (
      (s > 0 && staticBox.min[axisKey(axis)] - movingBox.max[axisKey(axis)] > innerMargin) ||
      (s < 0 && movingBox.min[axisKey(axis)] - staticBox.max[axisKey(axis)] > innerMargin)
    ) {
      // At the impact time, the OTHER two axes must overlap too (`combined < sumWidths`).
      const overlapAt = (other: 0 | 1 | 2): boolean => {
        const key = axisKey(other);
        const m = {
          x: movingBox.min.x + speed.x * time,
          y: movingBox.min.y + speed.y * time,
          z: movingBox.min.z + speed.z * time,
        };
        const mx = {
          x: movingBox.max.x + speed.x * time,
          y: movingBox.max.y + speed.y * time,
          z: movingBox.max.z + speed.z * time,
        };
        return (
          Math.max(mx[key], staticBox.max[key]) -
            Math.min(m[key], staticBox.min[key]) -
            relMin[key] <
          0
        );
      };
      if (axis === 0 && overlapAt(1) && overlapAt(2)) return { axis: 0, dtime };
      if (axis === 1 && overlapAt(0) && overlapAt(2)) return { axis: 1, dtime };
      if (axis === 2 && overlapAt(0) && overlapAt(1)) return { axis: 2, dtime };
    }
    return null;
  };

  // Order matches Luanti: Y first, then X, then Z -- each returns the first acceptable result.
  return consider(1) ?? consider(0) ?? consider(2);
}

function axisKey(axis: 0 | 1 | 2): "x" | "y" | "z" {
  return axis === 0 ? "x" : axis === 1 ? "y" : "z";
}

/** AABB of the moving body at a given origin, from the offset box. */
function aabbAt(origin: Vec3, boxOffset: { min: Vec3; max: Vec3 }): Aabb {
  return {
    min: {
      x: origin.x + boxOffset.min.x,
      y: origin.y + boxOffset.min.y,
      z: origin.z + boxOffset.min.z,
    },
    max: {
      x: origin.x + boxOffset.max.x,
      y: origin.y + boxOffset.max.y,
      z: origin.z + boxOffset.max.z,
    },
  };
}

/** Candidate solid cells the sweep may hit: the AABB's sweep corridor, 1-cell padded. */
function candidateCells(
  world: SweepWorld,
  from: Aabb,
  delta: Vec3,
): Array<{ x: number; y: number; z: number }> {
  const lo = {
    x: Math.floor(Math.min(from.min.x, from.max.x, from.min.x + delta.x) - 1),
    y: Math.floor(Math.min(from.min.y, from.min.y + delta.y) - 1),
    z: Math.floor(Math.min(from.min.z, from.min.z + delta.z) - 1),
  };
  const hi = {
    x: Math.floor(Math.max(from.max.x, from.max.x + delta.x)),
    y: Math.floor(Math.max(from.max.y, from.max.y + delta.y)),
    z: Math.floor(Math.max(from.max.z, from.max.z + delta.z)),
  };
  const cells: Array<{ x: number; y: number; z: number }> = [];
  for (let y = lo.y; y <= hi.y; y++) {
    for (let z = lo.z; z <= hi.z; z++) {
      for (let x = lo.x; x <= hi.x; x++) {
        if (world.isSolidCell(x, y, z)) cells.push({ x, y, z });
      }
    }
  }
  return cells;
}

/** Snap the body origin so its AABB abuts the blocking face on the collided axis (bounce = 0). */
function collideWith(
  origin: Vec3,
  boxOffset: { min: Vec3; max: Vec3 },
  staticBox: Aabb,
  axis: 0 | 1 | 2,
  aspeed: Vec3,
): void {
  const key = axisKey(axis);
  if (aspeed[key] > 0) {
    origin[key] = truncate(staticBox.min[key] - boxOffset.max[key], TRUNCATE_POSITION);
  } else {
    origin[key] = truncate(staticBox.max[key] - boxOffset.min[key], TRUNCATE_POSITION);
  }
}

/**
 * Luanti final-touches ground contact scan (`collisionMoveSimple`: `fabs(sbox.MaxEdge.Y -
 * mbox.MinEdge.Y) < 0.05f` over every X-Z-overlapping node box). Rescans the world around the
 * RESOLVED origin -- after resolution the feet sit exactly on a block top, which the scan
 * recognises as `onGround`. Faithful to the strict X-Z inequalities and the 0.05 gap band.
 */
function anyGroundContact(
  world: SweepWorld,
  boxOffset: { min: Vec3; max: Vec3 },
  origin: Vec3,
): boolean {
  const mbox = aabbAt(origin, boxOffset);
  for (let z = Math.floor(mbox.min.z - 1); z <= Math.floor(mbox.max.z + 1); z++) {
    for (let x = Math.floor(mbox.min.x - 1); x <= Math.floor(mbox.max.x + 1); x++) {
      if (!(x + 1 > mbox.min.x && x < mbox.max.x && z + 1 > mbox.min.z && z < mbox.max.z)) {
        continue; // no X-Z overlap with the static cell (Luanti strict inequalities)
      }
      for (
        let y = Math.floor(mbox.min.y - GROUND_CONTACT_EPS) - 1;
        y <= Math.floor(mbox.min.y + GROUND_CONTACT_EPS) + 1;
        y++
      ) {
        if (!world.isSolidCell(x, y, z)) continue;
        if (Math.abs(y + 1 - mbox.min.y) < GROUND_CONTACT_EPS) return true;
      }
    }
  }
  return false;
}

/**
 * Integrates accel into velocity and THEN swept-collides the AABB against the world, resolving
 * per-axis (earliest axis wins), snapping to the blocking face and zeroing the collided axis.
 * Returns the resolved origin + velocity. Never throws; degenerates to integration when the
 * world is empty. THE result is a fresh object -- callers own their input vectors.
 */
export function sweepVoxel(input: SweepInput): SweepResult {
  const origin = clone(input.position);
  let velocity = clone(input.velocity);
  const boxOffset = input.options.boxOffset;
  const accel = input.options.accel;
  const maxDtime = input.options.maxDtime ?? 0.05;
  const maxIterations = input.options.maxIterations ?? 24;
  const dtime = Math.min(input.dt, maxDtime);

  const result: SweepResult = {
    position: origin,
    velocity,
    onGround: false,
    collisionCount: 0,
    blocked: false,
  };
  if (dtime <= 0) return result;

  const still =
    Math.abs(velocity.x) +
      Math.abs(velocity.y) +
      Math.abs(velocity.z) +
      Math.abs(accel.x) +
      Math.abs(accel.y) +
      Math.abs(accel.z) <
    1e-12;
  if (still) return result;

  // Average speed over the frame (Luanti step) -- the swept collision uses this, not raw vel.
  const aspeed = {
    x: velocity.x + accel.x * 0.5 * dtime,
    y: velocity.y + accel.y * 0.5 * dtime,
    z: velocity.z + accel.z * 0.5 * dtime,
  };
  aspeed.x = Math.max(-5000, Math.min(5000, aspeed.x));
  aspeed.y = Math.max(-5000, Math.min(5000, aspeed.y));
  aspeed.z = Math.max(-5000, Math.min(5000, aspeed.z));

  let remaining = dtime;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const movingBox = aabbAt(origin, boxOffset);
    const delta = { x: aspeed.x * remaining, y: aspeed.y * remaining, z: aspeed.z * remaining };
    const cells = candidateCells(input.world, movingBox, delta);

    let nearest: { axis: 0 | 1 | 2; dtime: number } | null = null;
    let nearestBox: Aabb | null = null;
    for (const cell of cells) {
      const staticBox: Aabb = {
        min: { x: cell.x, y: cell.y, z: cell.z },
        max: { x: cell.x + 1, y: cell.y + 1, z: cell.z + 1 },
      };
      const hit = axisAlignedCollision(staticBox, movingBox, aspeed, remaining);
      if (hit && (!nearest || hit.dtime < nearest.dtime)) {
        nearest = hit;
        nearestBox = staticBox;
      }
    }

    if (!nearest || !nearestBox) {
      // No collision left: consume the whole remaining frame.
      result.position = {
        x: origin.x + aspeed.x * remaining,
        y: origin.y + aspeed.y * remaining,
        z: origin.z + aspeed.z * remaining,
      };
      velocity = {
        x: velocity.x + accel.x * remaining,
        y: velocity.y + accel.y * remaining,
        z: velocity.z + accel.z * remaining,
      };
      remaining = 0;
      break;
    }

    // Move to the impact point, consume the sub-interval.
    if (nearest.dtime > EPS) {
      result.position = {
        x: origin.x + aspeed.x * nearest.dtime,
        y: origin.y + aspeed.y * nearest.dtime,
        z: origin.z + aspeed.z * nearest.dtime,
      };
      velocity = {
        x: velocity.x + accel.x * nearest.dtime,
        y: velocity.y + accel.y * nearest.dtime,
        z: velocity.z + accel.z * nearest.dtime,
      };
      remaining -= nearest.dtime;
    }

    // Correct position to the blocking face and zero the collided axis (bounce = 0).
    collideWith(result.position, boxOffset, nearestBox, nearest.axis, aspeed);
    velocity[axisKey(nearest.axis)] = 0;
    aspeed[axisKey(nearest.axis)] = 0;
    result.collisionCount++;

    if (remaining < EPS) break;
    origin.x = result.position.x;
    origin.y = result.position.y;
    origin.z = result.position.z;
  }

  if (remaining > EPS) result.blocked = true;
  // `result.position` is authoritative -- the consume branch and the per-collision snap both
  // write it. It is NEVER synced back to `origin` on the free-move path (that path breaks), so
  // overwriting it with `origin` would revert every non-colliding frame to its start position.
  result.velocity = velocity;
  // Ground detection is the Luanti final-touches contact scan -- NOT the mid-loop Y-axis clause
  // (that one is dead under our gravity-in-accel model; see the file header divergence note).
  result.onGround = anyGroundContact(input.world, boxOffset, result.position);
  return result;
}
