import type { ChunkDeltaData } from "./ChunkDeltaCodec.js";
import { decodeChunkDelta } from "./ChunkDeltaCodec.js";

/**
 * M3 persistence contract (dossier §4.2 M3, D1/D2/D3 + D3b): a per-chunk EDIT-DELTA store --
 * only the cells that differ from the deterministically generated world. Interface-FIRST (D2):
 * the world talks to this interface; drivers implement it (currently only `IndexedDbDriver`,
 * later OPFS or anything else). A memory driver is exported for node tests and as the
 * headless-gate fallback where no browser storage exists.
 *
 * Owing to the pure codec, a driver stores/retrieves opaque `Uint8Array` payloads keyed by
 * (cx,cz) -- (de)serialization and version handling live in the codec, never in a driver.
 */

/** Chunk/seed persistence contract used by `ChunkWorld` (M3). */
export interface ChunkDeltaStore {
  /** Returns the persisted world seed, or `null` when nothing was saved yet (D3b). */
  getSeed(): Promise<number | null>;
  /** Persists the world seed on first save so a relaunch rebuilds the exact same world. */
  setSeed(seed: number): Promise<void>;
  /** Raw payload of the (cx,cz) delta, or `null` if the chunk has no edits. */
  loadChunkDelta(cx: number, cz: number): Promise<Uint8Array | null>;
  /** Stores the (cx,cz) delta payload. */
  saveChunkDelta(cx: number, cz: number, payload: Uint8Array): Promise<void>;
  /** Drops the (cx,cz) delta (used when a save turned out to be a no-op). */
  clearChunkDelta(cx: number, cz: number): Promise<void>;
  /** Removes all persisted state (e.g. "new world"). */
  clearAll(): Promise<void>;
  /** Best-effort durability flush (pagehide/visibilitychange, D3). Resolves when scheduled. */
  flush(): Promise<void>;
  /** Closes the backing storage (app teardown). */
  close(): Promise<void>;
}

/** Validates+decodes a raw payload; returns `null` for foreign-version or corrupt data. */
export function tryDecode(payload: Uint8Array): ChunkDeltaData | null {
  const decoded = decodeChunkDelta(payload);
  if (decoded === null || "foreign" in decoded) return null;
  return decoded;
}

/**
 * Node-testable in-memory driver (also the headless-gate/fallback backend). Not a product
 * durability target -- it deliberately mirrors the IndexedDB driver's partial-failure bias:
 * `saveChunkDelta` failing to decode-after-write is surfaced to the caller.
 */
export class MemoryChunkDeltaStore implements ChunkDeltaStore {
  private _seed: number | null = null;
  private readonly _deltas: Map<string, Uint8Array> = new Map();
  private _flushCount = 0;

  public async getSeed(): Promise<number | null> {
    return this._seed;
  }

  public async setSeed(seed: number): Promise<void> {
    this._seed = seed;
  }

  public async loadChunkDelta(cx: number, cz: number): Promise<Uint8Array | null> {
    return this._deltas.get(`${cx},${cz}`) ?? null;
  }

  public async saveChunkDelta(cx: number, cz: number, payload: Uint8Array): Promise<void> {
    this._deltas.set(`${cx},${cz}`, payload);
  }

  public async clearChunkDelta(cx: number, cz: number): Promise<void> {
    this._deltas.delete(`${cx},${cz}`);
  }

  public async clearAll(): Promise<void> {
    this._seed = null;
    this._deltas.clear();
  }

  public async flush(): Promise<void> {
    this._flushCount++;
  }

  public async close(): Promise<void> {
    // Nothing to release.
  }

  /** Test probe: number of `flush()` calls received. */
  public get flushCount(): number {
    return this._flushCount;
  }
}
