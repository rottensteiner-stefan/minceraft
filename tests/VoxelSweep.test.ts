import { describe, expect, it } from "vitest";
import {
  sweepVoxel,
  type SweepResult,
  type SweepWorld,
  type Vec3,
} from "../src/voxel/physics/VoxelSweep.js";

/**
 * Voxel-grid AABB sweep tests (dossier §4.2 M1 "VoxelSweep-Kollisions-Resolver"). The sweep is a
 * pure function against an injected `SweepWorld`, so the M1 contract -- the player STANDS on the
 * terrain, slides along walls, never tunnels through fast falls -- is pinned here in node,
 * WITHOUT the engine.
 *
 * Box model under test: a 1.8 m tall, 0.6 m wide player, `BOX` offsets relative to the feet
 * origin, gravity passed as `accel` (gravity-in-accel model, see VoxelSweep header).
 */

const GRAVITY = { x: 0, y: -20, z: 0 };
const DT = 1 / 60;
/** 1.8 m tall, 0.6 m wide player with the origin at the feet. */
const BOX = {
  min: { x: -0.3, y: 0, z: -0.3 },
  max: { x: 0.3, y: 1.8, z: 0.3 },
};

class SolidWorld implements SweepWorld {
  private readonly _solid = new Map<string, boolean>();

  public setSolid(x: number, y: number, z: number, solid = true): void {
    this._solid.set(SolidWorld._key(x, y, z), solid);
  }

  /** Fills a flat plateau of solid cells at `y` spanning [xFrom, xTo] × [zFrom, zTo]. */
  public setFloor(y: number, xFrom: number, xTo: number, zFrom: number, zTo: number): void {
    for (let z = zFrom; z <= zTo; z++) {
      for (let x = xFrom; x <= xTo; x++) {
        this.setSolid(x, y, z);
      }
    }
  }

  public isSolidCell(x: number, y: number, z: number): boolean {
    return this._solid.get(SolidWorld._key(x, y, z)) ?? false;
  }

  private static _key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }
}

function step(world: SweepWorld, position: Vec3, velocity: Vec3, dt = DT): SweepResult {
  return sweepVoxel({
    world,
    options: { boxOffset: BOX, accel: GRAVITY },
    position,
    velocity,
    dt,
  });
}

/** Stepped simulation, the way the player behavior consumes the sweep each frame. */
function simulate(
  world: SweepWorld,
  position: Vec3,
  velocity: Vec3,
  control: (pos: Vec3, vel: Vec3, frames: number) => Vec3,
  maxFrames: number,
): { result: SweepResult; frames: number } {
  let pos = { x: position.x, y: position.y, z: position.z };
  let vel = { x: velocity.x, y: velocity.y, z: velocity.z };
  for (let f = 0; f < maxFrames; f++) {
    vel = control(pos, vel, f);
    const r = step(world, pos, vel);
    pos = r.position;
    vel = r.velocity;
    if (r.onGround) vel.y = 0;
    if (f === maxFrames - 1)
      return { result: { ...r, position: pos, velocity: vel }, frames: f + 1 };
  }
  throw new Error("simulate reached maxFrames without returning");
}

describe("VoxelSweep — empty world (pure integration)", () => {
  it("integrates gravity exactly without any collision flags", () => {
    const world = new SolidWorld();
    const result = step(world, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 });
    // p.y = 10 + (0 + g*0.5*dt)*dt = 10 - 0.5*g*dt² ; v.y = 0 + g*dt.
    expect(result.position.y).toBeCloseTo(10 - 0.5 * 20 * DT * DT, 12);
    expect(result.velocity.y).toBeCloseTo(-20 * DT, 12);
    expect(result.position.x).toBeCloseTo(0, 12);
    expect(result.position.z).toBeCloseTo(0, 12);
    expect(result.onGround).toBe(false);
    expect(result.collisionCount).toBe(0);
    expect(result.blocked).toBe(false);
  });

  it("never mutates the caller's input vectors (fresh result)", () => {
    const world = new SolidWorld();
    const position = { x: 3, y: 7, z: 2 };
    const velocity = { x: 1, y: -2, z: 0 };
    const result = step(world, position, velocity);
    expect(position).toEqual({ x: 3, y: 7, z: 2 });
    expect(velocity).toEqual({ x: 1, y: -2, z: 0 });
    expect(result.position).not.toBe(position);
    expect(result.velocity).not.toBe(velocity);
  });
});

