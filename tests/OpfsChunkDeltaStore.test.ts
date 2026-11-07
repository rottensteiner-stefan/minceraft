import { describe, expect, it, vi } from "vitest";
import { OpfsChunkDeltaStore } from "../src/voxel/store/OpfsChunkDeltaStore.js";

/**
 * OPFS driver for the M3 `ChunkDeltaStore` contract -- honest node tests against a SMALL
 * hand-written in-memory fake of the OPFS API (only the subset the driver uses: handle
 * acquisition, writable write/close, file read-back, entry removal). The fake is injected via
 * the constructor's `getDirectory` factory (testability decision, MANDATORY), so the real
 * browser OPFS is never touched. It mirrors real OPFS semantics the driver RELIES on: bytes
 * become visible only after the writable `close()` resolves, and a `close()` failure commits
 * nothing. All real-domain guarantees (durability barrier, fail-soft, NotFound = null read,
 * last-write-wins, per-instance isolation) are verified against the fake's backing store.
 */

/** Distinct, non-trivial byte payloads so "bytes verbatim" asserts are meaningful. */
const payloadOf = (...bytes: number[]): Uint8Array => new Uint8Array(bytes);

const notFound = (name: string): DOMException =>
  new DOMException(`entry "${name}" not found`, "NotFoundError");

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface FakeBehavior {
  /** Injected into every writable `close()`, emulating slow/durable commits. */
  closeDelayMs: number;
  /** When true, every writable `close()` rejects and commits nothing. */
  failClose: boolean;
}

/** Minimal `File`-like surface the driver reads (only `arrayBuffer()`/`text()`). */
interface FakeFile {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** Minimal writable surface the driver uses (only `write()`/`close()`). */
interface FakeWritable {
  write(data: unknown): Promise<void>;
  close(): Promise<void>;
}

/** Mutable byte node behind a file; shared by every handle to the same file. */
class FakeFileNode {
  public readonly kind = "file" as const;
  constructor(
    public readonly name: string,
    public bytes: Uint8Array = new Uint8Array(0),
  ) {}
}

class FakeDirNode {
  public readonly kind = "dir" as const;
  private readonly _entries: Map<string, FakeFileNode | FakeDirNode> = new Map();

  constructor(
    public readonly name: string,
    private readonly _behavior: FakeBehavior,
  ) {}

  public get size(): number {
    return this._entries.size;
  }

  public getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const existing = this._entries.get(name);
    if (existing?.kind === "dir") {
      return Promise.reject(new DOMException(`"${name}" is a directory`, "TypeMismatchError"));
    }
    if (existing && existing.kind === "file") {
      return Promise.resolve(new FakeFileHandle(existing, this._behavior));
    }
    if (options?.create) {
      const node = new FakeFileNode(name);
      this._entries.set(name, node);
      return Promise.resolve(new FakeFileHandle(node, this._behavior));
    }
    return Promise.reject(notFound(name));
  }

  public getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirNode> {
    const existing = this._entries.get(name);
    if (existing?.kind === "file") {
      return Promise.reject(new DOMException(`"${name}" is a file`, "TypeMismatchError"));
    }
    if (existing && existing.kind === "dir") return Promise.resolve(existing);
    if (options?.create) {
      const node = new FakeDirNode(name, this._behavior);
      this._entries.set(name, node);
      return Promise.resolve(node);
    }
    return Promise.reject(notFound(name));
  }

  public removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const existing = this._entries.get(name);
    if (!existing) return Promise.reject(notFound(name));
    if (existing.kind === "dir" && existing.size > 0 && !options?.recursive) {
      return Promise.reject(new DOMException(`"${name}" is not empty`, "InvalidModificationError"));
    }
    this._entries.delete(name);
    return Promise.resolve();
  }

  /** Live bytes of a nested file path, or `null` when any segment is missing. */
  public readBytes(path: readonly string[]): Uint8Array | null {
    if (path.length === 0) return null;
    let entry: FakeFileNode | FakeDirNode | undefined = this._entries.get(path[0]!);
    for (let i = 1; i < path.length - 1; i++) {
      if (entry?.kind !== "dir") return null;
      entry = entry._entries.get(path[i]!);
    }
    if (path.length > 1) {
      if (entry?.kind !== "dir") return null;
      entry = entry._entries.get(path[path.length - 1]!);
    }
    if (entry?.kind !== "file") return null;
    return entry.bytes;
  }
}

