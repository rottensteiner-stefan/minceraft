import { BLOCK_AIR } from "./BlockRegistry.js";

/**
 * A `Chunk` is pure voxel DATA -- no render state, no mesh, no physics. It mirrors the
 * Noa/Minceraft-section pattern from the voxel dossier (`.agents/collaborate/minceraft/`):
 * a dense, fixed-size 3D grid of block-state ids plus a `dirty` marker so a future
 * `ChunkWorld` (M1) knows which chunks a mesh rebuild must touch.
 *
 * M0 scope: ONE static chunk, built by hand, meshed by `NaiveMesher` on the main thread.
 * The reader/writer API (`getBlock`/`setBlock`) is the contract every later milestone
 * builds on (terrain gen, player collision sweep, block editing all talk to this).
 */
export class Chunk {
  public static readonly SIZE: number = 16;

  /** Block ids, indexed `[x + z*SIZE + y*SIZE*SIZE]` -- x fastest (dossier §2.2). */
  public readonly voxels: Uint8Array;

  /** Set when any voxel changed; a mesher host may clear it after a rebuild (M1). */
  public dirty: boolean = false;

  constructor() {
    this.voxels = new Uint8Array(Chunk.SIZE * Chunk.SIZE * Chunk.SIZE);
  }

  /** Linear index for local coordinates. No bounds check -- callers stay in range. */
  public indexOf(x: number, y: number, z: number): number {
    return x + z * Chunk.SIZE + y * Chunk.SIZE * Chunk.SIZE;
  }

  /**
   * Returns the block id at a local position. Out-of-bounds requests read as `BLOCK_AIR`,
   * which is exactly what the naive mesher needs for faces on the chunk border (they are
   * exposed and therefore meshed). M1 replaces this single-chunk behaviour with a
   * neighbor-aware lookup so border seams are culled like interior faces.
   */
  public getBlock(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= Chunk.SIZE || y >= Chunk.SIZE || z >= Chunk.SIZE) {
      return BLOCK_AIR;
    }
    return this.voxels[this.indexOf(x, y, z)]!;
  }

  /** Sets a block id at a local position and flags the chunk dirty. */
  public setBlock(x: number, y: number, z: number, id: number): void {
    if (x < 0 || y < 0 || z < 0 || x >= Chunk.SIZE || y >= Chunk.SIZE || z >= Chunk.SIZE) {
      return;
    }
    const index = this.indexOf(x, y, z);
    if (this.voxels[index] !== id) {
      this.voxels[index] = id;
      this.dirty = true;
    }
  }

  /** Fills the entire chunk with one block id. Marks dirty when anything changed. */
  public fill(id: number): void {
    let changed = false;
    for (let i = 0; i < this.voxels.length; i++) {
      if (this.voxels[i] !== id) {
        this.voxels[i] = id;
        changed = true;
      }
    }
    if (changed) this.dirty = true;
  }
}
