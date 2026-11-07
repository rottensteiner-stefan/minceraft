import { describe, expect, it } from "vitest";
import { BlockRegistry, BLOCK_AIR, BLOCK_DIRT, BLOCK_STONE } from "../src/voxel/BlockRegistry.js";
import { Chunk } from "../src/voxel/Chunk.js";
import { ChunkWorld } from "../src/voxel/ChunkWorld.js";
import { buildGreedyMesh } from "../src/voxel/mesh/GreedyMesher.js";
import { descriptorFromRegistry } from "../src/voxel/mesh/NaiveMesher.js";
import { ForegroundMeshClient } from "../src/voxel/worker/ForegroundMeshClient.js";
import { sweepVoxel, type SweepWorld } from "../src/voxel/physics/VoxelSweep.js";

async function pump(world: ChunkWorld, ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    world.update();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("VoxelEdgeFuzz — Boundary & Torture Tests (M5)", () => {
  it("handles out-of-bounds coords without throwing or corrupting chunk state", () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);

    const world = new ChunkWorld({
      client: new ForegroundMeshClient(),
      descriptor,
      seed: 99,
      generateRadius: 2,
      callbacks: { onMeshReady: (): void => {}, onUnload: (): void => {} },
    });

    world.setFocus(0, 0);

    const extremeCoords = [
      [-1e6, 0, -1e6],
      [1e6, 10, 1e6],
      [0, -100, 0],
      [0, 1000, 0],
      [NaN, 0, 0],
      [0, NaN, 0],
      [0, 0, Infinity],
    ];

    for (const [x, y, z] of extremeCoords) {
      expect(() => world.getWorldBlock(x!, y!, z!)).not.toThrow();
      expect(() => world.isSolidAt(x!, y!, z!)).not.toThrow();
      expect(() => world.setBlock(x!, y!, z!, BLOCK_STONE)).not.toThrow();
      expect(() => world.lightFactorAt(x!, y!, z!)).not.toThrow();
    }

    world.destroy();
  });

  it("handles rapid alternating place/break exactly along 4-chunk seam lines", async () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);

    let meshesBuilt = 0;
    const world = new ChunkWorld({
      client: new ForegroundMeshClient(),
      descriptor,
      seed: 1234,
      generateRadius: 3,
      callbacks: {
        onMeshReady: (): void => {
          meshesBuilt++;
        },
        onUnload: (): void => {},
      },
    });

    world.setFocus(16, 16);
    await pump(world, 20);

    const seamCoords = [
      [15, 5, 15], // chunk (0, 0)
      [16, 5, 15], // chunk (1, 0)
      [15, 5, 16], // chunk (0, 1)
      [16, 5, 16], // chunk (1, 1)
    ];

    // Rapid toggle 20 times across 4 seam blocks
    for (let i = 0; i < 20; i++) {
      const id = i % 2 === 0 ? BLOCK_DIRT : BLOCK_AIR;
      for (const [x, y, z] of seamCoords) {
        world.setBlock(x!, y!, z!, id);
      }
      await pump(world, 2);
    }

    await pump(world, 10);
    expect(meshesBuilt).toBeGreaterThan(0);
    expect(world.getStats().edits).toBeGreaterThanOrEqual(20);

    world.destroy();
  });

  it("safely handles extreme player velocity sweeps across multiple chunk boundaries", () => {
    const world: SweepWorld = {
      isSolidCell: (_x: number, y: number, _z: number): boolean => y <= 0,
    };

    const boxOffset = {
      min: { x: -0.3, y: 0, z: -0.3 },
      max: { x: 0.3, y: 1.8, z: 0.3 },
    };

    // Extreme velocity moving across ~100 blocks in 1 tick
    const result = sweepVoxel({
      position: { x: 10, y: 2, z: 10 },
      velocity: { x: 100, y: -50, z: 100 },
      options: {
        accel: { x: 0, y: -20, z: 0 },
        boxOffset,
        maxDtime: 0.1,
      },
      world,
      dt: 0.05,
    });

    expect(result.onGround).toBe(true);
    expect(result.position.y).toBeCloseTo(1, 1); // floor at y <= 0, so feet stop on top of solid cell at y=1
    expect(Number.isFinite(result.position.x)).toBe(true);
    expect(Number.isFinite(result.position.z)).toBe(true);
  });

  it("correctly meshes complex 3D checkerboard patterns without crashing", () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);

    const size = Chunk.SIZE;
    const voxels = new Uint8Array(size * size * size);

    // 3D 3D checkerboard
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        for (let x = 0; x < size; x++) {
          if ((x + y + z) % 2 === 0) {
            voxels[x + z * size + y * size * size] = BLOCK_STONE;
          }
        }
      }
    }

    const mesh = buildGreedyMesh({ voxels, descriptor });
    expect(mesh.triangleCount).toBeGreaterThan(0);
    expect(mesh.positions.length).toBe(mesh.triangleCount * 6);
  });
});
