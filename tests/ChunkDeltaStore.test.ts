import { describe, expect, it } from "vitest";
import {
  CHUNK_DELTA_HEADER_BYTES,
  CHUNK_DELTA_VERSION,
  decodeChunkDelta,
  encodeChunkDelta,
} from "../src/voxel/store/ChunkDeltaCodec.js";
import type { ChunkDeltaEdit } from "../src/voxel/store/ChunkDeltaCodec.js";
import { MemoryChunkDeltaStore, tryDecode } from "../src/voxel/store/ChunkDeltaStore.js";

/**
 * M3 persistence (dossier §4.2 M3, decisions D1–D5): the pure delta codec -- only edited cells
 * are stored, the format is versioned, deterministic and node-testable, and foreign/corrupt
 * payloads are ignored instead of failing the world. Plus the memory driver's contract (the
 * index-level read/write/clear/flush semantics that the IndexedDB driver must mirror in the
 * browser gate).
 */

const EDITS: readonly ChunkDeltaEdit[] = [
  { x: 3, y: 4, z: 5, id: 2 },
  { x: 1, y: 1, z: 1, id: 3 },
  { x: 15, y: 0, z: 15, id: 5 },
];

describe("ChunkDeltaCodec — roundtrip & determinism", () => {
  it("roundtrips an edit set (seed + cells) byte-identically", () => {
    const payload = encodeChunkDelta(777, EDITS);
    const decoded = decodeChunkDelta(payload);
    expect(decoded).not.toBeNull();
    if (!decoded || "foreign" in decoded) throw new Error("expected V1 data");
    expect(decoded.version).toBe(CHUNK_DELTA_VERSION);
    expect(decoded.seed).toBe(777);
    // Encoder orders deterministically by (y, z, x) -- pin that, not an input-order assumption.
    expect(decoded.edits).toEqual(
      [...EDITS].sort((a, b) => {
        if (a.y !== b.y) return a.y - b.y;
        if (a.z !== b.z) return a.z - b.z;
        return a.x - b.x;
      }),
    );
  });

  it("is byte-deterministic: the same (seed, edit-set) always encodes identically", () => {
    const a = encodeChunkDelta(42, EDITS);
    const b = encodeChunkDelta(42, EDITS);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // A different seed changes the byte layout (seed lives in the header).
    const c = encodeChunkDelta(43, EDITS);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it("collapses duplicates by LAST-write-wins and orders deterministically", () => {
    const payload = encodeChunkDelta(1, [
      { x: 0, y: 2, z: 0, id: 2 },
      { x: 0, y: 2, z: 0, id: 9 }, // later write wins
      { x: 0, y: 3, z: 0, id: 4 },
    ]);
    const decoded = decodeChunkDelta(payload);
    if (!decoded || "foreign" in decoded) throw new Error("expected V1 data");
    expect(decoded.edits).toHaveLength(2);
    expect(decoded.edits.find((e) => e.y === 2 && e.z === 0)?.id).toBe(9);
  });

  it("stays in the KB range for a full worst-case chunk (4096 cells ≈ 16 KB payload)", () => {
    const full: ChunkDeltaEdit[] = [];
    for (let y = 0; y < 16; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) full.push({ x, y, z, id: (x + y + z) % 6 });
      }
    }
    const payload = encodeChunkDelta(1, full);
    expect(payload.length).toBe(CHUNK_DELTA_HEADER_BYTES + 4096 * 4);
    expect(payload.length).toBeLessThanOrEqual(64 * 1024); // comfortably KB-ish, well below 1 MB
  });
});

describe("ChunkDeltaCodec — version & corruption handling", () => {
  it("reports foreign versions instead of failing (caller decides discard/ignore)", () => {
    // A hypothetical V99 header: version byte 99 + 8 bytes of meta + a few entries.
    const foreign = new Uint8Array(CHUNK_DELTA_HEADER_BYTES);
    foreign[0] = 99;
    foreign.set([9, 9, 9, 9], 1);
    expect(decodeChunkDelta(foreign)).toEqual({ version: 99, foreign: true });
  });

  it("returns null for truncated/corrupt payloads (fail fast)", () => {
    expect(decodeChunkDelta(new Uint8Array(0))).toBeNull();
    // A 6-byte buffer is below the 9-byte header -> truncated.
    expect(decodeChunkDelta(new Uint8Array([CHUNK_DELTA_VERSION, 0, 0, 0, 0, 1]))).toBeNull();
    // Header claims 1 entry but the buffer is too short -> corrupt.
    const truncated = new Uint8Array(CHUNK_DELTA_HEADER_BYTES + 2);
    truncated[0] = CHUNK_DELTA_VERSION;
    expect(decodeChunkDelta(truncated)).toBeNull(); // count 0 encoded, but 2 extra bytes != 0 cells
    // A valid V1 buffer with an out-of-range local coordinate (200 >= 16) is rejected.
    const patched = new Uint8Array(encodeChunkDelta(1, [{ x: 0, y: 0, z: 0, id: 1 }]));
    patched[CHUNK_DELTA_HEADER_BYTES] = 200;
    expect(decodeChunkDelta(patched)).toBeNull();
  });
});

describe("MemoryChunkDeltaStore — contract", () => {
  it("stores/loads a seed and a chunk delta; no row reads as null", async () => {
    const store = new MemoryChunkDeltaStore();
    expect(await store.getSeed()).toBeNull();
    await store.setSeed(777);
    expect(await store.getSeed()).toBe(777);
    expect(await store.loadChunkDelta(3, 4)).toBeNull();
    const payload = encodeChunkDelta(777, [{ x: 0, y: 0, z: 0, id: 2 }]);
    await store.saveChunkDelta(3, 4, payload);
    expect(await store.loadChunkDelta(3, 4)).toEqual(payload);
  });

  it("clearChunkDelta and clearAll remove state; flush is a no-op durability barrier", async () => {
    const store = new MemoryChunkDeltaStore();
    await store.setSeed(1);
    await store.saveChunkDelta(1, 1, encodeChunkDelta(1, EDITS));
    const f0 = store.flushCount;
    await store.flush();
    expect(store.flushCount).toBe(f0 + 1);
    await store.clearChunkDelta(1, 1);
    expect(await store.loadChunkDelta(1, 1)).toBeNull();
    await store.clearAll();
    expect(await store.getSeed()).toBeNull();
  });

  it("tryDecode surfaces V1 data and hides foreign/corrupt payloads", async () => {
    const good = encodeChunkDelta(777, EDITS);
    expect(tryDecode(good)?.seed).toBe(777);
    expect(tryDecode(new Uint8Array([99, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(tryDecode(new Uint8Array(2))).toBeNull();
  });
});
