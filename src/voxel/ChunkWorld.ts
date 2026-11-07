import { BLOCK_AIR } from "./BlockRegistry.js";
import { Chunk } from "./Chunk.js";
import type {
  CornerDir,
  FaceDir,
  MeshBlockDescriptorEntry,
  VoxelMeshData,
} from "./mesh/NaiveMesher.js";
import { buildNeighborCorner, buildNeighborRim } from "./mesh/NaiveMesher.js";
import { daylightFactorAt } from "./light/daylight.js";
import type { ChunkDeltaEdit } from "./store/ChunkDeltaCodec.js";
import { encodeChunkDelta } from "./store/ChunkDeltaCodec.js";
import type { ChunkDeltaStore } from "./store/ChunkDeltaStore.js";
import { tryDecode } from "./store/ChunkDeltaStore.js";
import type { MeshClient, MeshOutcome } from "./worker/MeshWorkerProtocol.js";

/**
 * M1 world/store backbone (dossier §3.2 `ChunkWorld`): owns the chunk map, the lifecycle state
 * machine (REQUESTED -> DATA -> MEShing -> READY -> UNLOAD), the streaming focus, the
 * neighbor-gated mesh dispatch and the exact-once seam contract. PURE LOGIC -- no `Object3D`, no
 * scene, no DOM, no engine import -- so the whole streaming/lifecycle can be unit-tested in node
 * against the same pure backend the worker runs (`MeshClient`).
 *
 * Thread/worker roles (dossier §5 S2): the main thread ONLY decides and dispatches. World
 * generation and mesh building never run here; a generated buffer is stored as `Chunk`-data, a
 * meshed outcome is handed to the callback (`ChunkWorldHost` creates/removes `Object3D`s).
 *
 * Seam guarantee (M1 "keine Naht"): a chunk is only meshed once its four horizontal AXIS
 * neighbors have DATA (minNeighborsToMesh, dossier §3.2). The worker then receives only the
 * neighbor border planes, and `buildMesh` culls boundary faces exactly-once (pinned by
 * `SeamMeshing.test.ts`). M2 extends the gate to the four horizontal DIAGONAL neighbors whose
 * AO corner columns (16 bytes each) keep vertex occlusion byte-identical across 4-chunk seams.
 */

/** Internal lifecycle used by the streaming state machine. */
type Phase = "generating" | "data" | "meshing" | "ready";

interface ChunkRecord {
  cx: number;
  cz: number;
  phase: Phase;
  chunk: Chunk | null; // non-null once phase >= "data", may be evicted to null when far (S4)
  /** True once `onMeshReady` has hosted a scene node for this record (stays true across edit remeshes). */
  hosted: boolean;
  voxelEvicted?: boolean;
  reloadingVoxels?: boolean;
  /** Set while a mesh is in flight if an edit mutated the voxels; the loop remeshes afterwards. */
  dirty: boolean;
  /** M3: local linear cell index -> block id, for every cell edited since this Chunk was built
   *  (the generated terrain plus any stored edits that were applied at load). This is the ONLY
   *  thing that ever gets persisted -- the terrain itself is regenerated from the seed (D1). */
  deltas: Map<number, number>;
}

export interface ChunkWorldCallbacks {
  /** A chunk finished meshing on the worker; the host glue creates the render node. */
  onMeshReady(cx: number, cz: number, mesh: VoxelMeshData): void;
  /** A ready chunk is being evicted; the host glue removes its render node. */
  onUnload(cx: number, cz: number): void;
}

