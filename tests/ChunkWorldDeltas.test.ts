import { describe, expect, it } from "vitest";
import { BLOCK_AIR, BLOCK_DIRT, BLOCK_STONE, BlockRegistry } from "../src/voxel/BlockRegistry.js";
import { ChunkWorld } from "../src/voxel/ChunkWorld.js";
import type { ChunkWorldCallbacks } from "../src/voxel/ChunkWorld.js";
import { descriptorFromRegistry } from "../src/voxel/mesh/NaiveMesher.js";
import type { ChunkDeltaStore } from "../src/voxel/store/ChunkDeltaStore.js";
import { MemoryChunkDeltaStore, tryDecode } from "../src/voxel/store/ChunkDeltaStore.js";
import { encodeChunkDelta } from "../src/voxel/store/ChunkDeltaCodec.js";
import { ForegroundMeshClient } from "../src/voxel/worker/ForegroundMeshClient.js";

/**
 * Controllable store: `loadChunkDelta` for a held chunk BLOCKS until `release()` is called --
 * letting a test deterministically interleave a live edit with a load in flight. The SAVE path
 * writes straight through (a real driver's `put` is unaffected by read gates).
 */
class GatedStore implements ChunkDeltaStore {
  private readonly _held = new Map<string, Uint8Array>();
  private _gate: Promise<void> | null = null;
  private _openGate: (() => void) | null = null;
  private _seed: number | null = null;

  public hold(cx: number, cz: number, payload: Uint8Array): void {
    this._held.set(`${cx},${cz}`, payload);
  }

  public release(): void {
    this._openGate?.();
    this._gate = null;
    this._openGate = null;
  }

  public async getSeed(): Promise<number | null> {
    return this._seed;
  }

  public async setSeed(seed: number): Promise<void> {
    this._seed = seed;
  }

  public async loadChunkDelta(cx: number, cz: number): Promise<Uint8Array | null> {
    const key = `${cx},${cz}`;
    if (!this._held.has(key)) return null;
    if (!this._gate) {
      let open!: () => void;
      this._gate = new Promise<void>((r) => {
        open = r;
      });
      this._openGate = open;
    }
    await this._gate;
    return this._held.get(key) ?? null;
  }

  public async saveChunkDelta(cx: number, cz: number, payload: Uint8Array): Promise<void> {
    this._held.set(`${cx},${cz}`, payload);
  }

  public async clearChunkDelta(cx: number, cz: number): Promise<void> {
    this._held.delete(`${cx},${cz}`);
  }

  public async clearAll(): Promise<void> {
    this._held.clear();
    this._seed = null;
  }

  public async flush(): Promise<void> {}

  public async close(): Promise<void> {}
}

/**
 * M3 persistence (dossier §4.2 M3, D1/D3/D3b): ChunkWorld edit-delta round trips. The world
 * persists ONLY edited cells (x,y,z,id) -- the terrain itself is regenerated from the seed -- so
 * a "relaunch" rebuilds the exact same world byte-for-byte. These tests drive the REAL
 * `ChunkWorld` against the memory driver (the pure stand-in for the IndexedDB driver, which is
 * exercised in the browser gate).
 *
 * Cells at y=14 are hard-guaranteed AIR in generated terrain (heights clamp to [3,13]), so a
 * stored edit there is unambiguous proof that the delta was (re)applied.
 */

interface DeltaView {
  seed: number;
  edits: readonly { x: number; y: number; z: number; id: number }[];
}

async function viewDelta(
  store: ChunkDeltaStore,
  cx: number,
  cz: number,
): Promise<DeltaView | null> {
  const payload = await store.loadChunkDelta(cx, cz);
  if (payload === null) return null;
  const data = tryDecode(payload);
  if (data === null) return null;
  return { seed: data.seed, edits: data.edits };
}

function harness(store: ChunkDeltaStore, seed = 7): ChunkWorld {
  const registry = new BlockRegistry();
  BlockRegistry.seed(registry);
  const world = new ChunkWorld({
    client: new ForegroundMeshClient(),
    descriptor: descriptorFromRegistry(registry),
    seed,
    store,
    generateRadius: 2,
    maxTasksPerTick: 64,
    callbacks: {
      onMeshReady: (): void => {},
      onUnload: (): void => {},
    } as ChunkWorldCallbacks,
  });
  return world;
}

