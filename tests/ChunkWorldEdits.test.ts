import { describe, expect, it } from "vitest";
import {
  BLOCK_AIR,
  BLOCK_DIRT,
  BLOCK_STONE,
  BLOCK_WATER,
  BlockRegistry,
} from "../src/voxel/BlockRegistry.js";
import { ChunkWorld } from "../src/voxel/ChunkWorld.js";
import type { ChunkWorldCallbacks } from "../src/voxel/ChunkWorld.js";
import { TerrainGenerator } from "../src/voxel/TerrainGenerator.js";
import { buildMesh, descriptorFromRegistry } from "../src/voxel/mesh/NaiveMesher.js";
import type { CornerDir, FaceDir, MeshBlockDescriptorEntry } from "../src/voxel/mesh/NaiveMesher.js";
import { ForegroundMeshClient } from "../src/voxel/worker/ForegroundMeshClient.js";
import type { MeshClient, MeshOutcome } from "../src/voxel/worker/MeshWorkerProtocol.js";

/**
 * M2 editing tests (dossier §4.2): setBlock semantics + the bounded 1-chunk remesh and the
 * "exactly ONE valid mesh wins" invariant across a worker boundary. Two harness flavours:
 *   - a synchronous foreground double for the remesh-SCOPE and block semantics tests;
 *   - a CONTROLLABLE client that COPIES the dispatch-time voxel snapshot (as the real worker
 *     receives via postMessage) and lands results only when `flush()` is called -- used to prove
 *     that a mesh in flight while an edit lands is DISCARDED, never staged onto the host.
 */

interface HostRecord {
  cx: number;
  cz: number;
  mesh: ReturnType<typeof buildMesh> | null;
  unloaded: boolean;
}

function harness(options: { seed?: number; radius?: number; client?: MeshClient } = {}): {
  world: ChunkWorld;
  hosts: Map<string, HostRecord>;
  unloads: string[];
  remeshlag: string[];
} {
  const registry = new BlockRegistry();
  BlockRegistry.seed(registry);
  const descriptor = descriptorFromRegistry(registry);
  const hosts = new Map<string, HostRecord>();
  const unloads: string[] = [];
  const remeshlag: string[] = [];
  const world = new ChunkWorld({
    client: options.client ?? new ForegroundMeshClient(),
    descriptor,
    seed: options.seed ?? 42,
    generateRadius: options.radius ?? 2,
    maxTasksPerTick: 64,
    callbacks: {
      onMeshReady: (cx, cz, mesh): void => {
        remeshlag.push(`${cx},${cz}`);
        hosts.set(`${cx},${cz}`, {
          cx,
          cz,
          mesh: mesh as ReturnType<typeof buildMesh>,
          unloaded: false,
        });
      },
      onUnload: (cx, cz): void => {
        const key = `${cx},${cz}`;
        hosts.delete(key);
        unloads.push(key);
      },
    } as ChunkWorldCallbacks,
  });
  return { world, hosts, unloads, remeshlag };
}

