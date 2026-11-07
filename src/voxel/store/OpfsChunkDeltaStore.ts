import type { ChunkDeltaStore } from "./ChunkDeltaStore.js";

/**
 * OPFS driver for the M3 `ChunkDeltaStore` contract (dossier §4.2 M3, D2: alternative backend
 * behind the same interface, next to `IndexedDbChunkDeltaStore`). Layout:
 *   <opfs-root>/
 *     seed.json      -- world seed (D3b), decimal number text; read as `null` when absent/corrupt
 *     chunkdeltas/
 *       <cx>_<cz>.bin -- one opaque `Uint8Array` delta payload per (cx,cz); format lives in the
 *                       codec, never in a driver. Negative chunk coordinates are valid names
 *                       (e.g. `-3_5.bin`).
 * Delta payloads are written verbatim (`writable.write(bytes)` + `writable.close()`) and read
 * back via `file.arrayBuffer()` -- the driver never (de)serializes. Only the ASYNC handle API
 * is used; sync access handles are deliberately avoided.
 *
 * Fail-soft, honest semantics mirroring the IndexedDB driver: a missing file reads as `null`
 * (NotFoundError), every other storage error REJECTS (the world decides how to degrade), and
 * neither `getSeed` nor `loadChunkDelta` treats a corrupt seed/empty file as a crash.
 * `flush()` is a durability barrier that awaits every in-flight write; `close()` additionally
 * awaits the base-handle acquisition and pending writes, so storage failures surface as
 * rejections, and releases cached handles in a `finally` (idempotent -- a later call simply
 * re-resolves the root). A closing/`write` failure never crashes the world: fire-and-forget
 * writes are internally "handled" so they cannot turn into unhandled rejections, while a
 * caller that awaits `saveChunkDelta` still receives the rejection.
 *
 * Constructor throws synchronously when OPFS is unavailable (`navigator.storage.getDirectory`
 * missing) and NO factory is injected, so App.ts can try/catch and degrade to "no persistence"
 * (same pattern as `IndexedDbChunkDeltaStore`). An injected `getDirectory` factory bypasses
 * the environment check (tests, polyfills). Runtime failures of the factory surface as
 * rejected promises from the async methods -- never as synchronous throws.
 */

const SEED_FILE = "seed.json";
const DELTA_DIR = "chunkdeltas";
const BIN_EXT = ".bin";

const OPFS_UNAVAILABLE_MSG =
  "[OpfsChunkDeltaStore] OPFS unavailable: navigator.storage.getDirectory is missing; " +
  "pass an injected getDirectory factory to bypass the environment check";

const chunkFileName = (cx: number, cz: number): string => `${cx}_${cz}${BIN_EXT}`;

/** Structural detection (works for DOMException and test doubles): only NotFound is a "null read". */
const isNotFoundError = (e: unknown): boolean =>
  typeof e === "object" &&
  e !== null &&
  "name" in e &&
  (e as { name: unknown }).name === "NotFoundError";

/** True only when the real browser OPFS surface exists (used for the DEFAULT factory path). */
const isOpfsSupported = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";

