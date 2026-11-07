import { Chunk } from "../Chunk.js";

const CHUNK_SIZE = Chunk.SIZE;

/**
 * M3 chunk-delta codec (dossier §4.2 M3: own compact, versioned delta store). Pure module -- no
 * I/O, no browser API -- so the byte format is node-testable and stable across store drivers.
 *
 * Format (V1, little-endian, deterministic byte order):
 *   byte  0        format version (1)
 *   bytes 1..4     world seed (uint32 LE, D3b: persisted so the exact same world rebuilds)
 *   bytes 5..8     entry count n (uint32 LE)
 *   then n × 4 B   x, y, z (each 0..15, one byte), block id (one byte)
 *
 * Entries are encoded in ascending (y, z, x) order so identical edit sets always produce
 * byte-identical payloads (determinism, tested). `x`/`z` are local cell coordinates, `y` the
 * column level (0..15) -- 4 bytes per edited cell stays in the KB range by construction (the
 * terrain itself is regenerated from the seed, never stored; D1).
 */
export const CHUNK_DELTA_VERSION = 1;
export const CHUNK_DELTA_HEADER_BYTES = 9;

/** A single edited cell in chunk-local coordinates. */
export interface ChunkDeltaEdit {
  x: number;
  y: number;
  z: number;
  id: number;
}

/** Successfully decoded payload (V1 applies cleanly to the current world seed/semantics). */
export interface ChunkDeltaData {
  version: 1;
  seed: number;
  edits: readonly ChunkDeltaEdit[];
}

/** The buffer carries a different (future/legacy) format -- caller decides to discard/ignore. */
export interface ChunkDeltaForeign {
  version: number;
  foreign: true;
}

export type ChunkDeltaDecoded = ChunkDeltaData | ChunkDeltaForeign | null;

function encodeU32LE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >> 8) & 0xff;
  out[offset + 2] = (value >> 16) & 0xff;
  out[offset + 3] = (value >> 24) & 0xff;
}

function decodeU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! +
      bytes[offset + 1]! * 256 +
      bytes[offset + 2]! * 65536 +
      bytes[offset + 3]! * 16777216) >>>
    0
  );
}

/**
 * Serializes a set of edited cells into the V1 delta payload. Duplicate (x,y,z) cells are
 * collapsed by keeping the LAST write for that cell (matches the world's own semantics: the
 * latest `setBlock` wins). The result is byte-deterministic for any given (seed, edit-set).
 */
export function encodeChunkDelta(
  seed: number,
  edits: readonly ChunkDeltaEdit[],
): Uint8Array {
  const byCell = new Map<string, ChunkDeltaEdit>();
  for (const edit of edits) {
    byCell.set(`${edit.x},${edit.y},${edit.z}`, edit);
  }
  const uniq = [...byCell.values()].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (a.z !== b.z) return a.z - b.z;
    return a.x - b.x;
  });

  const out = new Uint8Array(CHUNK_DELTA_HEADER_BYTES + uniq.length * 4);
  out[0] = CHUNK_DELTA_VERSION;
  encodeU32LE(out, 1, seed);
  encodeU32LE(out, 5, uniq.length);
  let o = CHUNK_DELTA_HEADER_BYTES;
  for (const edit of uniq) {
    out[o] = edit.x;
    out[o + 1] = edit.y;
    out[o + 2] = edit.z;
    out[o + 3] = edit.id;
    o += 4;
  }
  return out;
}

/**
 * Parses a delta payload. Returns `null` for a truncated/corrupt buffer, a `ChunkDeltaForeign`
 * for a valid header with a different format version (caller decides discard/ignore), and the
 * decoded `ChunkDeltaData` for a V1 buffer. Reads are bounds-checked -- a truncated payload
 * cannot produce garbage (fail fast, no silent partial application).
 */
export function decodeChunkDelta(bytes: Uint8Array): ChunkDeltaDecoded {
  if (bytes.length < CHUNK_DELTA_HEADER_BYTES) return null;
  const version = bytes[0]!;
  if (version !== CHUNK_DELTA_VERSION) return { version, foreign: true };
  const seed = decodeU32LE(bytes, 1);
  const count = decodeU32LE(bytes, 5);
  if (bytes.length !== CHUNK_DELTA_HEADER_BYTES + count * 4) return null;
  const edits: ChunkDeltaEdit[] = [];
  for (let i = 0; i < count; i++) {
    const o = CHUNK_DELTA_HEADER_BYTES + i * 4;
    const x = bytes[o]!;
    const y = bytes[o + 1]!;
    const z = bytes[o + 2]!;
    const id = bytes[o + 3]!;
    if (x >= CHUNK_SIZE || y >= CHUNK_SIZE || z >= CHUNK_SIZE) return null;
    edits.push({ x, y, z, id });
  }
  return { version: 1, seed, edits };
}