export interface ChunkWorldOptions {
  /** The background work source (worker client in production, foreground double in tests). */
  client: MeshClient;
  /** Serializable registry subset (opacity for meshing, collidability for the player sweep). */
  descriptor: readonly MeshBlockDescriptorEntry[];
  /** World seed handed to the worker's own `TerrainGenerator`. */
  seed: number;
  /** M3: optional edit-delta store. When injected, edited cells are persisted on eviction and
   *  re-applied on load (only cells that differ from the seed-regenerated terrain -- D1/D3). */
  store?: ChunkDeltaStore;
  /** Streaming add radius (Chebyshev, in chunks). Data is generated within it. Default 6. */
  generateRadius?: number;
  /** S4 Eviction-Policy: distance from focus (Chebyshev) beyond which CPU voxel arrays are released
   *  while GPU meshes stay rendered in the scene. Defaults to Math.max(3, (generateRadius ?? 6) - 2). */
  retainVoxelRadius?: number;
  /** Suspension distance where a ready chunk is dropped (hysteresis: must be > generateRadius). */
  unloadRadius?: number;
  /** Generate/mesh dispatches budgeted per `update()` call. Default 16. */
  maxTasksPerTick?: number;
  /** Host glue (render-node lifecycle) -- injected, kept out of this pure module. */
  callbacks: ChunkWorldCallbacks;
}

export interface ChunkWorldStats {
  /** Chunks whose block data exists (including meshed ones). */
  generated: number;
  /** Chunks currently being generated or meshed (in flight). */
  inFlight: number;
  /** Chunks meshed and ready (hosted). */
  ready: number;
  /** Number of chunks whose CPU voxel arrays are currently retained in memory (S4). */
  voxelChunksRetained: number;
  /** Worker-side meshing wall time of the last completed mesh (ms). */
  meshMsLast: number;
  /** Cumulative worker-side meshing wall time (ms). 0 while nothing meshed. */
  meshMsTotal: number;
  /** Successful block edits since creation (M2, for the stats overlay + QA gate). */
  edits: number;
  /** M3: number of chunk edit-deltas persisted (save-on-evict / `persistAll`). */
  persistCount: number;
  /** M3: total bytes persisted -- KB-range by construction (edit deltas only, D1). */
  persistBytes: number;
}

const CHUNK_SIZE = Chunk.SIZE;
function keyOf(cx: number, cz: number): string {
  return `${cx},${cz}`;
}
function chebyshev(a: number, b: number, x: number, y: number): number {
  return Math.max(Math.abs(a - x), Math.abs(b - y));
}

/** Neighbor offsets a chunk needs meshed before it can be meshed itself: the four horizontal
 *  axis-neighbors (seam-culling rims) PLUS the four horizontal diagonals (M2 AO corner columns).
 *  All 8 live in the SAME Chebyshev ring, so this can never change the reachable mesh region
 *  (meshed radius stays generateRadius-1) -- it only guarantees the AO corner data exists every
 *  time a chunk meshes, keeping vertex AO byte-identical across 4-chunk seams. */
const MESH_NEIGHBORS: readonly [number, number][] = [
  [-1, 0], // -X  (axial)
  [1, 0], // +X  (axial)
  [0, -1], // -Z  (axial)
  [0, 1], // +Z  (axial)
  [-1, -1], // -X,-Z  (diagonal)
  [1, -1], // +X,-Z  (diagonal)
  [-1, 1], // -X,+Z  (diagonal)
  [1, 1], // +X,+Z  (diagonal)
];

/** Maps a neighbor offset to the rim direction of that neighbor's plane FACING this chunk.
 *  Axial offsets only (diagonals have no face plane -- their data arrives as corner columns). */
function rimDirForNeighbor(dx: number, dz: number): FaceDir {
  // -X neighbor -> this chunk reads its localX=15 plane; +X -> localX=0; -Z -> localZ=15; +Z -> localZ=0.
  if (dx === -1) return "nx";
  if (dx === 1) return "px";
  if (dz === -1) return "nz";
  return "pz"; // dz === 1
}

/** Maps a diagonal neighbor offset to the `CornerDir` whose corner faces THIS chunk (the corner
 *  column handed to the AO of this chunk's 4-corner faces). Diagonal offsets only; the naming
 *  matches `CORNER_COLUMNS` in the pure mesher. */
function cornerDirForNeighbor(dx: number, dz: number): CornerDir {
  if (dx === -1) return dz === -1 ? "nn" : "np";
  return dz === -1 ? "pn" : "pp"; // dx === 1
}