async function pump(world: ChunkWorld, ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    world.update();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** The topmost solid Y directly below a world (wx, wz) column -- the deterministic terrain cap. */
function groundY(world: ChunkWorld, wx: number, wz: number): number {
  for (let y = 15; y >= 0; y--) {
    if (world.getWorldBlock(wx, y, wz) !== BLOCK_AIR) return y;
  }
  return -1;
}

describe("ChunkWorld — setBlock semantics", () => {
  it("applies a break onto a loaded ready chunk and re-meshes it (remesh callback fires, world stays consistent)", async () => {
    const { world, hosts, remeshlag } = harness({ seed: 7, radius: 2 });
    world.setFocus(32, 32); // chunk (2, 2), ring 0
    await pump(world, 30);
    expect(hosts.size).toBe(9);

    const gx = 40;
    const gz = 40;
    const gy = groundY(world, gx, gz);
    expect(gy).toBeGreaterThanOrEqual(0);
    expect(world.getWorldBlock(gx, gy, gz)).not.toBe(BLOCK_AIR);

    const statsBefore = world.getStats();
    const remeshesBefore = remeshlag.length;
    expect(world.setBlock(gx, gy, gz, BLOCK_AIR)).toBe(true);
    expect(world.getWorldBlock(gx, gy, gz)).toBe(BLOCK_AIR); // edit is visible immediately
    expect(world.getStats().edits).toBe(statsBefore.edits + 1);

    await pump(world, 5);
    // The remesh ran (the edited chunk was re-dispatched and hosted again), and the column
    // still reads the edit -- the host swap never rolls data back.
    expect(remeshlag.length).toBe(remeshesBefore + 1);
    expect(hosts.size).toBe(9);
    expect(world.getWorldBlock(gx, gy, gz)).toBe(BLOCK_AIR);
    world.destroy();
  });

  it("schedules a BOUNDED remesh: an interior cell re-meshes only its own chunk", async () => {
    const { world, remeshlag } = harness({ seed: 11, radius: 2 });
    world.setFocus(32, 32);
    await pump(world, 30);
    const before = remeshlag.length;

    // Interior cell of the focus chunk (2,2) -- touches no neighbor rim plane.
    expect(world.setBlock(32 + 5, groundY(world, 37, 37), 32 + 5, BLOCK_STONE)).toBe(true);
    await pump(world, 5);
    expect(remeshlag.length - before).toBeLessThanOrEqual(1);
    world.destroy();
  });

  it("schedules a BOUNDED remesh: a border cell additionally re-meshes the rim-touching neighbor (max 5)", async () => {
    const { world, remeshlag } = harness({ seed: 11, radius: 2 });
    world.setFocus(32, 32);
    await pump(world, 30);
    const before = remeshlag.length;

    // Border cell at the +X edge of the focus chunk (2,2), z interior -> touches east chunk (3,2).
    const gz = 41;
    const gy = groundY(world, 32 + 15, gz);
    expect(world.setBlock(32 + 15, gy, gz, BLOCK_STONE)).toBe(true);
    await pump(world, 5);
    const delta = remeshlag.length - before;
    expect(delta).toBeGreaterThanOrEqual(2); // own + east neighbor
    expect(delta).toBeLessThanOrEqual(5); // dossier bound: never the 3x3 look
    world.destroy();
  });

  it("schedules the diagonal neighbor on a corner-cell edit so AO corner columns stay seam-exact (M4)", async () => {
    const { world, remeshlag } = harness({ seed: 11, radius: 2 });
    world.setFocus(32, 32); // chunk (2,2)
    await pump(world, 30);
    const before = remeshlag.length;

    // Corner cell (lx=0, lz=0) of chunk (2,2) -> touches (1,2), (2,1), and diagonal (1,1) = 4 chunks
    const gx = 32;
    const gz = 32;
    const gy = groundY(world, gx, gz);
    expect(world.setBlock(gx, gy, gz, BLOCK_STONE)).toBe(true);
    await pump(world, 5);
    const touched = remeshlag.slice(before);
    expect(touched).toEqual(expect.arrayContaining(["2,2", "1,2", "2,1", "1,1"]));
    expect(touched.length).toBe(4);
    world.destroy();
  });

  it("unloads hosted scene nodes even if evicted or destroyed while in 'data'/'meshing' after an edit (M2/M3)", async () => {
    const client = new ControllableMeshClient();
    const { world, hosts, unloads } = harness({ seed: 5, radius: 1, client });
    world.setFocus(8, 8); // chunk (0,0)
    await pump(world, 8);
    await client.flush();
    await pump(world, 2);
    expect(hosts.has("0,0")).toBe(true);

    // Edit puts chunk (0,0) back into "data" -> "meshing" (pending in ControllableMeshClient)
    const gy = groundY(world, 8, 8);
    expect(world.setBlock(8, gy, 8, BLOCK_AIR)).toBe(true);
    await pump(world, 1);

    // Evict chunk (0,0) while its remesh is still in flight -> must still call onUnload!
    world.setFocus(8 + 10 * 16, 8);
    await pump(world, 1);
    expect(unloads).toContain("0,0");
    expect(hosts.has("0,0")).toBe(false);
    world.destroy();
  });

  it("never meshes an unloaded column (no-op) and ignores out-of-band Y edits", async () => {
    const { world } = harness({ seed: 1, radius: 2 });
    world.setFocus(32, 32);
    await pump(world, 30);
    // Far outside the loaded window -> no record -> no-op.
    expect(world.setBlock(2000, 8, 2000, BLOCK_DIRT)).toBe(false);
    // Y=16 is above the 16-tall column -> no-op; Y=-1 below -> no-op.
    expect(world.setBlock(40, 16, 40, BLOCK_DIRT)).toBe(false);
    expect(world.setBlock(40, -1, 40, BLOCK_DIRT)).toBe(false);
    expect(world.getStats().edits).toBe(0);
    world.destroy();
  });

  it("marks a no-change edit as a no-op (returns false) and does not count it", async () => {
    const { world } = harness({ seed: 1, radius: 2 });
    world.setFocus(32, 32);
    await pump(world, 30);
    const gx = 40;
    const gz = 40;
    const gy = groundY(world, gx, gz);
    const id = world.getWorldBlock(gx, gy, gz);
    expect(world.setBlock(gx, gy, gz, id)).toBe(false);
    expect(world.getStats().edits).toBe(0);
    world.destroy();
  });

  it("water is not collidable: isSolidAt reads false for a placed water cell while getWorldBlock sees it", async () => {
    const { world } = harness({ seed: 3, radius: 2 });
    world.setFocus(32, 32);
    await pump(world, 30);
    const gx = 40;
    const gz = 40;
    const gy = groundY(world, gx, gz);
    expect(world.setBlock(gx, gy, gz, BLOCK_WATER)).toBe(true);
    expect(world.getWorldBlock(gx, gy, gz)).toBe(BLOCK_WATER);
    // The player sweep uses isSolidAt: water must NOT be solid (M2: fall through, no swimming).
    expect(world.isSolidAt(gx, gy, gz)).toBe(false);
    // The bed UNDER the water is still solid.
    if (gy - 1 >= 0) expect(world.isSolidAt(gx, gy - 1, gz)).toBe(true);
    world.destroy();
  });
});

/**
 * Models the REAL worker contract: `postMessage` hands the worker a structured-clone COPY at
 * dispatch time, so an in-flight mesh reflects the dispatch-time snapshot, never later
 * main-thread edits. Results land only when `flush()` resolves the queued tasks in FIFO order.
 */
class ControllableMeshClient implements MeshClient {
  private _generator: TerrainGenerator | null = null;
  private _descriptor: readonly MeshBlockDescriptorEntry[] = [];
  private readonly _pending: Array<{
    voxels: Uint8Array;
    neighbors: Partial<Record<FaceDir, Uint8Array>>;
    neighborCorners?: Partial<Record<CornerDir, Uint8Array>>;
    resolve: (outcome: MeshOutcome) => void;
  }> = [];

  public configure(seed: number, descriptor: readonly MeshBlockDescriptorEntry[]): void {
    this._generator = new TerrainGenerator({ seed });
    this._descriptor = descriptor;
  }

  public async generate(cx: number, cz: number): Promise<Uint8Array> {
    return this._generator!.generateColumn(cx, 0, cz);
  }

  public mesh(
    _cx: number,
    _cz: number,
    voxels: Uint8Array,
    neighbors: Partial<Record<FaceDir, Uint8Array>>,
    neighborCorners?: Partial<Record<CornerDir, Uint8Array>>,
  ): Promise<MeshOutcome> {
    return new Promise<MeshOutcome>((resolve) => {
      // Structured-clone semantics: snapshot the buffers at dispatch time. exactOptionalPropertyTypes
      // forbids assigning an explicit `undefined`, so only include the optional corner data when
      // it was actually provided.
      this._pending.push({
        voxels: new Uint8Array(voxels),
        neighbors,
        ...(neighborCorners === undefined ? {} : { neighborCorners }),
        resolve,
      });
    });
  }

  /** Resolves every pending mesh from its dispatch-time snapshot. Returns how many landed. */
  public async flush(): Promise<number> {
    const tasks = this._pending.splice(0);
    for (const task of tasks) {
      const mesh = buildMesh({
        voxels: task.voxels,
        descriptor: this._descriptor,
        neighbors: task.neighbors,
        neighborCorners: task.neighborCorners,
      });
      task.resolve({ mesh, meshMs: 0 });
    }
    await new Promise((r) => setTimeout(r, 0)); // let the resolution handlers run
    return tasks.length;
  }

  public destroy(): void {}
}

describe("ChunkWorld — exactly ONE valid mesh wins (M2 invariant)", () => {
  it("drops an in-flight mesh that became stale by a later edit, then remeshes with current data", async () => {
    const client = new ControllableMeshClient();
    const { world, hosts, remeshlag } = harness({ seed: 5, radius: 1, client });
    world.setFocus(8, 8); // chunk (0, 0)
    await pump(world, 8); // generate ring 0..1; meshes stay PENDING in the client
    expect(client.flush).toBeDefined();
    await client.flush(); // ring-0 (0,0) meshes with dispatch-time data -> ready
    await pump(world, 2);
    expect(hosts.has("0,0")).toBe(true);

    const readyMesh = hosts.get("0,0")!.mesh;
    const gx = 8;
    const gz = 8;
    const gy = groundY(world, gx, gz);
    const editsBefore = world.getStats().edits;

    // Edit 1: break a cell -> (0,0) goes ready->data; next tick dispatches a fresh mesh (PENDING).
    expect(world.setBlock(gx, gy, gz, BLOCK_AIR)).toBe(true);
    await pump(world, 2); // dispatches the second mesh, which stays in the client's queue
    const inFlightCount = 1;

    // Edit 2 while that mesh is IN FLIGHT: the snapshot of mesh #2 is now pre-edit data.
    expect(world.setBlock(gx + 1, gy, gz + 1, BLOCK_DIRT)).toBe(true);
    expect(world.getStats().edits).toBe(editsBefore + 2);

    const hostCallsBefore = remeshlag.length;
    const landed = await client.flush(); // mesh #2 resolves from its stale snapshot
    expect(landed).toBeGreaterThanOrEqual(inFlightCount);
    // Stale result must NOT reach the host: the phase guard (dirty) discards it.
    expect(remeshlag.length).toBe(hostCallsBefore);
    expect(hosts.get("0,0")!.mesh).toBe(readyMesh); // host still shows the pre-edit mesh

    // The streaming loop now remeshes with CURRENT (edited) data -- a THIRD dispatch.
    await pump(world, 4);
    await client.flush();
    await pump(world, 2);
    // Exactly one more host update, with a FRESH mesh object (never the stale one).
    expect(remeshlag.length).toBe(hostCallsBefore + 1);
    expect(hosts.get("0,0")!.mesh).not.toBe(readyMesh);
    // And the edited columns read the edits (the final mesh reflects true world data).
    expect(world.getWorldBlock(gx, gy, gz)).toBe(BLOCK_AIR);
    expect(world.getWorldBlock(gx + 1, gy, gz + 1)).toBe(BLOCK_DIRT);
    world.destroy();
  });
});