async function pump(world: ChunkWorld, ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    world.update();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("ChunkWorld — persistence (M3)", () => {
  it("persists edited cells + seed on eviction, and never stores untouched chunks", async () => {
    const store = new MemoryChunkDeltaStore();
    const world = harness(store, 7);
    world.setFocus(32, 32); // chunk (2, 2)
    await pump(world, 20);
    expect(world.getStats().generated).toBeGreaterThan(0);

    // Find the surface and place a stone block.
    const gx = 40;
    const gz = 40;
    let gy = -1;
    for (let y = 15; y >= 0; y--) {
      if (world.getWorldBlock(gx, y, gz) !== BLOCK_AIR) {
        gy = y;
        break;
      }
    }
    expect(gy).toBeGreaterThanOrEqual(0);
    expect(world.setBlock(gx, gy, gz, BLOCK_STONE)).toBe(true);
    expect(world.getWorldBlock(gx, gy, gz)).toBe(BLOCK_STONE);

    // Displace the focus far: chunk (2,2) is > unloadRadius(4) away -> evicted, delta saved.
    world.setFocus(32 + 8 * 16, 32); // chunk (10, 2): chebyshev distance 8
    await pump(world, 2);

    expect(await store.getSeed()).toBe(7); // D3b: seed persisted on first edit
    const delta = await viewDelta(store, 2, 2);
    expect(delta).not.toBeNull();
    expect(delta!.edits).toContainEqual({ x: gx % 16, y: gy, z: gz % 16, id: BLOCK_STONE });
    // A loaded-but-never-edited chunk writes nothing (D1: only deviating cells are stored).
    const untouched = await store.loadChunkDelta(1, 1);
    expect(untouched).toBeNull();
    world.destroy();
  });

  it("reapplies a stored delta onto regenerated terrain after a relaunch", async () => {
    const store = new MemoryChunkDeltaStore();
    await store.setSeed(7);
    // A "previous session" edited the air cell (8,14,8) of chunk (2,2) into dirt.
    await store.saveChunkDelta(2, 2, encodeChunkDelta(7, [{ x: 8, y: 14, z: 8, id: BLOCK_DIRT }]));

    // "Relaunch": a fresh world with the same seed + store regenerates the terrain, then the
    // delta is reapplied on top -- so the world cell reads the edit again.
    const world = harness(store, 7);
    world.setFocus(32, 32);
    await pump(world, 20);
    expect(world.getWorldBlock(40, 14, 40)).toBe(BLOCK_DIRT); // 40 = 2*16 + 8
    world.destroy();
  });

  it("persists the LATEST id when a cell is edited twice before eviction (last-write-wins)", async () => {
    const store = new MemoryChunkDeltaStore();
    const world = harness(store, 3);
    world.setFocus(32, 32);
    await pump(world, 20);
    const gx = 40;
    const gz = 40;
    expect(world.setBlock(gx, 14, gz, BLOCK_DIRT)).toBe(true);
    expect(world.setBlock(gx, 14, gz, BLOCK_STONE)).toBe(true); // newer write

    world.setFocus(32 + 8 * 16, 32);
    await pump(world, 2);
    const delta = await viewDelta(store, 2, 2);
    expect(delta!.edits).toContainEqual({ x: 8, y: 14, z: 8, id: BLOCK_STONE });
    expect(delta!.edits.filter((e) => e.x === 8 && e.y === 14 && e.z === 8)).toHaveLength(1);
    world.destroy();
  });

  it("writes nothing (no seed, no deltas) when nothing is edited", async () => {
    const store = new MemoryChunkDeltaStore();
    const world = harness(store, 7);
    world.setFocus(32, 32);
    await pump(world, 20);
    expect(world.getStats().edits).toBe(0);
    world.setFocus(32 + 8 * 16, 32); // evict every generated chunk
    await pump(world, 2);
    expect(await store.getSeed()).toBeNull(); // seed persist is lazy -- no edits -> no write
    expect(await store.loadChunkDelta(2, 2)).toBeNull();
    world.destroy();
  });

  it("persistAll() durably persists the loaded world without eviction (flush path)", async () => {
    const store = new MemoryChunkDeltaStore();
    const world = harness(store, 7);
    world.setFocus(32, 32);
    await pump(world, 20);
    expect(world.setBlock(40, 14, 40, BLOCK_STONE)).toBe(true);

    await world.persistAll();
    expect(await store.getSeed()).toBe(7);
    const delta = await viewDelta(store, 2, 2);
    expect(delta!.edits).toContainEqual({ x: 8, y: 14, z: 8, id: BLOCK_STONE });
    // The persisted payload round-trips: a fresh world on the same store sees the edit.
    const relaunch = harness(store, 7);
    relaunch.setFocus(32, 32);
    await pump(relaunch, 20);
    expect(relaunch.getWorldBlock(40, 14, 40)).toBe(BLOCK_STONE);
    relaunch.destroy();
    world.destroy();
  });

  it("never lets older stored data clobber a NEWER live edit made while a load is in flight", async () => {
    const store = new GatedStore();
    await store.setSeed(7);
    // Stored ("older") session data: cell (8,14,8) of chunk (2,2) was edited into DIRT.
    store.hold(2, 2, encodeChunkDelta(7, [{ x: 8, y: 14, z: 8, id: BLOCK_DIRT }]));

    const world = harness(store, 7);
    world.setFocus(32, 32);
    world.update(); // dispatch generate for chunk (2,2)
    await new Promise((r) => setTimeout(r, 0)); // let _onData reach the gated store read

    // The chunk's voxels exist but the stored delta is still "loading" -> a live edit lands now
    // and MUST win over the older payload when the read finally resolves.
    expect(world.setBlock(40, 14, 40, BLOCK_STONE)).toBe(true);
    store.release();
    await pump(world, 10);

    expect(world.getWorldBlock(40, 14, 40)).toBe(BLOCK_STONE);
    world.destroy();
  });

  it("discards stored deltas whose seed does not match the current world seed (M7)", async () => {
    const store = new MemoryChunkDeltaStore();
    await store.setSeed(999);
    await store.saveChunkDelta(
      2,
      2,
      encodeChunkDelta(999, [{ x: 8, y: 14, z: 8, id: BLOCK_STONE }]),
    );

    const world = harness(store, 7);
    world.setFocus(32, 32);
    await pump(world, 20);
    // Foreign-seed delta at (8,14,8) must not be applied to seed-7 terrain
    expect(world.getWorldBlock(40, 14, 40)).toBe(BLOCK_AIR);
    world.destroy();
  });

  it("persists pending deltas and unloads hosted mesh when a worker mesh task fails in _onError (M2)", async () => {
    const store = new MemoryChunkDeltaStore();
    const baseClient = new ForegroundMeshClient();
    let failNextMesh = false;
    const unloads: string[] = [];
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const world = new ChunkWorld({
      client: {
        configure: (s, d): void => baseClient.configure(s, d),
        generate: (cx, cz): Promise<Uint8Array> => baseClient.generate(cx, cz),
        mesh: (
          cx,
          cz,
          v,
          n,
          c,
        ): Promise<import("../src/voxel/worker/MeshWorkerProtocol.js").MeshOutcome> =>
          failNextMesh
            ? Promise.reject(new Error("simulated worker mesh error"))
            : baseClient.mesh(cx, cz, v, n, c),
        destroy: (): void => baseClient.destroy(),
      },
      descriptor: descriptorFromRegistry(registry),
      seed: 7,
      store,
      generateRadius: 1,
      maxTasksPerTick: 64,
      callbacks: {
        onMeshReady: (): void => {},
        onUnload: (cx, cz): void => {
          unloads.push(`${cx},${cz}`);
        },
      },
    });

    world.setFocus(8, 8); // chunk (0,0)
    await pump(world, 15);
    expect(world.hasChunkDataAt(8, 8)).toBe(true);

    // Edit chunk (0,0), but make the remesh fail
    failNextMesh = true;
    expect(world.setBlock(8, 14, 8, BLOCK_STONE)).toBe(true);
    await pump(world, 3);
    await world.flushStore();

    // _onError unloaded the hosted node AND saved the edit delta to the store
    expect(unloads).toContain("0,0");
    const delta = await viewDelta(store, 0, 0);
    expect(delta).not.toBeNull();
    expect(delta!.edits).toContainEqual({ x: 8, y: 14, z: 8, id: BLOCK_STONE });
    world.destroy();
  });
});
