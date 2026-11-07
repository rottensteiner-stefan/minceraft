import { describe, expect, it } from "vitest";
import {
  BLOCK_AIR,
  BLOCK_DIRT,
  BlockRegistry,
  BLOCK_GRASS,
  BLOCK_STONE,
} from "../src/voxel/BlockRegistry.js";
import { ChunkWorld } from "../src/voxel/ChunkWorld.js";
import type { ChunkWorldCallbacks } from "../src/voxel/ChunkWorld.js";
import { descriptorFromRegistry, type VoxelMeshData } from "../src/voxel/mesh/NaiveMesher.js";
import { ForegroundMeshClient } from "../src/voxel/worker/ForegroundMeshClient.js";

/**
 * ChunkWorld streaming/lifecycle tests. Run against `ForegroundMeshClient`, which executes the
 * EXACT pure paths the mesh worker runs (TerrainGenerator + buildMesh) on the calling thread --
 * so these tests verify the real M1 pipeline minus the message transport. All world behaviour
 * (lifecycle, minNeighborsToMesh, exactly-once, hysteresis, collision queries) is app-level and
 * intentionally node-testable.
 */

interface HostRecord {
  cx: number;
  cz: number;
  mesh: VoxelMeshData | null;
  unloaded: boolean;
}

function makeHarness(
  options: {
    seed?: number;
    radius?: number;
    callbacks?: Partial<ChunkWorldCallbacks>;
  } = {},
): { world: ChunkWorld; hosts: Map<string, HostRecord>; unloads: string[] } {
  const registry: BlockRegistry = new BlockRegistry();
  BlockRegistry.seed(registry);
  const descriptor = descriptorFromRegistry(registry);
  const hosts = new Map<string, HostRecord>();
  const unloads: string[] = [];
  const world = new ChunkWorld({
    client: new ForegroundMeshClient(),
    descriptor,
    seed: options.seed ?? 42,
    generateRadius: options.radius ?? 2,
    maxTasksPerTick: 64,
    callbacks: {
      onMeshReady: (cx, cz, mesh): void => {
        hosts.set(`${cx},${cz}`, { cx, cz, mesh, unloaded: false });
        options.callbacks?.onMeshReady?.(cx, cz, mesh);
      },
      onUnload: (cx, cz): void => {
        const key = `${cx},${cz}`;
        hosts.delete(key); // the real host glue removes its Object3D here
        unloads.push(key);
        options.callbacks?.onUnload?.(cx, cz);
      },
    },
  });
  return { world, hosts, unloads };
}

async function pump(world: ChunkWorld, ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    world.update();
    // Flush microtasks + a macrotask so ForegroundMeshClient promises settle between ticks.
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("ChunkWorld — streaming lifecycle", () => {
  it("generates, meshes and hosts every chunk in the meshed region exactly once", async () => {
    const { world, hosts } = makeHarness({ radius: 2, seed: 7 });
    world.setFocus(32, 32); // chunk (2, 2)
    await pump(world, 30);
    const stats = world.getStats();
    // radius 2 -> generated radii 0..2 = 25 in map at most; meshed radius 0..1 = 9 chunks.
    expect(stats.ready).toBe(9);
    expect(stats.generated).toBeGreaterThanOrEqual(9);
    expect(hosts.size).toBe(9);
    // Exactly-once: repeated pumping does not re-host.
    await pump(world, 10);
    expect(hosts.size).toBe(9);
    // Every hosted chunk has geometry.
    for (const host of hosts.values()) {
      expect(host.mesh).not.toBeNull();
      expect(host.mesh!.triangleCount).toBeGreaterThan(0);
    }
    world.destroy();
  });

  it("never meshes the outermost data ring (minNeighborsToMesh)", async () => {
    const { world, hosts } = makeHarness({ radius: 3, seed: 11 });
    world.setFocus(0, 0);
    await pump(world, 50);
    // radius 3 -> data ring 0..3, meshed ring 0..2 = 5x5 = 25.
    expect(hosts.size).toBe(25);
    // Ring at Chebyshev distance 3 must only exist as data (no host).
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== 3) continue;
        expect(hosts.has(`${dx},${dz}`), `edge chunk (${dx},${dz}) must not be meshed`).toBe(false);
      }
    }
    world.destroy();
  });

  it("moves the streaming window with the focus and unloads far chunks exactly once", async () => {
    const { world, hosts, unloads } = makeHarness({ radius: 2, seed: 3 });
    world.setFocus(0, 0);
    await pump(world, 30);
    expect(hosts.size).toBe(9);
    expect(unloads).toHaveLength(0);

    // Teleport the focus far away: the old window must fully unload, a new window must load.
    world.setFocus(16 * 20 + 8, 16 * 20 + 8); // chunk (20, 20)
    await pump(world, 30);

    expect(unloads.length).toBeGreaterThanOrEqual(9); // every old ready chunk was unloaded
    expect(hosts.size).toBe(9); // exactly the new window is hosted
    expect(hosts.has("20,20")).toBe(true);
    expect(hosts.has("2,2")).toBe(false);
    // No double unload: the total unload count equals the old window size exactly.
    expect(unloads.length).toBe(9);
    world.destroy();
  });
});