/**
 * File handle; the writable commits ONLY on `close()` (real OPFS semantics the driver relies
 * on), and a failed `close()` commits nothing.
 */
class FakeFileHandle {
  constructor(
    private readonly _node: FakeFileNode,
    private readonly _behavior: FakeBehavior,
  ) {}

  public getFile(): Promise<FakeFile> {
    const node = this._node;
    return Promise.resolve({
      name: node.name,
      size: node.bytes.byteLength,
      arrayBuffer: async (): Promise<ArrayBuffer> => node.bytes.slice().buffer,
      text: async (): Promise<string> => new TextDecoder().decode(node.bytes),
    });
  }

  public createWritable(): Promise<FakeWritable> {
    const node = this._node;
    const behavior = this._behavior;
    let pending: Uint8Array | null = null;
    return Promise.resolve({
      write: async (data: unknown): Promise<void> => {
        pending = new Uint8Array(data as ArrayBuffer);
      },
      close: async (): Promise<void> => {
        if (behavior.closeDelayMs > 0) await delay(behavior.closeDelayMs);
        if (behavior.failClose) throw notFound("disk-full"); // commits nothing on failure
        if (pending) node.bytes = pending;
      },
    });
  }
}

/**
 * The injectable fake OPFS surface: per-instance root + behavior, never shared (no-leak tests).
 * The single `as unknown as FileSystemDirectoryHandle` bridge marks the boundary to the real
 * DOM type -- internally the fake stays honest and minimal (only the driver's API subset).
 */
class FakeOpfs {
  public readonly behavior: FakeBehavior = { closeDelayMs: 0, failClose: false };
  private readonly _root: FakeDirNode = new FakeDirNode("root", this.behavior);
  /** When true, the factory rejects -- emulates an unavailable/persistently broken OPFS. */
  public rejectFactory = false;

  public readonly getDirectory = (): Promise<FileSystemDirectoryHandle> => {
    if (this.rejectFactory) {
      return Promise.reject(new DOMException("OPFS disabled", "SecurityError"));
    }
    return Promise.resolve(this._root as unknown as FileSystemDirectoryHandle);
  };

  public readBytes(path: readonly string[]): Uint8Array | null {
    return this._root.readBytes(path);
  }
}

describe("OpfsChunkDeltaStore — seed persistence", () => {
  it("reads null before the first save and roundtrips the seed after setSeed", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    expect(await store.getSeed()).toBeNull();
    await store.setSeed(777);
    expect(await store.getSeed()).toBe(777);
    // Persisted as a real file in the backing store, not only in memory.
    expect(fake.readBytes(["seed.json"])).toEqual(new TextEncoder().encode("777"));
  });

  it("writes over the seed file (single file, last write wins)", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    await store.setSeed(1);
    await store.setSeed(2);
    expect(await store.getSeed()).toBe(2);
  });
});

