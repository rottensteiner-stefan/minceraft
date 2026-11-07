import { describe, expect, it } from "vitest";
import { BLOCK_TEX_LAYER } from "../src/voxel/BlockRegistry.js";
import {
  ATLAS_PIXEL_HEX,
  ATLAS_SOURCES,
  atlasLayerNames,
  atlasPacking,
  atlasTilePosition,
  BLOCK_ATLAS_COLS,
  decodeHexRgba,
  flipVertical,
} from "../src/voxel/palette/AtlasPixels.js";

/**
 * M2 atlas palette (CC0, embedded pixel grids). Data-level guards only (no DOM -- the factory
 * that converts grids into a TextureArray is browser-only): layer-sync with `BLOCK_TEX_LAYER`,
 * the 16x16 RGBA shape, per-pixel alpha semantics (only WATER may be translucent) and the
 * provenance contract (source URL + license recorded for the asset-sourcing doctrine).
 */

describe("Atlas palette — layer integrity", () => {
  it("ATLAS_PIXEL_HEX keys are EXACTLY the BLOCK_TEX_LAYER keys (factory fail-fast sync)", () => {
    const atlas = new Set(atlasLayerNames());
    const registry = new Set(Object.keys(BLOCK_TEX_LAYER));
    expect(atlas).toEqual(registry);
  });

  it("every layer decodes to a 16x16 RGBA grid (1024 bytes)", () => {
    for (const name of atlasLayerNames()) {
      const decoded = decodeHexRgba(ATLAS_PIXEL_HEX[name]!);
      expect(decoded.length).toBe(16 * 16 * 4);
    }
  });

  it("opaque tiles carry alpha 255; ONLY water carries genuinely translucent pixels", () => {
    for (const name of atlasLayerNames()) {
      const decoded = decodeHexRgba(ATLAS_PIXEL_HEX[name]!);
      const alphas = new Set<number>();
      for (let i = 3; i < decoded.length; i += 4) alphas.add(decoded[i]!);
      if (name === "WATER") {
        expect(
          [...alphas].every((a) => a > 0 && a < 255),
          "water must be semi-transparent",
        ).toBe(true);
      } else {
        expect([...alphas].filter((a) => a !== 255).length, `${name} must be fully opaque`).toBe(0);
      }
    }
  });

  it("decodeHexRgba round-trips (deterministic, length-exact)", () => {
    const hex = ATLAS_PIXEL_HEX["WATER"]!;
    const decoded = decodeHexRgba(hex);
    expect(decoded.length).toBe(hex.length / 2);
    // First byte must parse from the two leading hex chars.
    expect(decoded[0]).toBe(parseInt(hex.slice(0, 2), 16));
  });
});

describe("Atlas palette — provenance", () => {
  it("records a CC0 source + license for the set and the in-house water tile", () => {
    expect(ATLAS_SOURCES.length).toBeGreaterThanOrEqual(2);
    for (const entry of ATLAS_SOURCES) {
      expect(entry.source.length).toBeGreaterThan(0);
      expect(entry.license.toLowerCase()).toContain("cc0");
      expect(entry.author.length).toBeGreaterThan(0);
      expect(entry.pack.length).toBeGreaterThan(0);
    }
  });

  it("flags the water tile as a project-internal Nachzeichnung (not from the CC0 set)", () => {
    const water = ATLAS_SOURCES.find((e) =>
      e.layer
        .split(",")
        .map((s) => s.trim())
        .includes("WATER"),
    );
    expect(water).toBeDefined();
    expect(water!.pack.toLowerCase()).toContain("nachzeichnung");
    expect(water!.note.length).toBeGreaterThan(10);
  });
});

describe("WebGL1 2D-atlas packing helpers", () => {
  it("packs every registry layer row-major into the fixed 4-column grid (covers them all)", () => {
    const layerCount = Object.keys(BLOCK_TEX_LAYER).length;
    const { cols, rows } = atlasPacking(layerCount, BLOCK_ATLAS_COLS);
    expect(cols).toBe(BLOCK_ATLAS_COLS);
    expect(rows).toBe(2);
    expect(cols * rows).toBeGreaterThanOrEqual(layerCount);

    // Every layer must land inside the grid and the shader's `u_atlasGrid` contract (`mod`/`floor`).
    for (let layer = 0; layer < layerCount; layer++) {
      const { col, row } = atlasTilePosition(layer, cols);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(cols);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(rows);
    }
    // Shader-shared semantics: `col = mod(l, cols)`, `row = floor(l / cols)` (BlockMaterial.frag.glsl100).
    expect(atlasTilePosition(0, cols)).toEqual({ col: 0, row: 0 });
    expect(atlasTilePosition(3, cols)).toEqual({ col: 3, row: 0 });
    expect(atlasTilePosition(4, cols)).toEqual({ col: 0, row: 1 });
    expect(atlasTilePosition(7, cols)).toEqual({ col: 3, row: 1 });
  });

  it("flipVertical reverses the 16x16 RGBA rows on a fresh copy (source untouched)", () => {
    const grid = decodeHexRgba(ATLAS_PIXEL_HEX["GRASS_TOP"]!);
    const flipped = flipVertical(grid, 16);
    expect(flipped.length).toBe(grid.length);
    // Top row <-> bottom row, pixel-exact.
    expect(Array.from(flipped.subarray(0, 16 * 4))).toEqual(
      Array.from(grid.subarray(15 * 16 * 4, 16 * 16 * 4)),
    );
    expect(Array.from(flipped.subarray(15 * 16 * 4, 16 * 16 * 4))).toEqual(
      Array.from(grid.subarray(0, 16 * 4)),
    );
    // Idempotence: flipping twice restores the original bytes.
    expect(Array.from(flipVertical(flipped, 16))).toEqual(Array.from(grid));
  });

  it("flipVertical fails fast on a non-quadratic RGBA buffer", () => {
    expect(() => flipVertical(new Uint8Array(16 * 16 * 4 + 1), 16)).toThrow();
  });
});
