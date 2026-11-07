import type { ChunkDeltaStore } from "./ChunkDeltaStore.js";

/** IndexedDB object-store and key names for the M3 delta store (no global singletons). */
const DB_NAME = "small-world-machine";
const DB_VERSION = 1;
const STORE_DELTAS = "voxel-deltas";
const STORE_META = "voxel-meta";
const KEY_SEED = "world-seed";

const keyOf = (cx: number, cz: number): string => `${cx},${cz}`;

/**
 * IndexedDB driver for the M3 `ChunkDeltaStore` contract (D2: currently the ONLY product
 * driver; OPFS or any other backend can be added later behind the same interface). Each delta
 * is stored as a single opaque `Uint8Array` value under its `(cx,cz)` key -- the format lives
 * in the pure codec, never in a driver. Seed persistence (D3b) uses a fixed meta key so a
 * relaunch rebuilds the exact same world.
 *
 * Fail-fast semantics: every operation rejects on IDB errors and a missing row reads as
 * `null`. `flush()` is a durability barrier for the pagehide path (D3) -- IDB transactions
 * auto-commit on completion, so awaiting a write is already a barrier; flush is a documented
 * no-op kept for parity with the memory driver's contract.
 */
export class IndexedDbChunkDeltaStore implements ChunkDeltaStore {
  private _dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly _idbFactory: IDBFactory = globalThis.indexedDB,
    private readonly _dbName: string = DB_NAME,
  ) {
    if (!this._idbFactory) {
      throw new Error("[IndexedDbChunkDeltaStore] indexedDB is not available in this context");
    }
  }

  private _open(): Promise<IDBDatabase> {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this._idbFactory.open(this._dbName, DB_VERSION);
      request.onupgradeneeded = (): void => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_DELTAS)) db.createObjectStore(STORE_DELTAS);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      };
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => reject(request.error ?? new Error("open failed"));
    });
    return this._dbPromise;
  }

  /** Runs `body` inside one transaction over the given stores; resolves/rejects on completion. */
  private _transaction(
    mode: IDBTransactionMode,
    stores: readonly string[],
    body: (tx: IDBTransaction) => void,
  ): Promise<void> {
    return this._open().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(stores as string[], mode);
          body(tx);
          tx.oncomplete = (): void => resolve();
          tx.onabort = (): void => reject(tx.error ?? new Error("transaction aborted"));
          tx.onerror = (): void => reject(tx.error ?? new Error("transaction error"));
        }),
    );
  }

  /** Reads a single value via a one-shot readonly transaction (no generic IDBRequest passthrough). */
  private _read(storeName: string, key: IDBValidKey): Promise<unknown> {
    return this._open().then(
      (db) =>
        new Promise<unknown>((resolve, reject) => {
          const tx = db.transaction([storeName], "readonly");
          const request = tx.objectStore(storeName).get(key);
          request.onsuccess = (): void => resolve(request.result);
          request.onerror = (): void => reject(request.error ?? new Error("read failed"));
        }),
    );
  }

  public async getSeed(): Promise<number | null> {
    const value = await this._read(STORE_META, KEY_SEED);
    return typeof value === "number" ? value : null;
  }

  public async setSeed(seed: number): Promise<void> {
    await this._transaction("readwrite", [STORE_META], (tx) => {
      tx.objectStore(STORE_META).put(seed, KEY_SEED);
    });
  }

  public async loadChunkDelta(cx: number, cz: number): Promise<Uint8Array | null> {
    const value = await this._read(STORE_DELTAS, keyOf(cx, cz));
    return value instanceof Uint8Array ? value : null;
  }

  public async saveChunkDelta(cx: number, cz: number, payload: Uint8Array): Promise<void> {
    await this._transaction("readwrite", [STORE_DELTAS], (tx) => {
      tx.objectStore(STORE_DELTAS).put(payload, keyOf(cx, cz));
    });
  }

  public async clearChunkDelta(cx: number, cz: number): Promise<void> {
    await this._transaction("readwrite", [STORE_DELTAS], (tx) => {
      tx.objectStore(STORE_DELTAS).delete(keyOf(cx, cz));
    });
  }

  public async clearAll(): Promise<void> {
    await this._transaction("readwrite", [STORE_DELTAS, STORE_META], (tx) => {
      tx.objectStore(STORE_DELTAS).clear();
      tx.objectStore(STORE_META).clear();
    });
  }

  public async flush(): Promise<void> {
    // IDB transactions auto-commit on completion; awaiting writes is already a durability
    // barrier. Documented no-op kept for parity with the memory driver contract.
    void this._dbPromise;
  }

  public async close(): Promise<void> {
    if (this._dbPromise) {
      const db = await this._dbPromise;
      db.close();
      this._dbPromise = null;
    }
  }
}
