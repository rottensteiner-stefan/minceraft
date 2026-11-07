import { describe, expect, it, vi } from "vitest";
import type { VoxelMeshData, MeshBlockDescriptorEntry } from "../src/voxel/mesh/NaiveMesher.js";
import type { MeshWorkerRequest, MeshWorkerResponse } from "../src/voxel/worker/MeshWorkerProtocol.js";
import { MeshWorkerPoolClient } from "../src/voxel/worker/MeshWorkerPoolClient.js";

/**
 * M7 pool transport tests (dossier §5 S2 hardening): deterministic node tests of the pool's
 * routing/error logic via an INJECTED fake-worker factory -- node has no `Worker`, and the fake
 * answers exactly like `mesh.worker.ts` (init is a no-op, generate/mesh answer with the request
 * id). Every test proves a transport-level contract (distribution, id uniqueness, crash
 * replacement, teardown); the pure meshing truth is covered by the shared-worker tests elsewhere.
 */

/** Scripted stand-in for one `mesh.worker.ts` -- answers with arena-encoding payloads. */
class FakeWorker {
  public onmessage: ((ev: { data: MeshWorkerResponse }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public readonly received: MeshWorkerRequest[] = [];
  public readonly index: number;
  public terminated: boolean = false;
  /** When set, the next non-init response fires `onerror` (simulated worker crash) instead. */
  public crashNext: boolean = false;

  constructor(index: number) {
    this.index = index;
  }

  public postMessage(message: MeshWorkerRequest): void {
    this.received.push(message);
    if (message.kind === "init") return;
    const id = message.id;
    queueMicrotask((): void => {
      if (this.crashNext) {
        this.crashNext = false;
        this.onerror?.({ message: "boom" });
        return;
      }
      if (message.kind === "generate") {
        // First byte encodes the answering arena, second the (mod-256) task id -- resolves only
        // against the arena that received the request, proving response routing per arena.
        this.onmessage?.({
          data: { kind: "data", id, voxels: new Uint8Array([this.index, id & 0xff]) },
        });
      } else {
        this.onmessage?.({
          data: {
            kind: "mesh-result",
            id,
            outcome: { mesh: fakeMesh(this.index), meshMs: this.index + 1 },
          },
        });
      }
    });
  }

  public terminate(): void {
    this.terminated = true;
  }
}

function fakeMesh(arenaIndex: number): VoxelMeshData {
  return {
    positions: new Float32Array([arenaIndex, 0, 0]),
    normals: new Float32Array([0, 1, 0]),
    uvs: new Float32Array([0, 0]),
    colors: new Float32Array([arenaIndex, 1, 1, 1]),
    indices: new Uint16Array([0]),
    triangleCount: 0,
  };
}

const DESCRIPTOR: readonly MeshBlockDescriptorEntry[] = [
  { id: 1, opaque: true, collidable: true, layers: [0, 0, 0] },
];

function makePool(
  workerCount: number,
  fakes: FakeWorker[],
): { client: MeshWorkerPoolClient; spawned: () => number } {
  const created: FakeWorker[] = [];
  let arenaIndex = 0;
  const client = new MeshWorkerPoolClient({
    workerCount,
    createWorker: (): FakeWorker => {
      const fake = new FakeWorker(arenaIndex++);
      created.push(fake);
      fakes.push(fake);
      return fake;
    },
  });
  return {
    client,
    spawned: (): number => created.length,
  };
}

function countsPerArena(fakes: FakeWorker[]): number[] {
  return fakes.map((f) => f.received.filter((m) => m.kind !== "init").length);
}

function receivedIds(fakes: FakeWorker[]): number[] {
  const ids: number[] = [];
  for (const fake of fakes) {
    for (const msg of fake.received) {
      if (msg.kind !== "init") ids.push(msg.id);
    }
  }
  return ids;
}

describe("MeshWorkerPoolClient (M7 transport)", () => {
  it("configures every arena before any task (init reaches all workers)", () => {
    const fakes: FakeWorker[] = [];
    const { client } = makePool(3, fakes);
    client.configure(777, DESCRIPTOR);
    expect(client.workerCount).toBe(3);
    for (const fake of fakes) {
      expect(fake.received[0]).toEqual({ kind: "init", seed: 777, descriptor: DESCRIPTOR });
    }
    client.destroy();
  });

  it("routes generate tasks round-robin and resolves with the OWNING arena's payload", async () => {
    const fakes: FakeWorker[] = [];
    const { client } = makePool(3, fakes);
    client.configure(777, DESCRIPTOR);

    const results = await Promise.all([
      client.generate(0, 0),
      client.generate(1, 0),
      client.generate(0, 1),
      client.generate(1, 1),
      client.generate(0, 2),
    ]);

    // Distribution over 3 arenas for 5 tasks: [2, 2, 1] (round-robin).
    expect(countsPerArena(fakes)).toEqual([2, 2, 1]);
    // Every result came from the arena that received the request (payload byte 0 == arena index).
    const expectedArenas = [0, 1, 2, 0, 1];
    for (let i = 0; i < results.length; i++) {
      expect(results[i]![0]).toBe(expectedArenas[i]);
    }
    // Task ids are globally unique across the whole pool.
    const ids = receivedIds(fakes);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);
    client.destroy();
  });

  it("routes mesh tasks round-robin and resolves with the MeshOutcome of the owning arena", async () => {
    const fakes: FakeWorker[] = [];
    const { client } = makePool(2, fakes);
    client.configure(777, DESCRIPTOR);

    const voxels = new Uint8Array(16);
    const [a, b, c] = await Promise.all([
      client.mesh(0, 0, voxels, {}),
      client.mesh(1, 0, voxels, {}),
      client.mesh(0, 1, voxels, {}),
    ]);
    expect([a!.meshMs, b!.meshMs, c!.meshMs]).toEqual([1, 2, 1]); // arena index + 1
    expect(countsPerArena(fakes)).toEqual([2, 1]);
    client.destroy();
  });

  it("keeps task ids independent between separate pool instances", async () => {
    const fakesA: FakeWorker[] = [];
    const fakesB: FakeWorker[] = [];
    const { client: a } = makePool(1, fakesA);
    const { client: b } = makePool(1, fakesB);
    a.configure(1, DESCRIPTOR);
    b.configure(2, DESCRIPTOR);
    await Promise.all([a.generate(0, 0), b.generate(0, 0)]);
    // Both pools started their id space at 1 -- no cross-instance coupling.
    expect(receivedIds(fakesA)).toEqual([1]);
    expect(receivedIds(fakesB)).toEqual([1]);
    a.destroy();
    b.destroy();
  });

  it("a crashing arena rejects only in-flight tasks and is replaced with a re-configured worker", async () => {
    const fakes: FakeWorker[] = [];
    const { client, spawned } = makePool(2, fakes);
    client.configure(777, DESCRIPTOR);

    // Third-dispatched task lands on arena 1 (round-robin 0,1,0,1,...). Crash it on its first task.
    fakes[1]!.crashNext = true;
    const p1 = client.mesh(0, 0, new Uint8Array(8), {});
    const p2 = client.mesh(1, 0, new Uint8Array(8), {});
    const p3 = client.mesh(0, 1, new Uint8Array(8), {});

    await expect(p2).rejects.toThrow("mesh worker crashed");
    // Arenas 0 and 2's tasks survive and resolve through their own arenas.
    expect((await p1).meshMs).toBe(1);
    expect((await p3).meshMs).toBe(1);
    // A replacement worker was spawned (3 spawned total) and re-configured with the world state.
    expect(spawned()).toBe(3);
    expect(client.workerCount).toBe(2); // pool size preserved
    const replacement = fakes[2]!;
    expect(replacement.terminated).toBe(false);
    expect(replacement.received[0]).toEqual({ kind: "init", seed: 777, descriptor: DESCRIPTOR });

    // A subsequent task routes to the replacement and resolves through it.
    const p4 = await client.mesh(1, 1, new Uint8Array(8), {});
    expect(p4.meshMs).toBe(replacement.index + 1);
    client.destroy();
  });

  it("stops respawning an arena that keeps crashing and retires it", async () => {
    const fakes: FakeWorker[] = [];
    const { client, spawned } = makePool(1, fakes);
    const errors = vi.spyOn(console, "error").mockImplementation((): void => undefined);
    try {
      client.configure(1, DESCRIPTOR);
      // Every worker the pool ever creates crashes on its first task and never answers.
      fakes[0]!.crashNext = true;
      let crashes = 0;
      for (let i = 0; i < 10 && client.workerCount > 0; i++) {
        const last = fakes[fakes.length - 1]!;
        last.crashNext = true;
        await expect(client.generate(i, 0)).rejects.toThrow("mesh worker crashed");
        crashes++;
      }
      expect(client.workerCount).toBe(0); // retired, not respawned forever
      expect(spawned()).toBeLessThanOrEqual(4); // initial + at most 3 replacements
      expect(crashes).toBe(4);
      expect(errors).toHaveBeenCalledOnce();
      expect(() => client.generate(0, 0)).toThrow("no worker arenas");
      for (const fake of fakes) expect(fake.terminated).toBe(true);
    } finally {
      errors.mockRestore();
      client.destroy();
    }
  });

  it("a successful response resets the crash streak (an occasionally crashing worker stays)", async () => {
    const fakes: FakeWorker[] = [];
    const { client } = makePool(1, fakes);
    client.configure(1, DESCRIPTOR);
    for (let round = 0; round < 6; round++) {
      fakes[fakes.length - 1]!.crashNext = true;
      await expect(client.generate(round, 0)).rejects.toThrow("mesh worker crashed");
      await client.generate(round, 1); // the replacement answers fine -> streak resets
    }
    expect(client.workerCount).toBe(1);
    client.destroy();
  });

  it("a late onerror after destroy() does not spawn a new worker", async () => {
    const fakes: FakeWorker[] = [];
    const { client, spawned } = makePool(1, fakes);
    client.configure(1, DESCRIPTOR);
    const before = spawned();
    const stale = fakes[0]!;
    client.destroy();
    stale.onerror?.({ message: "late" });
    expect(spawned()).toBe(before);
    expect(client.workerCount).toBe(0);
  });

  it("a throwing postMessage rejects the task and leaves nothing pending", async () => {
    const fakes: FakeWorker[] = [];
    const { client } = makePool(1, fakes);
    client.configure(1, DESCRIPTOR);
    const fake = fakes[0]!;
    const original = fake.postMessage.bind(fake);
    fake.postMessage = (): void => {
      throw new Error("DataCloneError");
    };
    await expect(client.generate(0, 0)).rejects.toThrow("DataCloneError");
    fake.postMessage = original;
    const arenas = (client as unknown as { _arenas: { pending: Map<number, unknown> }[] })._arenas;
    expect(arenas[0]!.pending.size).toBe(0); // the failed task left no dangling entry
    client.destroy();
  });

  it("destroy rejects in-flight tasks and terminates every arena", async () => {
    const fakes: FakeWorker[] = [];
    const { client } = makePool(2, fakes);
    client.configure(777, DESCRIPTOR);

    const p1 = client.generate(0, 0);
    const p2 = client.generate(1, 0);
    client.destroy();
    await expect(p1).rejects.toThrow("mesh worker pool destroyed");
    await expect(p2).rejects.toThrow("mesh worker pool destroyed");
    for (const fake of fakes) expect(fake.terminated).toBe(true);
    expect(client.workerCount).toBe(0);
  });

  it("clamps the requested arena count to at least one worker", () => {
    const fakes: FakeWorker[] = [];
    const { client } = makePool(0, fakes);
    expect(client.workerCount).toBe(1);
    expect(fakes.length).toBe(1);
    client.destroy();
  });
});