describe("VoxelSweep — ground contact", () => {
  it("keeps the player standing exactly on the floor top (top = feet)", () => {
    const world = new SolidWorld();
    world.setFloor(0, -4, 4, -4, 4); // top at y = 1
    const result = step(world, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(result.position.y).toBe(1);
    expect(result.onGround).toBe(true);
    expect(result.collisionCount).toBeGreaterThanOrEqual(1);
    // Gravity tail is small enough for the caller to zero; see header note.
    expect(Math.abs(result.velocity.y)).toBeLessThanOrEqual(20 * DT + 1e-9);
  });

  it("lands EXACTLY on the floor top after a fall (|vy| reaches the surface, no over-penetration)", () => {
    const world = new SolidWorld();
    world.setFloor(0, -4, 4, -4, 4);
    // |vy| = 400 closes the 3 m gap within the single 1/60 s frame: the solver must resolve the
    // impact at the exact surface and snap FEET to the block top, never overshoot below it.
    const result = step(world, { x: 0, y: 4, z: 0 }, { x: 0, y: -400, z: 0 });
    expect(result.position.y).toBe(1);
    expect(result.onGround).toBe(true);
    expect(result.position.y).toBeGreaterThanOrEqual(1);
  });

  it("reports onGround exactly within the Luanti 0.05 ground contact band", () => {
    const world = new SolidWorld();
    world.setFloor(0, -4, 4, -4, 4);
    // Feet 3 cm above the floor top -> inside the band -> onGround (matches Luanti final touches).
    const inBand = step(world, { x: 0, y: 1.03, z: 0 }, { x: 0, y: 0, z: 0 }, 1e-4);
    expect(inBand.onGround).toBe(true);
    // Feet 10 cm above -> outside -> not onGround.
    const outBand = step(world, { x: 0, y: 1.1, z: 0 }, { x: 0, y: 0, z: 0 }, 1e-4);
    expect(outBand.onGround).toBe(false);
    // A player falling in open air is not onGround.
    const air = step(world, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(air.onGround).toBe(false);
  });

  it("mid-air fall never reports onGround until the landing frame", () => {
    const world = new SolidWorld();
    world.setFloor(0, -4, 4, -4, 4);
    let pos = { x: 0, y: 30, z: 0 };
    let vel = { x: 0, y: 0, z: 0 };
    let onGroundSeen = 0;
    for (let f = 0; f < 600 && onGroundSeen < 1; f++) {
      const r = step(world, pos, vel);
      pos = r.position;
      vel = r.velocity;
      expect(pos.y).toBeGreaterThanOrEqual(1 - 1e-9); // never tunnels through the floor
      if (r.onGround) onGroundSeen++;
    }
    expect(onGroundSeen).toBe(1);
    expect(pos.y).toBe(1);
  });
});

describe("VoxelSweep — no tunneling at extreme fall speeds", () => {
  it("resolves a frame that crosses several cells without passing through (single frame)", () => {
    const world = new SolidWorld();
    world.setFloor(0, -4, 4, -4, 4);
    // Gap of 5 m closed in one 1/60 s frame at |vy| = 400 -> lands, never tunnels.
    const result = step(world, { x: 0, y: 6, z: 0 }, { x: 0, y: -400, z: 0 });
    expect(result.position.y).toBe(1);
    expect(result.onGround).toBe(true);
    expect(result.collisionCount).toBeGreaterThanOrEqual(1);
  });

  it("lands exactly even approaching the solver speed clamp (5000), never penetrating", () => {
    const world = new SolidWorld();
    world.setFloor(0, -4, 4, -4, 4);
    let pos = { x: 0, y: 120, z: 0 };
    let vel = { x: 0, y: -5000, z: 0 };
    for (let f = 0; f < 200; f++) {
      const r = step(world, { ...pos }, vel);
      pos = r.position;
      vel = r.velocity;
      expect(pos.y, `frame ${f}`).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(r.onGround, `frame ${f}`).toBe(r.position.y === 1);
      if (r.position.y === 1 && r.onGround) break;
    }
    expect(pos.y).toBe(1);
  });
});

describe("VoxelSweep — walls and ceilings", () => {
  it("slides along a wall while staying grounded (no lateral penetration)", () => {
    const world = new SolidWorld();
    world.setFloor(0, -4, 8, -2, 2);
    // A 3-tall wall standing on the floor across the player's forward path.
    for (let y = 1; y <= 3; y++) {
      for (let z = -2; z <= 2; z++) world.setSolid(3, y, z);
    }
    const sim = simulate(
      world,
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 0 },
      (pos, _vel) => ({ x: 3, y: pos.y === 1 ? 0 : _vel.y, z: 0 }),
      600,
    );
    // The wall face at x = 3 stops the AABB exactly: max.x must sit on 3, origin.x on 2.7.
    expect(sim.result.position.x).toBeGreaterThan(2.6);
    expect(sim.result.position.x).toBeLessThanOrEqual(2.7 + 1e-6);
    // The player never entered the wall cell (max.x <= wall face).
    expect(sim.result.position.x + BOX.max.x).toBeLessThanOrEqual(3 + 1e-6);
    // Still standing on the floor the whole time.
    expect(sim.result.position.y).toBe(1);
    expect(sim.result.onGround).toBe(true);
  });

  it("stops a jump under a ceiling (blocks + zeroes the axis, no ground flag)", () => {
    const world = new SolidWorld();
    // Ceiling slab occupying [5,6] in y above the player.
    for (let z = -2; z <= 2; z++) {
      for (let x = -2; x <= 2; x++) world.setSolid(x, 5, z);
    }
    // Player below, jumping up hard enough to cross the 0.7 m gap in one frame.
    const result = step(world, { x: 0, y: 2.5, z: 0 }, { x: 0, y: 60, z: 0 });
    // AABB max.y snapped exactly to the ceiling bottom (y = 5) -> origin.y = 5 - 1.8.
    expect(result.position.y).toBe(3.2);
    expect(result.position.y + BOX.max.y).toBe(5);
    expect(result.onGround).toBe(false);
    expect(result.collisionCount).toBeGreaterThanOrEqual(1);
    expect(Math.abs(result.velocity.y)).toBeLessThanOrEqual(20 * DT + 1e-9);
  });
});