export class ChunkWorld {
  private readonly _client: MeshClient;
  private readonly _collidable: ReadonlySet<number>;
  private readonly _opaque: ReadonlySet<number>;
  private readonly _callbacks: ChunkWorldCallbacks;
  private readonly _generateRadius: number;
  private readonly _retainVoxelRadius: number;
  private readonly _unloadRadius: number;
  private readonly _maxTasksPerTick: number;
  private readonly _seed: number;
  private readonly _store: ChunkDeltaStore | null;
  /** Single-flight seed persistence (D3b) -- set once, at most one IDB write in flight. */
  private _seedPersist: Promise<void> | null = null;
  /** In-flight delta saves; awaited by `flushStore()` for the pagehide/QA durability path. */
  private _pendingSaves: Set<Promise<void>> = new Set();

  private readonly _chunks: Map<string, ChunkRecord> = new Map();
  private _focusCx: number = 0;
  private _focusCz: number = 0;
  private _focusSet: boolean = false;
  private _meshMsTotal: number = 0;
  private _meshMsLast: number = 0;
  private _editCount: number = 0;
  private _persistCount: number = 0;
  private _persistBytes: number = 0;

  constructor(options: ChunkWorldOptions) {
    this._client = options.client;
    this._collidable = new Set(options.descriptor.filter((e) => e.collidable).map((e) => e.id));
    this._opaque = new Set(options.descriptor.filter((e) => e.opaque).map((e) => e.id));
    this._callbacks = options.callbacks;
    this._generateRadius = options.generateRadius ?? 6;
    this._retainVoxelRadius = options.retainVoxelRadius ?? Math.max(3, this._generateRadius - 2);
    this._unloadRadius = options.unloadRadius ?? this._generateRadius + 2;
    if (this._unloadRadius <= this._generateRadius) {
      throw new Error(
        "[ChunkWorld] unloadRadius must exceed generateRadius (load/unload hysteresis)",
      );
    }
    this._maxTasksPerTick = options.maxTasksPerTick ?? 16;
    this._seed = options.seed;
    this._store = options.store ?? null;
    // Wire the background roles with the world seed + block semantics (fire-and-forget: the
    // worker processes messages in order, so configure always precedes the first task).
    this._client.configure(options.seed, options.descriptor);
  }

  /** Centers streaming on a world-space position (the player's feet). Cheap, call every frame. */
  public setFocus(wx: number, wz: number): void {
    this._focusCx = Math.floor(wx / CHUNK_SIZE);
    this._focusCz = Math.floor(wz / CHUNK_SIZE);
    this._focusSet = true;
  }

  /** The chunk the streaming window is currently centered on. Additive accessor for tests and
   *  the QA gate (proves the focus follows the player across chunk borders). */
  public getFocusChunk(): { cx: number; cz: number } {
    return { cx: this._focusCx, cz: this._focusCz };
  }