describe("ChunkWorld — collision queries against generated data", () => {
  it("getWorldBlock/isSolidAt reflect the generated terrain at any world cell", async () => {
    const { world } = makeHarness({ seed: 1234, radius: 2 });
    world.setFocus(16, 16); // chunk (1,1)
    await pump(world, 30);

    // Probe cells across several columns inside the meshed region.
    const probes: ReadonlyArray<readonly [number, number]> = [
      [16 + 3, 16 + 3],
      [16 + 7, 16 + 7],
      [16 + 12, 16 + 12],
      [17, 20],
    ];
    for (const [wx, wz] of probes) {
      // Walk from y=16 down: first solid row is the surface, above it is air.
      let surface = -1;
      for (let wy = 15; wy >= 0; wy--) {
        if (world.isSolidAt(wx, wy, wz)) {
          surface = wy;
          break;
        }
      }
      expect(surface, `surface must exist at (${wx}, ${wz})`).toBeGreaterThanOrEqual(0);
      // Surface is grass, below surface is dirt/stone, above is air.
      expect(world.getWorldBlock(wx, surface, wz)).toBe(BLOCK_GRASS);
      expect(world.isSolidAt(wx, surface + 1, wz)).toBe(false);
      expect([BLOCK_DIRT, BLOCK_STONE]).toContain(world.getWorldBlock(wx, surface - 1, wz));
    }
    world.destroy();
  });

  it("is deterministic for a fixed seed (player solidity can be unit-tested)", async () => {
    const a = makeHarness({ seed: 555, radius: 1 });
    const b = makeHarness({ seed: 555, radius: 1 });
    a.world.setFocus(16, 16);
    b.world.setFocus(16, 16);
    await pump(a.world, 15);
    await pump(b.world, 15);
    for (let wy = 0; wy < 16; wy++) {
      expect(a.world.getWorldBlock(16 + 5, wy, 16 + 5)).toBe(
        b.world.getWorldBlock(16 + 5, wy, 16 + 5),
      );
    }
    a.world.destroy();
    b.world.destroy();
  });

  it("reads unloaded/out-of-column cells as air (no crash on void probes)", async () => {
    const { world } = makeHarness({ radius: 1, seed: 1 });
    const farCx = 1000;
    // Unloaded chunk -> not solid.
    expect(world.isSolidAt(farCx * 16, 5, 0)).toBe(false);
    // Above the world column -> air.
    expect(world.isSolidAt(16, 60, 16)).toBe(false);
    // Negative coordinates resolve through windowing, not a crash.
    expect(typeof world.getWorldBlock(-1, 0, -1)).toBe("number");
    expect(world.getWorldBlock(16, -3, 16)).toBe(BLOCK_AIR);
    world.destroy();
  });
});
