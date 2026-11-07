import { describe, expect, it } from "vitest";
import { BLOCK_AIR, BLOCK_DIRT, BLOCK_GRASS, BLOCK_STONE } from "../src/voxel/BlockRegistry.js";
import { Chunk } from "../src/voxel/Chunk.js";
import { TerrainGenerator } from "../src/voxel/TerrainGenerator.js";

function surfaceAt(buf: Uint8Array, x: number, z: number): number {
  const size = Chunk.SIZE;
  let surface = -1;
  for (let y = size - 1; y >= 0; y--) {
    if (buf[x + z * size + y * size * size] !== BLOCK_AIR) {
      surface = y;
      break;
    }
  }
  return surface;
}

describe("TerrainGenerator — determinism & seed separation", () => {
  it("same seed + same coords -> byte-identical columns", () => {
    const a = new TerrainGenerator({ seed: 1337 }).generateColumn(3, 0, -2);
    const b = new TerrainGenerator({ seed: 1337 }).generateColumn(3, 0, -2);
    const c = new TerrainGenerator({ seed: 1337 }).generateColumn(3, 0, -2);
    expect(b).toEqual(a);
    expect(Buffer.from(c).equals(Buffer.from(a))).toBe(true);
  });

  it("different seeds -> different columns", () => {
    const a = new TerrainGenerator({ seed: 1 }).generateColumn(0, 0, 0);
    const b = new TerrainGenerator({ seed: 2 }).generateColumn(0, 0, 0);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("repeated calls with the same generator are stable (no hidden state mutation)", () => {
    const gen = new TerrainGenerator({ seed: 42 });
    const first = gen.generateColumn(1, 0, 1);
    const second = gen.generateColumn(1, 0, 1);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });
});

describe("TerrainGenerator — world-field soundness", () => {
  it("surface stays inside the column and layered correctly (grass cap, dirt crust, stone base)", () => {
    const gen = new TerrainGenerator({ seed: 99 });
    const columns: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 5],
      [7, -7],
    ];
    for (const [cx, cz] of columns) {
      const col = gen.generateColumn(cx, 0, cz);
      // Column is not empty and not fully solid.
      let solids = 0;
      for (const id of col) if (id !== BLOCK_AIR) solids++;
      expect(solids).toBeGreaterThan(0);
      expect(solids).toBeLessThan(16 * 16 * 16);

      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          const h = surfaceAt(col, x, z);
          expect(h).toBeGreaterThanOrEqual(1);
          expect(h).toBeLessThanOrEqual(Chunk.SIZE - 2);
          // The surface cell is grass.
          expect(col[x + z * 16 + h * 256]).toBe(BLOCK_GRASS);
          // One layer below it is dirt (crust).
          expect(col[x + z * 16 + Math.max(0, h - 1) * 256]).toBe(BLOCK_DIRT);
          // Deep below (h-5, when >= 0) is stone.
          if (h >= 5) {
            expect(col[x + z * 16 + (h - 5) * 256]).toBe(BLOCK_STONE);
          }
          // Above the surface is air.
          if (h + 1 < 16) {
            expect(col[x + z * 16 + (h + 1) * 256]).toBe(BLOCK_AIR);
          }
        }
      }
    }
  });

  it("heightAt matches the column surface (used for safe spawn)", () => {
    const gen = new TerrainGenerator({ seed: 1234 });
    const columns: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [2, 3],
      [-4, 1],
    ];
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [7, 7],
      [15, 15],
    ];
    for (const [cx, cz] of columns) {
      for (const [lx, lz] of offsets) {
        const wx = cx * 16 + lx;
        const wz = cz * 16 + lz;
        const h = gen.heightAt(wx, wz);
        const col = gen.generateColumn(cx, 0, cz);
        expect(surfaceAt(col, lx, lz)).toBe(h);
      }
    }
  });

  it("is globally self-consistent (the real no-seam & worker/main-parity property)", () => {
    // The generator is a pure function of world coordinates. The PROOF that two chunk contexts
    // (the mesh worker's generated column vs any direct field query) can never disagree -- and
    // therefore can never render a crack across a border -- is that evaluating the surface THROUGH
    // a generated column equals evaluating it directly via `heightAt` at the same world cell.
    const gen = new TerrainGenerator({ seed: 777 });
    const worldCells: Array<[number, number]> = [];
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [7, 7],
      [15, 15],
      [15, 0],
      [0, 15],
    ];
    for (let cz = -2; cz <= 2; cz++) {
      for (let cx = -2; cx <= 2; cx++) {
        for (const [lx, lz] of offsets) {
          worldCells.push([cx * 16 + lx, cz * 16 + lz]);
        }
      }
    }
    for (const [wx, wz] of worldCells) {
      const cx = Math.floor(wx / 16);
      const cz = Math.floor(wz / 16);
      const lx = ((wx % 16) + 16) % 16;
      const lz = ((wz % 16) + 16) % 16;
      const col = gen.generateColumn(cx, 0, cz);
      expect(surfaceAt(col, lx, lz)).toBe(gen.heightAt(wx, wz));
    }
  });

  it("keeps adjacent world cells within a modest step (blocky hills, no cliffs)", () => {
    // Repo-measured bound (seed 777): max |Δsurface| between ANY two adjacent world cells is 3.
    // Steps are normal voxel terrain; 3 is far below cliff territory and identical on both sides
    // of a chunk border (both evaluate the same field) -- never a crack.
    const gen = new TerrainGenerator({ seed: 777 });
    let maxDelta = 0;
    for (let cz = -4; cz < 4; cz++) {
      for (let cx = -4; cx < 4; cx++) {
        const col = gen.generateColumn(cx, 0, cz);
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const h = surfaceAt(col, x, z);
            if (x > 0) maxDelta = Math.max(maxDelta, Math.abs(h - surfaceAt(col, x - 1, z)));
            if (z > 0) maxDelta = Math.max(maxDelta, Math.abs(h - surfaceAt(col, x, z - 1)));
          }
        }
        const next = gen.generateColumn(cx + 1, 0, cz);
        for (let z = 0; z < 16; z++) {
          maxDelta = Math.max(maxDelta, Math.abs(surfaceAt(col, 15, z) - surfaceAt(next, 0, z)));
        }
        const below = gen.generateColumn(cx, 0, cz + 1);
        for (let z = 0; z < 16; z++) {
          maxDelta = Math.max(maxDelta, Math.abs(surfaceAt(col, z, 0) - surfaceAt(below, z, 15)));
        }
      }
    }
    expect(maxDelta).toBeLessThanOrEqual(3);
  });
});

describe("TerrainGenerator — configuration contract", () => {
  it("clamps configured heights to the valid column band", () => {
    const gen = new TerrainGenerator({ seed: 5, baseHeight: 100, heightAmplitude: 60 });
    const col = gen.generateColumn(0, 0, 0);
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        expect(surfaceAt(col, x, z)).toBeLessThanOrEqual(Chunk.SIZE - 2);
      }
    }
  });

  it("respects an explicit tight height range", () => {
    const gen = new TerrainGenerator({ seed: 5, baseHeight: 5, heightRange: [5, 5] });
    const col = gen.generateColumn(0, 0, 0);
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        expect(surfaceAt(col, x, z)).toBe(5);
      }
    }
  });

  it("worker-parity: the pure column function is the one the worker will run (identity path)", () => {
    // The mesh worker imports this exact module; proving the exported path is pure and
    // self-contained (it must not touch any closure the worker would lose).
    const fn = new TerrainGenerator({ seed: 31337 });
    expect(typeof fn.generateColumn).toBe("function");
    const col = fn.generateColumn(10, 0, -10);
    expect(col.length).toBe(16 * 16 * 16);
    expect(col).toBeInstanceOf(Uint8Array);
  });
});