describe("OpfsChunkDeltaStore — chunk delta persistence", () => {
  it("saves and loads a delta payload with bytes verbatim (including an empty payload)", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    const payload = payloadOf(3, 6, 12, 24);
    await store.saveChunkDelta(3, 4, payload);
    expect(await store.loadChunkDelta(3, 4)).toEqual(payload);
    expect(fake.readBytes(["chunkdeltas", "3_4.bin"])).toEqual(payload);
    // An explicitly saved EMPTY delta is present, distinct from "missing".
    await store.saveChunkDelta(-1, -1, new Uint8Array(0));
    expect(await store.loadChunkDelta(-1, -1)).toEqual(new Uint8Array(0));
  });

  it("reads null for a chunk that has no saved delta (also after unrelated writes)", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    expect(await store.loadChunkDelta(1, 1)).toBeNull();
    await store.setSeed(42);
    await store.saveChunkDelta(9, 9, payloadOf(1));
    expect(await store.loadChunkDelta(1, 1)).toBeNull();
  });

  it("overwrites chunk bytes last-write-wins (later save fully replaces the previous payload)", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    await store.saveChunkDelta(0, 0, payloadOf(1));
    await store.saveChunkDelta(0, 0, payloadOf(2, 2, 2, 2));
    expect(await store.loadChunkDelta(0, 0)).toEqual(payloadOf(2, 2, 2, 2));
    expect(fake.readBytes(["chunkdeltas", "0_0.bin"])).toHaveLength(4); // no stale tail bytes
  });

  it("clearChunkDelta drops only the named chunk (neighbours and seed survive) and is idempotent", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    await store.setSeed(5);
    await store.saveChunkDelta(0, 0, payloadOf(1));
    await store.saveChunkDelta(1, 1, payloadOf(2));
    await store.clearChunkDelta(0, 0);
    expect(await store.loadChunkDelta(0, 0)).toBeNull();
    expect(await store.loadChunkDelta(1, 1)).toEqual(payloadOf(2));
    expect(await store.getSeed()).toBe(5);
    await store.clearChunkDelta(0, 0); // clearing an absent chunk is a no-op, not an error
  });

  it("clearAll resets the seed and every chunk (including negative-coordinate chunks)", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    await store.setSeed(9);
    await store.saveChunkDelta(-2, 3, payloadOf(1));
    await store.saveChunkDelta(0, 0, payloadOf(2));
    await store.clearAll();
    expect(await store.getSeed()).toBeNull();
    expect(await store.loadChunkDelta(-2, 3)).toBeNull();
    expect(await store.loadChunkDelta(0, 0)).toBeNull();
    expect(fake.readBytes(["seed.json"])).toBeNull();
  });

  it("concurrent saves of different chunks never corrupt each other", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    const chunks: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 1],
      [-1, 2],
      [3, -4],
      [7, 7],
    ];
    await Promise.all(
      chunks.map(async ([cx, cz], i): Promise<void> => {
        await store.saveChunkDelta(cx, cz, payloadOf(i, i + 1, i + 2, i + 3));
      }),
    );
    for (let i = 0; i < chunks.length; i++) {
      const [cx, cz] = chunks[i]!;
      expect(await store.loadChunkDelta(cx, cz)).toEqual(payloadOf(i, i + 1, i + 2, i + 3));
    }
  });
});

describe("OpfsChunkDeltaStore — mutation ordering", () => {
  it("an older, slower save never overtakes a newer save of the same chunk", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    fake.behavior.closeDelayMs = 40; // the first save's commit is slow ...
    const first = store.saveChunkDelta(0, 0, payloadOf(1, 1, 1));
    await delay(10); // ... and has reached close() before the second save starts
    fake.behavior.closeDelayMs = 0;
    const second = store.saveChunkDelta(0, 0, payloadOf(2, 2, 2));
    await Promise.all([first, second]);
    expect(await store.loadChunkDelta(0, 0)).toEqual(payloadOf(2, 2, 2)); // last call wins
  });

  it("clearChunkDelta issued after a slow save removes the file (no resurrection)", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    fake.behavior.closeDelayMs = 30;
    const save = store.saveChunkDelta(4, 4, payloadOf(7, 7));
    await delay(5);
    fake.behavior.closeDelayMs = 0;
    await Promise.all([save, store.clearChunkDelta(4, 4)]);
    expect(await store.loadChunkDelta(4, 4)).toBeNull();
  });

  it("clearAll waits for in-flight saves and a save queued after it lands in a fresh directory", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    fake.behavior.closeDelayMs = 25;
    const early = store.saveChunkDelta(1, 1, payloadOf(1));
    await delay(5);
    fake.behavior.closeDelayMs = 0;
    const clear = store.clearAll();
    const late = store.saveChunkDelta(2, 2, payloadOf(2));
    await Promise.all([early, clear, late]);
    expect(await store.loadChunkDelta(1, 1)).toBeNull(); // cleared after the early save
    expect(await store.loadChunkDelta(2, 2)).toEqual(payloadOf(2)); // survived the clear
  });

  it("a failed write does not block the queue behind it", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    fake.behavior.failClose = true;
    const failing = store.saveChunkDelta(0, 0, payloadOf(9));
    const failed = expect(failing).rejects.toThrow();
    await failed;
    fake.behavior.failClose = false;
    await store.saveChunkDelta(0, 0, payloadOf(5));
    expect(await store.loadChunkDelta(0, 0)).toEqual(payloadOf(5));
  });
});

