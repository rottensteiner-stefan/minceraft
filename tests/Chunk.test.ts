import { describe, expect, it } from "vitest";
import { BLOCK_AIR, BLOCK_DIRT, BlockRegistry } from "../src/voxel/BlockRegistry.js";
import { Chunk } from "../src/voxel/Chunk.js";

describe("Chunk — data contract", () => {
  it("starts empty and not dirty", () => {
    const chunk = new Chunk();
    expect(chunk.dirty).toBe(false);
    expect(chunk.voxels.length).toBe(16 * 16 * 16);
  });

  it("reads back written voxels and flags dirty", () => {
    const chunk = new Chunk();
    expect(chunk.dirty).toBe(false);
    chunk.setBlock(3, 4, 5, BLOCK_DIRT);
    expect(chunk.getBlock(3, 4, 5)).toBe(BLOCK_DIRT);
    expect(chunk.dirty).toBe(true);
  });

  it("reads out-of-bounds positions as BLOCK_AIR", () => {
    const chunk = new Chunk();
    expect(chunk.getBlock(-1, 0, 0)).toBe(BLOCK_AIR);
    expect(chunk.getBlock(0, -1, 0)).toBe(BLOCK_AIR);
    expect(chunk.getBlock(0, 0, 16)).toBe(BLOCK_AIR);
    expect(chunk.getBlock(16, 0, 0)).toBe(BLOCK_AIR);
  });

  it("ignores out-of-bounds writes", () => {
    const chunk = new Chunk();
    chunk.setBlock(16, 0, 0, BLOCK_DIRT);
    chunk.setBlock(-1, 5, 5, BLOCK_DIRT);
    expect(chunk.voxels.every((v) => v === 0)).toBe(true);
  });

  it("fill only marks dirty when something changes", () => {
    const chunk = new Chunk();
    chunk.fill(BLOCK_AIR); // no-op change
    expect(chunk.dirty).toBe(false);
    chunk.fill(BLOCK_DIRT);
    expect(chunk.dirty).toBe(true);
    chunk.dirty = false;
    chunk.fill(BLOCK_DIRT); // same value again
    expect(chunk.dirty).toBe(false);
  });
});

describe("BlockRegistry — single source of truth", () => {
  it("rejects duplicate ids", () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    expect(() =>
      registry.register({
        id: BLOCK_DIRT,
        name: "dirt2",
        transparent: false,
        collidable: true,
        faceLayers: { top: 1, bottom: 1, side: 1 },
      }),
    ).toThrow();
  });

  it("treats unknown ids as non-solid", () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    expect(registry.isOpaque(99)).toBe(false);
    expect(registry.isOpaque(BLOCK_AIR)).toBe(false);
    expect(registry.isOpaque(BLOCK_DIRT)).toBe(true);
  });

  it("throws for faceLayer lookup of unknown ids", () => {
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    expect(() => registry.faceLayer(42, 2)).toThrow();
  });
});