/** Production default: resolve the origin-private root. Called only after the constructor check. */
function defaultGetDirectory(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/**
 * OPFS driver for the M3 edit-delta store. Every async method either resolves or rejects --
 * never throws synchronously (the constructor is the sole sync-throw site).
 */
export class OpfsChunkDeltaStore implements ChunkDeltaStore {
  private readonly _getDirectory: () => Promise<FileSystemDirectoryHandle>;
  private _rootPromise: Promise<FileSystemDirectoryHandle> | null = null;
  private _deltaDirPromise: Promise<FileSystemDirectoryHandle> | null = null;
  /** In-flight write/removal operations; `flush()`/`close()` are the durability barrier. */
  private readonly _pendingWrites: Set<Promise<void>> = new Set();
  /**
   * Tail of the mutation queue. Every write/removal runs strictly after the previous one settled
   * (success or failure), so call order is commit order: two saves of one chunk can no longer
   * close out of order (stale payload winning), a `clearChunkDelta` cannot be overtaken by an
   * older save (resurrected file), and `clearAll` never destroys the directory under a write
   * that is still in flight. Reads are not queued: they see the last committed bytes.
   */
  private _mutationTail: Promise<void> = Promise.resolve();

  constructor(getDirectory?: () => Promise<FileSystemDirectoryHandle>) {
    this._getDirectory = getDirectory ?? defaultGetDirectory;
    if (getDirectory === undefined && !isOpfsSupported()) {
      throw new Error(OPFS_UNAVAILABLE_MSG);
    }
  }

  /** Lazy singleton root handle; a rejected factory stays rejected for all consumers. */
  private _root(): Promise<FileSystemDirectoryHandle> {
    this._rootPromise ??= Promise.resolve().then((): Promise<FileSystemDirectoryHandle> =>
      this._getDirectory(),
    );
    return this._rootPromise;
  }

  /** Lazy singleton `chunkdeltas/` handle (created on first delta access). */
  private _deltaDir(): Promise<FileSystemDirectoryHandle> {
    this._deltaDirPromise ??= this._root().then((root): Promise<FileSystemDirectoryHandle> =>
      root.getDirectoryHandle(DELTA_DIR, { create: true }),
    );
    return this._deltaDirPromise;
  }

  /**
   * Queues `operation` behind every earlier mutation and tracks it as in-flight. A failed
   * predecessor never blocks the queue; its error went to its own caller.
   */
  private _enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this._mutationTail.then(operation);
    this._mutationTail = run.then(
      (): void => undefined,
      (): void => undefined,
    );
    return this._trackWrite(run);
  }

  /**
   * Registers `write` as in-flight (synchronously, so `flush()` can never miss it) and returns
   * it unchanged: the awaiting caller still receives the rejection, while our own handler marks
   * the promise handled so a fire-and-forget failure is never an unhandled rejection.
   */
  private _trackWrite(write: Promise<void>): Promise<void> {
    this._pendingWrites.add(write);
    void write.then(
      (): void => {
        this._pendingWrites.delete(write);
      },
      (): void => {
        this._pendingWrites.delete(write);
      },
    );
    return write;
  }

  /** Full durability write: buffer via the async writable, then commit on `close()`. */
  private async _writeBytes(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
    const writable = await handle.createWritable();
    // View-safe write matching `DirectoryAssetSink` (OPFS pre-TS5.7-typed-arrays): `slice()`
    // yields an exact-size, ArrayBuffer-backed copy regardless of the source view's
    // byteOffset/length or a possible SharedArrayBuffer backing -- required by the stream API.
    // A rejected `write()` leaves the file at its previous content (OPFS stream semantics);
    // the next save is a full overwrite, so last-write-wins still holds.
    await writable.write(bytes.slice().buffer as ArrayBuffer);
    await writable.close();
  }

  private async _writeSeed(seed: number): Promise<void> {
    const root = await this._root();
    const handle = await root.getFileHandle(SEED_FILE, { create: true });
    await this._writeBytes(handle, new TextEncoder().encode(String(seed)));
  }

  private async _saveChunk(cx: number, cz: number, payload: Uint8Array): Promise<void> {
    const dir = await this._deltaDir();
    const handle = await dir.getFileHandle(chunkFileName(cx, cz), { create: true });
    await this._writeBytes(handle, payload);
  }

  private async _clearChunk(cx: number, cz: number): Promise<void> {
    const dir = await this._deltaDir();
    try {
      await dir.removeEntry(chunkFileName(cx, cz));
    } catch (e) {
      if (!isNotFoundError(e)) throw e; // missing entry = already cleared (idempotent)
    }
  }

  private async _clearAll(): Promise<void> {
    const root = await this._root();
    try {
      await root.removeEntry(SEED_FILE);
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
    try {
      await root.removeEntry(DELTA_DIR, { recursive: true });
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
    // The directory entry was destroyed; re-create it lazily on the next delta access.
    this._deltaDirPromise = null;
  }

  public async getSeed(): Promise<number | null> {
    try {
      const root = await this._root();
      const handle = await root.getFileHandle(SEED_FILE);
      const file = await handle.getFile();
      const raw = (await file.text()).trim();
      if (raw === "") return null; // empty/truncated file is "nothing saved", not seed 0
      const seed = Number(raw);
      return Number.isFinite(seed) ? seed : null; // NaN/corrupt text reads as null (fail-soft)
    } catch (e) {
      if (isNotFoundError(e)) return null;
      throw e;
    }
  }

  public setSeed(seed: number): Promise<void> {
    return this._enqueue((): Promise<void> => this._writeSeed(seed));
  }

  public async loadChunkDelta(cx: number, cz: number): Promise<Uint8Array | null> {
    try {
      const dir = await this._deltaDir();
      const file = await (await dir.getFileHandle(chunkFileName(cx, cz))).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      if (isNotFoundError(e)) return null;
      throw e;
    }
  }

  public saveChunkDelta(cx: number, cz: number, payload: Uint8Array): Promise<void> {
    return this._enqueue((): Promise<void> => this._saveChunk(cx, cz, payload));
  }

  public clearChunkDelta(cx: number, cz: number): Promise<void> {
    return this._enqueue((): Promise<void> => this._clearChunk(cx, cz));
  }

  public clearAll(): Promise<void> {
    return this._enqueue((): Promise<void> => this._clearAll());
  }

  /**
   * Durability barrier (pagehide/visibilitychange, D3): awaits every write that was in flight
   * at call time. A failed write's error was already surfaced to its own caller -- flush is
   * best-effort and therefore resolves even when one write failed (like the IDB driver's).
   */
  public async flush(): Promise<void> {
    const pending = [...this._pendingWrites];
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  /**
   * Teardown: awaits the base root AND all in-flight writes (propagating the first failure --
   * a genuinely broken store must surface), then releases cached handles so a later call (or
   * a re-open) simply re-resolves them. Idempotent by construction.
   */
  public async close(): Promise<void> {
    try {
      const pending = [...this._pendingWrites];
      await Promise.all([this._root(), ...pending]);
    } finally {
      this._rootPromise = null;
      this._deltaDirPromise = null;
    }
  }
}