  /** One streaming tick -- bounded dispatch of generate/mesh tasks and unload beyond the radius. */
  public update(): void {
    if (!this._focusSet) return;
    const fx = this._focusCx;
    const fz = this._focusCz;

    // 1. Evict far chunks (only after their host was removed).
    for (const [key, rec] of Array.from(this._chunks)) {
      if (chebyshev(rec.cx, rec.cz, fx, fz) > this._unloadRadius) {
        if (rec.hosted) this._callbacks.onUnload(rec.cx, rec.cz);
        this._saveDelta(rec); // M3: persist edited cells BEFORE the record is dropped (D3)
        this._chunks.delete(key);
      }
    }

    // 2. S4 CPU-Voxel Eviction: drop CPU voxel data for far chunks whose neighbors do not need it
    if (this._retainVoxelRadius < this._unloadRadius) {
      for (const rec of this._chunks.values()) {
        if (rec.chunk !== null) {
          if (chebyshev(rec.cx, rec.cz, fx, fz) > this._retainVoxelRadius) {
            let needed = false;
            for (const [dx, dz] of MESH_NEIGHBORS) {
              const nrec = this._chunks.get(keyOf(rec.cx + dx, rec.cz + dz));
              if (
                nrec &&
                nrec.phase === "data" &&
                chebyshev(nrec.cx, nrec.cz, fx, fz) < this._generateRadius
              ) {
                needed = true;
                break;
              }
            }
            if (!needed) {
              rec.chunk = null;
              rec.voxelEvicted = true;
            }
          }
        }
      }
    }

    // 3. Generate/mesh inside the radius, nearest rings first (deterministic order, budgeted).
    let dispatched = 0;
    ring: for (let r = 0; r <= this._generateRadius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (dispatched >= this._maxTasksPerTick) break ring;
          const cx = fx + dx;
          const cz = fz + dz;
          const rec = this._chunks.get(keyOf(cx, cz));
          if (!rec) {
            this._requestGenerate(cx, cz);
            dispatched++;
            continue;
          }
          if (
            rec.voxelEvicted &&
            !rec.reloadingVoxels &&
            chebyshev(cx, cz, fx, fz) <= this._retainVoxelRadius
          ) {
            this._requestReloadVoxels(rec);
            dispatched++;
            continue;
          }
          if (rec.phase === "data" && this._tryMesh(cx, cz, rec)) {
            dispatched++;
          }
        }
      }
    }
  }

  /** Whether the chunk column containing `(wx, wz)` currently holds loaded voxel data. */
  public hasChunkDataAt(wx: number, wz: number): boolean {
    const rec = this._chunks.get(keyOf(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)));
    return rec?.chunk !== null && rec?.chunk !== undefined;
  }

  /** World-space voxel lookup used by the player sweep. Unloaded chunk / out of column -> air. */
  public getWorldBlock(wx: number, wy: number, wz: number): number {
    const rec = this._chunks.get(keyOf(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)));
    if (!rec?.chunk) return BLOCK_AIR;
    const lx = ((Math.floor(wx) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((Math.floor(wz) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    // `Chunk.getBlock` reads out-of-band Y as air.
    return rec.chunk.getBlock(lx, Math.floor(wy), lz);
  }

  /** Whether a world cell is solid for the player sweep (registry `collidable`, not opacity). */
  public isSolidAt(wx: number, wy: number, wz: number): boolean {
    return this._collidable.has(this.getWorldBlock(wx, wy, wz));
  }

  /** M3 light probe (QA gate / diagnostics): the baked light factor a cell would carry in the
   *  mesh. Returns the canonical seam-exact DAYLIGHT component (the SAME pure height rule the
   *  worker mesher bakes into `colors.b`, D4). The mesher's per-face point-flood only darkens
   *  fully sealed air pockets -- a face-side effect a cell query cannot determine without face
   *  context, and inert on generated heightfield terrain (no sealed pockets), so this query and
   *  the meshed output agree on the game world. Out-of-column cells read as open air (full light). */
  public lightFactorAt(wx: number, wy: number, wz: number): number {
    if (wy < 0 || wy >= CHUNK_SIZE) return 1;
    const rec = this._chunks.get(keyOf(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)));
    if (!rec?.chunk) return 1;
    const lx = ((Math.floor(wx) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((Math.floor(wz) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const voxels = rec.chunk.voxels;
    const opaqueAt = (x: number, y: number, z: number): boolean => {
      if (x < 0 || y < 0 || z < 0 || x >= CHUNK_SIZE || y >= CHUNK_SIZE || z >= CHUNK_SIZE) {
        return false; // missing neighbor data -> open (world/column edge)
      }
      return this._opaque.has(voxels[x + z * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE]!);
    };
    let surfaceY = -1;
    for (let y = CHUNK_SIZE - 1; y >= 0; y--) {
      if (opaqueAt(lx, y, lz)) {
        surfaceY = y;
        break;
      }
    }
    return daylightFactorAt(wy, surfaceY);
  }

  /**
   * M2 block editing (dossier §4.2): writes a block id into the loaded column at world
   * coordinates and schedules the BOUNDED 1-chunk remesh (own chunk + horizontal neighbors whose
   * rim plane contains the edited cell -- max 5). REMESH IS DEFERRED to the streaming loop:
   * phase "ready" -> "data" (the next `update()` ring re-meshes it with current voxels + rims;
   * the edited chunk is always within reach -> ring 0/1, highest priority); phase "meshing" ->
   * only `dirty` (the in-flight result is dropped in `_onMeshReady` and the loop remeshes after
   * -- "exactly ONE valid mesh wins"). Deliberately NOT the cross-thread 3x3 view of M5: every
   * re-dispatch is an independent local `MeshClient.mesh` with fresh buffers, the worker stays
   * edit-unaware by construction.
   *
   * `id = 0` is BLOCK_AIR (break). Out-of-band Y (outside the 16-column height) or an unloaded
   * column is a no-op (returns false) -- a raycast can never target unloaded cells, because
   * unloaded columns read as air.
   */
  public setBlock(wx: number, wy: number, wz: number, id: number): boolean {
    if (wy < 0 || wy >= CHUNK_SIZE) return false;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const rec = this._chunks.get(keyOf(cx, cz));
    if (!rec?.chunk) return false;
    const lx = ((Math.floor(wx) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((Math.floor(wz) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const current = rec.chunk.getBlock(lx, Math.floor(wy), lz);
    if (current === id) return false;
    rec.chunk.setBlock(lx, Math.floor(wy), lz, id);
    this._editCount++;
    // M3 delta tracking: remember the edited cell (local linear index) so it can be persisted on
    // eviction. Last-write-wins -- a later edit of the same cell overwrites the earlier entry.
    rec.deltas.set(rec.chunk.indexOf(lx, Math.floor(wy), lz), id);
    void this._persistSeed();
    this._scheduleRemesh(cx, cz, lx, lz);
    return true;
  }

  public getStats(): ChunkWorldStats {
    let generated = 0;
    let inFlight = 0;
    let ready = 0;
    let voxelChunksRetained = 0;
    for (const rec of this._chunks.values()) {
      if (rec.phase === "generating" || rec.phase === "meshing") inFlight++;
      if (rec.phase === "data" || rec.phase === "meshing" || rec.phase === "ready") generated++;
      if (rec.phase === "ready") ready++;
      if (rec.chunk !== null) voxelChunksRetained++;
    }
    return {
      generated,
      inFlight,
      ready,
      voxelChunksRetained,
      meshMsLast: this._meshMsLast,
      meshMsTotal: this._meshMsTotal,
      edits: this._editCount,
      persistCount: this._persistCount,
      persistBytes: this._persistBytes,
    };
  }

  public destroy(): void {
    for (const rec of this._chunks.values()) {
      if (rec.hosted) this._callbacks.onUnload(rec.cx, rec.cz);
      this._saveDelta(rec); // M3: persist edited cells even on hard teardown
    }
    this._chunks.clear();
    this._client.destroy();
  }

  /**
   * M3 durability (D3): eagerly persists every loaded chunk's edit-deltas (loaded edits are
   * re-stored idempotently; new edits are saved once) and waits for all in-flight writes +
   * the seed record. Used by the pagehide/visibilitychange flush path in the host app and by
   * the QA gate to prove persistence across reload.
   */
  public async persistAll(): Promise<void> {
    for (const rec of this._chunks.values()) this._saveDelta(rec);
    await this._persistSeed();
    await this.flushStore();
  }

  /** Waits for every currently in-flight delta write and the driver's durability barrier. */
  public async flushStore(): Promise<void> {
    const store = this._store;
    if (!store) return;
    await Promise.allSettled([...this._pendingSaves]);
    await store.flush();
  }

  // --- internals ---

  private _requestGenerate(cx: number, cz: number): void {
    const rec: ChunkRecord = {
      cx,
      cz,
      phase: "generating",
      chunk: null,
      hosted: false,
      dirty: false,
      deltas: new Map(),
    };
    this._chunks.set(keyOf(cx, cz), rec);
    this._client
      .generate(cx, cz)
      .then((data) => this._onData(cx, cz, data))
      .catch((err: unknown) => this._onError(cx, cz, err));
  }

  private _requestReloadVoxels(rec: ChunkRecord): void {
    rec.reloadingVoxels = true;
    this._client
      .generate(rec.cx, rec.cz)
      .then((data) => this._onVoxelsReloaded(rec, data))
      .catch((err: unknown) => {
        rec.reloadingVoxels = false;
        console.warn(`[ChunkWorld] failed to reload voxels for (${rec.cx}, ${rec.cz}):`, err);
      });
  }

  private _onVoxelsReloaded(rec: ChunkRecord, data: Uint8Array): void {
    if (this._chunks.get(keyOf(rec.cx, rec.cz)) !== rec) return;
    const chunk = new Chunk();
    chunk.voxels.set(data);
    for (const [index, id] of rec.deltas) {
      const coords = ChunkWorld._localCoordsOf(index);
      chunk.setBlock(coords.x, coords.y, coords.z, id);
    }
    rec.chunk = chunk;
    rec.voxelEvicted = false;
    rec.reloadingVoxels = false;
  }

  /** Generates a column and, once the stored edit-delta has been reapplied on top of the
   *  regenerated terrain, hands it to the mesher. The worker stays the ONLY source of mesh
   *  geometry -- it simply receives the COMPOSED voxels (generated + edits), exactly as in M1/M2.
   *
   *  The record stays in phase "generating" while the async store read runs, so the streaming
   *  loop can never dispatch a premature mesh of the un-edited column. If the chunk is evicted
   *  while the read is in flight, its (now complete) deltas are persisted and the mesh is
   *  skipped -- nothing is lost. */
  private async _onData(cx: number, cz: number, data: Uint8Array): Promise<void> {
    const rec = this._chunks.get(keyOf(cx, cz));
    if (!rec || rec.phase !== "generating") return; // evicted meanwhile
    const chunk = new Chunk();
    chunk.voxels.set(data);
    rec.chunk = chunk;
    await this._applyStoredEdits(cx, cz, rec);
    if (this._chunks.get(keyOf(cx, cz)) !== rec) {
      // Evicted (and possibly re-requested) while the store read was in flight -- persist the
      // fully applied edits of this record and skip meshing the stale instance.
      this._saveDelta(rec);
      void this._persistSeed();
      return;
    }
    rec.phase = "data";
    // Try to mesh this chunk (neighbors may already be ready) and unblock any neighbor that was
    // waiting on OUR data.
    this._tryMesh(cx, cz, rec);
    for (const [dx, dz] of MESH_NEIGHBORS) {
      const nrec = this._chunks.get(keyOf(cx + dx, cz + dz));
      if (nrec && nrec.phase === "data") this._tryMesh(cx + dx, cz + dz, nrec);
    }
  }

  /** Loads and applies (cx,cz)'s stored edit-delta onto the freshly generated voxels (M3 D3).
   *  Cells already touched by a NEWER local edit (post-generation) are left alone -- a mount-time
   *  edit must never be clobbered by older persisted data. Foreign/corrupt payloads or store
   *  errors are dropped with a warning: a storage hiccup must not block the world (fail-soft). */
  private async _applyStoredEdits(cx: number, cz: number, rec: ChunkRecord): Promise<void> {
    const store = this._store;
    const chunk = rec.chunk;
    if (!store || !chunk) return;
    let payload: Uint8Array | null;
    try {
      payload = await store.loadChunkDelta(cx, cz);
    } catch (err: unknown) {
      console.warn(
        `[ChunkWorld] store read failed for (${cx}, ${cz}), building from terrain:`,
        err,
      );
      return;
    }
    if (payload === null) return;
    const data = tryDecode(payload);
    if (data === null) {
      console.warn(
        `[ChunkWorld] discarding stored delta for (${cx}, ${cz}): foreign version or corrupt payload`,
      );
      return;
    }
    if (data.seed !== this._seed) {
      console.warn(
        `[ChunkWorld] discarding stored delta for (${cx}, ${cz}): seed mismatch (${data.seed} !== ${this._seed})`,
      );
      return;
    }
    let applied = 0;
    for (const edit of data.edits) {
      const index = chunk.indexOf(edit.x, edit.y, edit.z);
      if (rec.deltas.has(index)) continue; // a newer local edit already owns this cell
      chunk.setBlock(edit.x, edit.y, edit.z, edit.id);
      rec.deltas.set(index, edit.id);
      applied++;
    }
    if (applied > 0) {
      console.info(`[ChunkWorld] reapplied ${applied} stored edits on (${cx}, ${cz})`);
    }
  }

  /** M2 edit remesh scheduling (see `setBlock`): own chunk + every horizontal neighbor whose rim
   *  plane contains the edited local cell. A corner cell touches two neighbors; a pure-interior
   *  cell touches none. A "data"/"generating" mate needs no action -- its future mesh reads the
   *  already-current voxels, so it is correct by construction. */
  private _scheduleRemesh(cx: number, cz: number, lx: number, lz: number): void {
    const schedule = (x: number, z: number): void => {
      const rec = this._chunks.get(keyOf(x, z));
      if (!rec?.chunk) return;
      if (rec.phase === "ready") {
        rec.phase = "data"; // streaming loop remeshes it next tick
      } else if (rec.phase === "meshing") {
        rec.dirty = true; // in-flight result must not apply stale geometry
      }
    };
    schedule(cx, cz);
    if (lx === 0) schedule(cx - 1, cz);
    if (lx === CHUNK_SIZE - 1) schedule(cx + 1, cz);
    if (lz === 0) schedule(cx, cz - 1);
    if (lz === CHUNK_SIZE - 1) schedule(cx, cz + 1);
    // Corner edits also touch the single diagonal neighbor whose AO corner column is (lx, lz).
    if (lx === 0 && lz === 0) schedule(cx - 1, cz - 1);
    if (lx === CHUNK_SIZE - 1 && lz === 0) schedule(cx + 1, cz - 1);
    if (lx === 0 && lz === CHUNK_SIZE - 1) schedule(cx - 1, cz + 1);
    if (lx === CHUNK_SIZE - 1 && lz === CHUNK_SIZE - 1) schedule(cx + 1, cz + 1);
  }

  /**
   * Dispatches a mesh task once the chunk has data AND all EIGHT horizontal neighbors (4 axials
   * for seam culling + 4 diagonals for seam-exact AO corner columns) have data. Returns false
   * while waiting -- the streaming loop retries. This is minNeighborsToMesh, now also the M2 AO
   * seam contract: without the diagonals a 4-chunk-corner vertex could only approximate its AO
   * sample, which would show as a bright leak exactly on the seam plane it is meant to hide.
   */
  private _tryMesh(cx: number, cz: number, rec: ChunkRecord): boolean {
    if (rec.phase !== "data" || !rec.chunk) return false;
    const rims: Partial<Record<FaceDir, Uint8Array>> = {};
    const corners: Partial<Record<CornerDir, Uint8Array>> = {};
    for (const [dx, dz] of MESH_NEIGHBORS) {
      const nrec = this._chunks.get(keyOf(cx + dx, cz + dz));
      if (!nrec?.chunk) return false; // not all neighbors have data yet -- wait (minNeighborsToMesh)
      if (dx === 0 || dz === 0) {
        const dir = rimDirForNeighbor(dx, dz);
        rims[dir] = buildNeighborRim(nrec.chunk.voxels, dir);
      } else {
        const dir = cornerDirForNeighbor(dx, dz);
        corners[dir] = buildNeighborCorner(nrec.chunk.voxels, dir);
      }
    }
    rec.phase = "meshing";
    const voxels = rec.chunk.voxels;
    this._client
      .mesh(cx, cz, voxels, rims, corners)
      .then((outcome: MeshOutcome) => this._onMeshReady(cx, cz, outcome))
      .catch((err: unknown) => this._onError(cx, cz, err));
    return true;
  }

  private _onMeshReady(cx: number, cz: number, outcome: MeshOutcome): void {
    const rec = this._chunks.get(keyOf(cx, cz));
    if (!rec || rec.phase !== "meshing") return;
    if (rec.dirty) {
      // The voxels were edited while this mesh was in flight -> the result is stale relative to
      // the current data. Do not apply it; hand the chunk back to the streaming loop, which
      // remeshes it with the edited data (dirty flag cleared -- "exactly ONE valid mesh wins").
      rec.dirty = false;
      rec.phase = "data";
      return;
    }
    rec.phase = "ready";
    rec.hosted = true;
    this._meshMsLast = outcome.meshMs;
    this._meshMsTotal += outcome.meshMs;
    this._callbacks.onMeshReady(cx, cz, outcome.mesh);
  }

  private _onError(cx: number, cz: number, err: unknown): void {
    // Keep the world robust: unload any previously hosted node and persist pending edit deltas
    // before dropping the record so the next tick can regenerate it cleanly without leaking
    // scene nodes or losing player edits.
    const key = keyOf(cx, cz);
    const rec = this._chunks.get(key);
    if (rec) {
      if (rec.hosted) this._callbacks.onUnload(rec.cx, rec.cz);
      this._saveDelta(rec);
      this._chunks.delete(key);
    }
    console.warn(`[ChunkWorld] task failed for chunk (${cx}, ${cz}):`, err);
  }

  /** Inverse of `Chunk.indexOf` (M3 delta persistence): local linear index -> local (x,y,z). */
  private static _localCoordsOf(index: number): { x: number; y: number; z: number } {
    const x = index % CHUNK_SIZE;
    const z = Math.floor(index / CHUNK_SIZE) % CHUNK_SIZE;
    const y = Math.floor(index / (CHUNK_SIZE * CHUNK_SIZE));
    return { x, y, z };
  }

  /** Serializes and queues a chunk's edit-deltas for storage (fire-and-forget; awaited by
   *  `persistAll`/`flushStore`). No-op when there is no store or nothing was edited. Re-saving a
   *  chunk that was merely loaded and left untouched is idempotent */
  private _saveDelta(rec: ChunkRecord): void {
    const store = this._store;
    if (!store || rec.deltas.size === 0) return;
    const edits: ChunkDeltaEdit[] = [];
    for (const [index, id] of rec.deltas) {
      const { x, y, z } = ChunkWorld._localCoordsOf(index);
      edits.push({ x, y, z, id });
    }
    const payload = encodeChunkDelta(this._seed, edits);
    const tracked: Promise<void> = store.saveChunkDelta(rec.cx, rec.cz, payload).then(
      () => {
        this._persistCount++;
        this._persistBytes += payload.length;
      },
      (err: unknown) => {
        console.warn(`[ChunkWorld] delta save failed for (${rec.cx}, ${rec.cz}):`, err);
      },
    );
    this._pendingSaves.add(tracked);
    void tracked.finally(() => this._pendingSaves.delete(tracked));
  }

  /** Single-flight persistence of the world seed (D3b), so a relaunch rebuilds the same world.
   *  Called lazily on the first edit / delta save; awaited by `persistAll`. Failures re-arm so a
   *  later edit retries instead of silently losing the seed. */
  private _persistSeed(): Promise<void> | null {
    const store = this._store;
    if (!store) return null;
    if (this._seedPersist) return this._seedPersist;
    this._seedPersist = Promise.resolve(store.setSeed(this._seed)).then(
      () => {
        this._seedPersist = null;
      },
      (err: unknown) => {
        this._seedPersist = null;
        console.warn("[ChunkWorld] seed persist failed:", err);
      },
    );
    return this._seedPersist;
  }
}
