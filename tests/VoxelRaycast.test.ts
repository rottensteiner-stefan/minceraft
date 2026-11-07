import { describe, expect, it } from "vitest";
import type { RaycastWorld } from "../src/voxel/physics/VoxelRaycast.js";
import { raycastVoxel } from "../src/voxel/physics/VoxelRaycast.js";

/**
 * M2 targeting ray (dossier §4.2 Break/Place). Pure DDA tests: axis hits with the correct
 * entered-face normal and Minceraft placement cell, out-of-range abort, start-inside-block,
 * exact-on-edge origin, diagonal traversal, degenerate direction, determinism and read-only
 * world access.
 */

/** Test world: an explicit set of solid world cells + a call counter (proves read-only use). */
class MapWorld implements RaycastWorld {
  private readonly _solid = new Set<string>();
  private readonly _reads: number[] = [];

  public fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) this._solid.add(`${x},${y},${z}`);
      }
    }
  }

  public isSolidCell(x: number, y: number, z: number): boolean {
    this._reads.push(x * 4096 + y * 16 + z); // heavy-handed fingerprint (world Y max 15)
    return this._solid.has(`${x},${y},${z}`);
  }

  public get readCount(): number {
    return this._reads.length;
  }

  public get reads(): readonly number[] {
    return this._reads;
  }
}

describe("VoxelRaycast — axis hits", () => {
  it("hits +X with normal -X and the correct placement cell", () => {
    const world = new MapWorld();
    world.fill(4, 8, 8, 4, 8, 8);
    const hit = raycastVoxel(world, { x: 0.5, y: 8.5, z: 8.5 }, { x: 1, y: 0, z: 0 }, 6);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(4);
    expect(hit!.y).toBe(8);
    expect(hit!.z).toBe(8);
    expect(hit!.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect({ x: hit!.placeX, y: hit!.placeY, z: hit!.placeZ }).toEqual({ x: 3, y: 8, z: 8 });
    expect(hit!.distance).toBeCloseTo(3.5, 9);
  });

  it("hits -Z (forward) with normal +Z", () => {
    const world = new MapWorld();
    world.fill(8, 8, 4, 8, 8, 4);
    const hit = raycastVoxel(world, { x: 8.5, y: 8.5, z: 8.5 }, { x: 0, y: 0, z: -1 }, 6);
    expect(hit).not.toBeNull();
    expect(hit!.z).toBe(4);
    expect(hit!.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(hit!.placeZ).toBe(5);
    // Entry face of cell z=4 from the +Z side sits at z=5.0 (origin z=8.5): distance 3.5, the
    // same face-entry convention as the +X axis test (not the cell-centre distance 4.5).
    expect(hit!.distance).toBeCloseTo(3.5, 9);
  });

  it("hits downward (-Y) with normal +Y", () => {
    const world = new MapWorld();
    world.fill(8, 4, 8, 8, 4, 8);
    const hit = raycastVoxel(world, { x: 8.5, y: 8.5, z: 8.5 }, { x: 0, y: -1, z: 0 }, 6);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBe(4);
    expect(hit!.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(hit!.placeY).toBe(5);
    // Entry face of cell y=4 from above sits at y=5.0 (origin y=8.5): distance 3.5 (face-entry
    // convention, not the cell-centre distance 4.5).
    expect(hit!.distance).toBeCloseTo(3.5, 9);
  });
});

describe("VoxelRaycast — edge cases and ranges", () => {
  it("resolves a ray that starts INSIDE a solid cell at distance 0 with a zero normal", () => {
    const world = new MapWorld();
    world.fill(8, 8, 8, 8, 8, 8);
    const hit = raycastVoxel(world, { x: 8.5, y: 8.5, z: 8.5 }, { x: 0, y: 0, z: -1 }, 6);
    expect(hit).not.toBeNull();
    expect({ x: hit!.x, y: hit!.y, z: hit!.z }).toEqual({ x: 8, y: 8, z: 8 });
    expect(hit!.distance).toBe(0);
    expect(hit!.normal).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("hits a block whose edge the origin lies exactly on (exact boundary crossing)", () => {
    const world = new MapWorld();
    world.fill(6, 8, 8, 6, 8, 8);
    const hit = raycastVoxel(world, { x: 5, y: 8.5, z: 8.5 }, { x: 1, y: 0, z: 0 }, 6);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(6);
    expect(hit!.distance).toBeCloseTo(1, 9);
    expect(hit!.normal).toEqual({ x: -1, y: 0, z: 0 });
  });

  it("aborts outside maxDistance (returns null)", () => {
    const world = new MapWorld();
    world.fill(4, 8, 8, 4, 8, 8);
    const hit = raycastVoxel(world, { x: 0.5, y: 8.5, z: 8.5 }, { x: 1, y: 0, z: 0 }, 3);
    expect(hit).toBeNull();
  });

  it("returns null for a maxDistance of zero or less without touching the world", () => {
    const world = new MapWorld();
    expect(raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 0)).toBeNull();
    expect(world.readCount).toBe(0);
  });

  it("returns null for a degenerate zero direction", () => {
    const world = new MapWorld();
    expect(raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 0, z: 0 }, 6)).toBeNull();
  });

  it("returns null when the ray never meets a solid block", () => {
    const world = new MapWorld();
    world.fill(4, 8, 8, 4, 8, 8); // off the ray path
    expect(raycastVoxel(world, { x: 0.5, y: 8.5, z: 8.5 }, { x: 0, y: 0, z: -1 }, 6)).toBeNull();
  });

  it("is deterministic: identical inputs produce byte-identical hits and never mutate the world", () => {
    const worldA = new MapWorld();
    worldA.fill(4, 8, 8, 4, 8, 8);
    const worldB = new MapWorld();
    worldB.fill(4, 8, 8, 4, 8, 8);
    const hitA = raycastVoxel(worldA, { x: 0.5, y: 8.5, z: 8.5 }, { x: 1, y: 0, z: 0 }, 6);
    const hitB = raycastVoxel(worldB, { x: 0.5, y: 8.5, z: 8.5 }, { x: 1, y: 0, z: 0 }, 6);
    expect(hitA).toEqual(hitB);
    expect(worldA.reads).toEqual(worldB.reads); // the traversal touched the identical cell sequence
  });
});

describe("VoxelRaycast — diagonal traversal", () => {
  it("reaches a solid slab on a 45° +X/+Z path (entered via the -X face)", () => {
    // A full slab at x=4 across z 0..5 (everything +Z ahead is solid upon x=4): any staircase
    // step that first reaches x=4 must land on a solid cell. The entered face is always the -X
    // face of the slab, so the travel distance equals the pure x-axis distance.
    const world = new MapWorld();
    world.fill(4, 0, 0, 4, 0, 5);
    const dir = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }; // unit 45° in +X/+Z
    const hit = raycastVoxel(world, { x: 0.5, y: 0.5, z: 0.5 }, dir, 8);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBe(4);
    expect(hit!.z).toBeGreaterThanOrEqual(0);
    expect(hit!.z).toBeLessThanOrEqual(5);
    expect(hit!.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(hit!.distance).toBeCloseTo(3.5 / Math.SQRT1_2, 6);
  });
});