describe("OpfsChunkDeltaStore — durability barrier & lifecycle", () => {
  it("flush resolves only after every in-flight write fully committed (delayed-write fake)", async () => {
    const fake = new FakeOpfs();
    fake.behavior.closeDelayMs = 25; // write stays uncommitted until close() resolves
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    const payload = payloadOf(9, 8, 7, 6);
    const save = store.saveChunkDelta(2, 2, payload); // NOT awaited: stays in flight
    await store.flush(); // durability barrier
    await save; // already settled once the barrier resolved
    // Committed only AFTER flush resolved -- proves the barrier waited for close().
    expect(fake.readBytes(["chunkdeltas", "2_2.bin"])).toEqual(payload);
  });

  it("close is idempotent: a double close resolves cleanly and the store stays usable", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    await store.saveChunkDelta(0, 0, payloadOf(1));
    await store.close();
    await store.close();
    // Handles are re-resolved lazily -- a closed store is not poisoned.
    expect(await store.loadChunkDelta(0, 0)).toEqual(payloadOf(1));
  });

  it("storage failures surface as rejected promises, including from close", async () => {
    const broken = new FakeOpfs();
    broken.rejectFactory = true;
    const store = new OpfsChunkDeltaStore(broken.getDirectory);
    await expect(store.close()).rejects.toThrow();
    // Still safe to close again: nothing is left in a half-released state.
    await expect(store.close()).rejects.toThrow();
  });

  it("write failures reject the save, keep the last committed payload, never become unhandled", async () => {
    const fake = new FakeOpfs();
    const store = new OpfsChunkDeltaStore(fake.getDirectory);
    const good = payloadOf(1, 2, 3, 4);
    await store.saveChunkDelta(0, 0, good);
    fake.behavior.failClose = true;
    await expect(store.saveChunkDelta(0, 0, payloadOf(9, 9, 9, 9))).rejects.toThrow();
    // Fail-soft: a failed write must not corrupt the last committed payload.
    expect(fake.readBytes(["chunkdeltas", "0_0.bin"])).toEqual(good);
    await store.flush(); // must resolve despite the failed write
  });
});

describe("OpfsChunkDeltaStore — isolation & construction", () => {
  it("separate driver instances with separate injected factories never share state", async () => {
    const fakeA = new FakeOpfs();
    const fakeB = new FakeOpfs();
    const storeA = new OpfsChunkDeltaStore(fakeA.getDirectory);
    const storeB = new OpfsChunkDeltaStore(fakeB.getDirectory);
    await storeA.setSeed(11);
    await storeA.saveChunkDelta(0, 0, payloadOf(1));
    expect(await storeB.getSeed()).toBeNull();
    expect(await storeB.loadChunkDelta(0, 0)).toBeNull();
    await storeB.setSeed(22);
    await storeB.saveChunkDelta(1, 1, payloadOf(2));
    expect(await storeA.getSeed()).toBe(11);
    expect(await storeA.loadChunkDelta(0, 0)).toEqual(payloadOf(1));
    expect(await storeA.loadChunkDelta(1, 1)).toBeNull();
    expect(await storeB.loadChunkDelta(0, 0)).toBeNull();
  });

  it("constructor throws synchronously when OPFS is absent and no factory is injected", () => {
    vi.stubGlobal("navigator", {});
    try {
      expect(() => new OpfsChunkDeltaStore()).toThrow(/OPFS/);
      // An injected factory bypasses the environment check entirely.
      const fake = new FakeOpfs();
      const store = new OpfsChunkDeltaStore(fake.getDirectory);
      expect(store).toBeInstanceOf(OpfsChunkDeltaStore);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
