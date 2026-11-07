import { Chunk } from "./Chunk.js";
import { BLOCK_AIR, BLOCK_DIRT, BLOCK_GRASS, BLOCK_STONE } from "./BlockRegistry.js";

/**
 * Deterministic, seeded terrain generation (M1, dossier §4.2 / §5 S2 "Welt-Gen und Mesh-Bau in
 * getrennten Rollen"). Pure TS -- no engine import, no DOM, no global state -- so the exact same
 * module runs on the main thread (unit tests, foreground fallback) AND inside the mesh worker.
 *
 * CRITICAL seam property: the generator is a plain FUNCTION of world coordinates + the seed. It
 * must NOT invent per-chunk randomness -- otherwise two adjacent chunk columns would draw
 * unrelated terrain and the world would crack at every chunk border. Each `generateColumn`
 * therefore re-evaluates the same global noise field at its world cells; the field is fully
 * deterministic for one seed and continuous across chunk edges by construction.
 *
 * Block mapping (matches the seeded `BlockRegistry` semantics and the M0 palette):
 *   - surface   (y == h)  -> GRASS   (registry: top=grass, side=dirt, bottom=stone)
 *   - subsurface (y < h)  -> DIRT down to h-4, STONE below
 * Empty chunks yield zero triangles and are never meshed.
 */

const OCTAVES = 4;

/** Deterministic integer hash of a world cell position for a given octave/seed. Returns [0,1). */
function cellNoise(x: number, y: number, seed: number): number {
  let h = seed;
  h = Math.imul(h ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263), 1274126177);
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smoothstep fade (value-noise standard; keeps the field C¹ so fbm has no corner artifacts). */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2D value-noise at fractional world coordinates (bilinear of the 4 lattice corners). */
function noise2(px: number, py: number, seed: number): number {
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const dx = fade(fx);
  const dy = fade(fy);
  const a = cellNoise(x0, y0, seed);
  const b = cellNoise(x0 + 1, y0, seed);
  const c = cellNoise(x0, y0 + 1, seed);
  const d = cellNoise(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * dx;
  const cd = c + (d - c) * dx;
  return ab + (cd - ab) * dy;
}

/** Fractal value noise (fbm) over the world column coordinate, continuous everywhere. */
function fbm(wx: number, wz: number, seeds: readonly number[]): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < OCTAVES; o++) {
    sum += noise2(wx * 0.02 * freq, wz * 0.02 * freq, seeds[o]!) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm; // [0,1]
}

export interface TerrainGeneratorOptions {
  /** World seed. Same seed -> identical world (verified by tests). */
  seed: number;
  /** Base surface height (lowest possible terrain). Default 6. */
  baseHeight?: number;
  /** Height amplitude added on top of the base. Default 6. */
  heightAmplitude?: number;
  /** Hard surface clamp: [min, max] inside the 16³ column. Defaults [3, 13]. */
  heightRange?: readonly [number, number];
}

/**
 * Seeded world-column generator. One instance per engine/app (no singleton). Constructed with the
 * same seed inside the mesh worker (from the `init` message) and on the main thread -- both must
 * produce byte-identical columns so tests can verify worker parity.
 */
export class TerrainGenerator {
  private readonly _seed: number;
  private readonly _baseHeight: number;
  private readonly _heightAmplitude: number;
  private readonly _heightMin: number;
  private readonly _heightMax: number;
  /** Per-octave hash seeds mixed from the world seed (kept private: the field is the contract). */
  private readonly _octaveSeeds: readonly number[];

  constructor(options: TerrainGeneratorOptions) {
    this._seed = options.seed;
    const range = options.heightRange ?? [3, 13];
    this._heightMin = Math.max(1, Math.min(range[0]!, range[1]!));
    this._heightMax = Math.max(this._heightMin, range[1]!);
    // Keep the surface at least 1 block below the chunk top and above the floor.
    this._heightMax = Math.min(this._heightMax, Chunk.SIZE - 2);
    this._heightMin = Math.min(this._heightMin, this._heightMax);
    this._baseHeight = options.baseHeight ?? 6;
    this._heightAmplitude = options.heightAmplitude ?? 6;
    const seeds: number[] = [];
    let s = this._seed >>> 0;
    for (let i = 0; i < OCTAVES; i++) {
      // Derive a distinct, deterministic octave seed (mulberry32-style mix).
      s = (Math.imul(s ^ (s >>> 15), 2246822519) >>> 0) ^ (s >>> 13);
      seeds.push(s || 0x9e3779b9);
    }
    this._octaveSeeds = seeds;
  }

  /** The surface height (topmost solid y, world units) at a world column. Used for spawning. */
  public heightAt(wx: number, wz: number): number {
    const f = fbm(wx, wz, this._octaveSeeds);
    const h = Math.round(this._baseHeight + f * this._heightAmplitude);
    return Math.max(this._heightMin, Math.min(this._heightMax, h));
  }

  /**
   * Generates the full 16³ block-id buffer for the chunk column at chunk coords (cx, cz).
   * `cy` is fixed to 0 (single-column world for M1). Returns a plain Uint8Array so the result
   * survives structured clone out of the worker without class-prototype issues.
   */
  public generateColumn(cx: number, cy: number, cz: number): Uint8Array {
    const size = Chunk.SIZE;
    const out = new Uint8Array(size * size * size);
    const originX = cx * size;
    const originZ = cz * size;
    void cy; // M1 world is a vertical column per (cx, cz) -- cy is always 0 here.
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const h = this.heightAt(originX + x, originZ + z);
        for (let y = 0; y < size; y++) {
          // Ordered by priority: below-surface (dirt 4 layers -> stone), surface (grass), else air.
          const id =
            y < h ? (y >= h - 4 ? BLOCK_DIRT : BLOCK_STONE) : y === h ? BLOCK_GRASS : BLOCK_AIR;
          out[x + z * size + y * size * size] = id;
        }
      }
    }
    return out;
  }
}
