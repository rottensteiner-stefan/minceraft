import { describe, expect, it } from "vitest";
import { BlockRegistry, BLOCK_STONE } from "../src/voxel/BlockRegistry.js";
import { ChunkWorld } from "../src/voxel/ChunkWorld.js";
import { descriptorFromRegistry, type VoxelMeshData } from "../src/voxel/mesh/NaiveMesher.js";
import { ForegroundMeshClient } from "../src/voxel/worker/ForegroundMeshClient.js";

async function pump(world: ChunkWorld, ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    world.update();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("ChunkWorld — S4 Sparse Memory / Voxel Eviction Policy", () => {
  it("evicts CPU voxel arrays for distant chunks while retaining their GPU meshes", async () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);
    const meshes = new Map<string, VoxelMeshData>();

    const world = new ChunkWorld({
      client: new ForegroundMeshClient(),
      descriptor,
      seed: 42,
      generateRadius: 3,
      retainVoxelRadius: 1, // Focus is at (0, 0); distance > 1 should evict CPU voxels
      maxTasksPerTick: 64,
      callbacks: {
        onMeshReady: (cx, cz, mesh): void => {
          meshes.set(`${cx},${cz}`, mesh);
        },
        onUnload: (cx, cz): void => {
          meshes.delete(`${cx},${cz}`);
        },
      },
    });

    world.setFocus(0, 0);
    await pump(world, 40);

    const stats = world.getStats();
    // Meshed region for radius 3 is ring 0..2 (5x5 = 25 chunks)
    expect(stats.ready).toBe(25);
    expect(meshes.size).toBe(25);

    // With retainVoxelRadius = 1, only ring 0..1 (3x3 = 9 chunks) retain CPU voxel buffers.
    // Ring 2 (16 chunks) must have their CPU voxels evicted!
    expect(stats.voxelChunksRetained).toBeLessThan(stats.ready);
    expect(stats.voxelChunksRetained).toBeLessThanOrEqual(9);

    // Meshes must still be present in the host!
    expect(meshes.size).toBe(25);

    world.destroy();
  });

  it("reloads evicted voxels and restores edit deltas when player approaches", async () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);

    const world = new ChunkWorld({
      client: new ForegroundMeshClient(),
      descriptor,
      seed: 123,
      generateRadius: 3,
      retainVoxelRadius: 1,
      maxTasksPerTick: 64,
      callbacks: {
        onMeshReady: (): void => {},
        onUnload: (): void => {},
      },
    });

    // Start at (0, 0)
    world.setFocus(0, 0);
    await pump(world, 30);

    // Place a stone block in chunk (1, 1), which is currently retained
    const worldX = 16 + 5;
    const worldY = 10;
    const worldZ = 16 + 5;
    const edited = world.setBlock(worldX, worldY, worldZ, BLOCK_STONE);
    expect(edited).toBe(true);
    expect(world.getWorldBlock(worldX, worldY, worldZ)).toBe(BLOCK_STONE);

    // Move focus far away to (-20, 0) so chunk (1, 1) has distance > 1 (evicts voxels, but within unload radius)
    // Wait, unloadRadius is default 3 + 2 = 5. So move focus to (-32, 0) -> chunk (-2, 0)
    // Distance from (-2, 0) to (1, 1) is max(3, 1) = 3 <= unloadRadius (5), but > retainVoxelRadius (1).
    world.setFocus(-32, 0);
    await pump(world, 30);

    // Chunk (1, 1) should now have had its CPU voxels evicted
    // Move focus BACK to (16, 16) -> chunk (1, 1)
    world.setFocus(16, 16);
    await pump(world, 30);

    // The voxel data should be reloaded and the edit delta preserved!
    expect(world.getWorldBlock(worldX, worldY, worldZ)).toBe(BLOCK_STONE);

    world.destroy();
  });
});
