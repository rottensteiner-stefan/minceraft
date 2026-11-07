import {
  CameraStrategyType,
  Color,
  Cube,
  getRendererTypeFromQuery,
  Object3D,
  PerspectiveProjection,
  RendererType,
  SmallWorldMachine,
} from "@small-world-machine/engine";
import {
  BlockRegistry,
  BLOCK_DIRT,
  BLOCK_GRASS,
  BLOCK_STONE,
  BLOCK_WATER,
  BLOCK_WOOD,
} from "./voxel/BlockRegistry.js";
import { ChunkWorld } from "./voxel/ChunkWorld.js";
import { ChunkWorldHost } from "./voxel/ChunkWorldHost.js";
import { createBlockAtlas2D, createBlockPalette } from "./voxel/BlockTextureFactory.js";
import { BlockMaterial } from "./voxel/material/BlockMaterial.js";
import { descriptorFromRegistry } from "./voxel/mesh/NaiveMesher.js";
import { TerrainGenerator } from "./voxel/TerrainGenerator.js";
import type { ChunkDeltaStore } from "./voxel/store/ChunkDeltaStore.js";
import { IndexedDbChunkDeltaStore } from "./voxel/store/IndexedDbChunkDeltaStore.js";
import { OpfsChunkDeltaStore } from "./voxel/store/OpfsChunkDeltaStore.js";
import { DayNightCycle } from "./voxel/environment/DayNightCycle.js";
import { SkyMaterial } from "./voxel/environment/SkyMaterial.js";
import { PlayerRig } from "./voxel/player/PlayerRig.js";
import { VoxelInputActions } from "./voxel/input/VoxelInputActions.js";
import { VoxelBlockEditor } from "./voxel/physics/VoxelBlockEditor.js";
import { VoxelPlayerCollision } from "./voxel/physics/VoxelPlayerCollision.js";
import { ForegroundMeshClient } from "./voxel/worker/ForegroundMeshClient.js";
import { MeshWorkerPoolClient } from "./voxel/worker/MeshWorkerPoolClient.js";
import type { MeshClient } from "./voxel/worker/MeshWorkerProtocol.js";

/**
 * Voxel M1+M2 (dossier §4.2, §5 S2): first-person player STANDING on generated terrain that
 * streams around him, now with CC0 block-texture atlas, break/place editing and Minceraft-style
 * baked AO:
 *
 *   - `TerrainGenerator` (seeded, deterministic) + `ChunkWorld` (pure streaming/lifecycle core).
 *   - Meshing runs on a small pool of dedicated Vite module workers (`MeshWorkerPoolClient`, M7;
 *     `?workers=N` pins the arena count); the main thread ONLY decides and dispatches -- proof in
 *     the stats overlay (`mesh total` grows, worker-side `performance.now()` time, never a
 *     main-thread mesher call).
 *   - Neighbor-aware culling (`buildNeighborRim`) makes chunk borders seamless (pinned by the
 *     seam tests); the host materializes each outcome as the standard "one Object3D per chunk".
 *   - `VoxelPlayerCollision` (app-level Behavior) runs the Luanti-derived swept AABB resolver
 *     against the world: gravity, ground stand, wall slide -- the M1 gate's "player STANDS".
 *   - M2: `VoxelBlockEditor` targets the FPS crosshair (pure DDA), LMB breaks / RMB places with
 *     Digit1..5 hand selection; edits trigger a bounded local 1-chunk remesh (own + rim-touching
 *     neighbors), the atlas is CC0 (see `voxel/palette/AtlasPixels.ts`), AO is baked per vertex
 *     and water renders transparent.
 *
 * Backend: WebGPU where available, else WebGL2 (the block and sky materials ship WGSL and GLSL300,
 * M6); `?rendererType=WEB_GL2|WEB_GPU` pins one. WebGL1 falls back to a fully playable tier: a
 * 2D-atlas block material + a simplified GLSL100 sky (tiered-renderer autonomy, no feature parity
 * cap -- see `docs/log.md`).
 * Dev params: `?time=<0..1>` pins the time of day, `?look=<yaw>,<pitch>` turns the start view,
 * `?moon=<0..1>` pins the scenic moon phase (0 = new, 0.5 = full) for captures, `?workers=N` pins
 * the pool size (>= 1).
 */
export class App extends SmallWorldMachine {
  private _statsEl: HTMLElement | null = null;
  private _flashEl: HTMLElement | null = null;
  private _deathEl: HTMLElement | null = null;
  private _healthEl: HTMLElement | null = null;
  private _hotbarEl: HTMLElement | null = null;
  private _btnRespawn: HTMLElement | null = null;
  private _lastStatsUpdate = 0;
  private _isBenchmark: boolean = false;
  private readonly _frameTimes: number[] = [];

  private _world!: ChunkWorld;
  private _host!: ChunkWorldHost;
  private _player!: VoxelPlayerCollision;
  private _editor!: VoxelBlockEditor;
  private _inputActions!: VoxelInputActions;
  private _material!: BlockMaterial;
  private _dayNight!: DayNightCycle;
  private _sky!: SkyMaterial;
  private _time: number = 0;
  private _rig!: PlayerRig;
  private _clearColor: Color = new Color(0.45, 0.65, 0.95, 1);
  private _store: ChunkDeltaStore | null = null;
  /** Active persistence backend label ("opfs" | "indexeddb" | "none") -- QA/gate proof. */
  private _storeBackend: string = "none";
  /** M7 worker pool (null in foreground-degraded environments) -- stats/QA proof of the pool. */
  private _pool: MeshWorkerPoolClient | null = null;

  constructor() {
    // The block and sky materials ship WGSL (array texture, M6) and GLSL300, so WebGPU is used
    // where available and WebGL2 elsewhere; `?rendererType=` pins a backend. WebGL1 (fallback) is
    // handled in `setupScene`, which selects the 2D-atlas material + simplified sky per the tier.
    const rendererType = getRendererTypeFromQuery();
    super({ fullscreen: true, rendererType: rendererType ?? RendererType.BEST });
    const urlParams =
      typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    this._isBenchmark = urlParams?.has("benchmark") ?? urlParams?.has("stats") ?? false;
  }

  /** @inheritdoc */
  protected override async setupScene(): Promise<void> {
    this._statsEl = document.getElementById("voxel-stats");
    this._flashEl = document.getElementById("damage-flash");
    this._deathEl = document.getElementById("death-screen");
    this._healthEl = document.getElementById("voxel-health");
    this._hotbarEl = document.getElementById("voxel-hotbar");
    this._btnRespawn = document.getElementById("btn-respawn");

    // 1. Perspective projection; far plane covers the streaming radius with margin.
    this.camera.projection = new PerspectiveProjection({
      fov: (75 * Math.PI) / 180,
      aspect: this.camera.aspect,
      near: 0.1,
      far: 500,
    });
    this.camera.updateProjectionMatrix();
    this.camera.setStrategy(CameraStrategyType.FPS);

    // 2. Registry (seeded, per-instance -- no singleton) + its transferable descriptor.
    const registry = new BlockRegistry();
    BlockRegistry.seed(registry);
    const descriptor = descriptorFromRegistry(registry);

    // 3. Palette + shared material -- ONE BlockMaterial instance for every chunk host. WebGPU and
    // WebGL2 use the array-texture palette (WGSL / GLSL300); WebGL1 has no array textures and gets
    // the 2D-atlas palette + GLSL100 sources instead (`createBlockAtlas2D` + `setAtlasGrid`), so
    // the game stays fully playable on every backend (tiered-renderer autonomy, `docs/log.md`).
    const isWebGl1 = this.renderer?.type === RendererType.WEB_GL1;
    if (isWebGl1) {
      const atlas = createBlockAtlas2D();
      const material = new BlockMaterial(atlas.texture);
      material.setAtlasGrid(atlas.cols, atlas.rows);
      this._material = material;
    } else {
      const palette = await createBlockPalette();
      this._material = new BlockMaterial(palette);
    }

    // M4 Day/Night cycle controller. `?time=<0..1>` pins the time of day (0 sunrise, 0.25 noon,
    // 0.5 sunset, 0.75 midnight) instead of letting it run, `?look=<yaw>,<pitch>` (degrees) turns
    // the start view: reproducible frames of the sky for captures and for tuning it.
    const query = new URLSearchParams(window.location.search);
    const pinnedTime = Number(query.get("time"));
    this._dayNight =
      query.has("time") && Number.isFinite(pinnedTime)
        ? new DayNightCycle({ cycleDuration: 0, initialTime: pinnedTime })
        : new DayNightCycle({ cycleDuration: 120 });
    const look = (query.get("look") ?? "").split(",").map(Number);
    if (look.length === 2 && look.every(Number.isFinite)) {
      this.camera.theta = (look[0]! * Math.PI) / 180;
      this.camera.phi = (look[1]! * Math.PI) / 180;
    }
    // `?moon=<0..1>` pins the scenic moon phase (0 = new, 0.5 = full, 1 = new) for reproducible
    // captures of the phase terminator; `?time=`/`?look=` keep their roles. Deterministic.
    const pinnedMoon = Number(query.get("moon"));
    if (query.has("moon") && Number.isFinite(pinnedMoon)) {
      this._dayNight.pinMoonPhase(pinnedMoon);
    }

    // M6 procedural sky: a cube that follows the camera (gradient, sun, moon, stars).
    this._sky = new SkyMaterial();
    const skyDome = new Object3D("Sky");
    skyDome.geometry = new Cube({ size: 2 }).getGeometryData();
    skyDome.material = this._sky;
    skyDome.frustumCulled = false;
    this.scene.add(skyDome);

    // 4. World backbone (M7): production uses a small pool of dedicated mesh workers (N = default
    //    hardware-derived arena count, or `?workers=N` to pin one -- pools of 1 behave exactly
    //    like the M1 single worker). A browser without `Worker` degrades to the foreground double
    //    (meshing would run on main -- stats show the label).
    const client: MeshClient =
      typeof Worker !== "undefined" ? this._createWorkerClient() : new ForegroundMeshClient();
    this._host = new ChunkWorldHost(this.scene, this._material);
    // M3 persistence (D2/D3): edit-delta store behind the interface. M7 prefers the OPFS driver
    // (dedicated per-origin file system, secure contexts only); the IndexedDB driver stays as the
    // honest fallback, and "no persistence" when neither exists -- a browser without storage never
    // crashes the world (offline/workers-only contexts degrade gracefully).
    try {
      this._store = new OpfsChunkDeltaStore();
      this._storeBackend = "opfs";
    } catch (err: unknown) {
      console.warn("[minceraft] OPFS unavailable, falling back to IndexedDB:", err);
      try {
        this._store = new IndexedDbChunkDeltaStore();
        this._storeBackend = "indexeddb";
      } catch (err2: unknown) {
        console.warn("[minceraft] IndexedDB unavailable, persistence disabled:", err2);
        this._store = null;
        this._storeBackend = "none";
      }
    }
    this._world = new ChunkWorld({
      client,
      descriptor,
      seed: WORLD_SEED,
      ...(this._store ? { store: this._store } : {}),
      generateRadius: GENERATE_RADIUS,
      unloadRadius: GENERATE_RADIUS + 2, // hysteresis: > generateRadius (ChunkWorld invariant)
      callbacks: {
        onMeshReady: (cx, cz, mesh): void => this._host.onMeshReady(cx, cz, mesh),
        onUnload: (cx, cz): void => this._host.onUnload(cx, cz),
      },
    });
    // M3 auto-save (D3): durability flush when the tab hides/closes. Save-on-evict already runs
    // in the streaming loop; this is the pagehide/visibilitychange barrier on top of it.
    const flush = (): void => {
      void this._world.persistAll();
    };
    document.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flush();
    });

    // 5. Semantic input actions (composite bindings: Mouse + Trackpad + Gamepad).
    this._inputActions = new VoxelInputActions({ input: this.input });

    // M4 Survival Player Rig
    this._rig = new PlayerRig({
      onDamage: (): void => {
        if (this._flashEl) {
          this._flashEl.style.opacity = "1";
          setTimeout((): void => {
            if (this._flashEl) this._flashEl.style.opacity = "0";
          }, 180);
        }
      },
      onDeath: (): void => {
        if (this._deathEl) this._deathEl.style.display = "flex";
        if (this.input.isPointerLocked) {
          document.exitPointerLock();
        }
      },
      onRespawn: (): void => {
        if (this._deathEl) this._deathEl.style.display = "none";
      },
    });

    const doRespawn = (): void => {
      if (!this._rig.isDead) return;
      this._doRespawn();
    };
    this._btnRespawn?.addEventListener("click", doRespawn);
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (this._rig.isDead && (e.code === "Space" || e.code === "Enter")) {
        doRespawn();
      }
    });

    // 6. Player: FPS look via the FPS strategy, feet standing on the generated surface.
    const generator = new TerrainGenerator({ seed: WORLD_SEED });
    const surface = generator.heightAt(Math.floor(SPAWN_X), Math.floor(SPAWN_Z)); // topmost solid y
    this._player = new VoxelPlayerCollision({
      world: this._world,
      input: this.input,
      actions: this._inputActions,
      rig: this._rig,
      autoJump: true,
    });
    this._player.setSpawn(SPAWN_X, surface + 1, SPAWN_Z); // feet on top of the grass cap
    this.camera.addBehavior(this._player);

    // 7. Block editor (M2): aim + LMB/RMB (or Trackpad F/E/R) + Digit1..5/wheel selection.
    this._editor = new VoxelBlockEditor({
      world: this._world,
      input: this.input,
      actions: this._inputActions,
      rig: this._rig,
      placementBlocker: (x, y, z): boolean => this._player.overlapsCell(x, y, z),
    });
    this.camera.addBehavior(this._editor);
    this._installQaHook();

    // 8. Pointer lock on click (engine FPS convention, see showcases 2/10/29).
    this.canvas.addEventListener("click", (): void => {
      if (!this.input.isPointerLocked && !this._rig.isDead) {
        this.input.requestPointerLock(this.canvas);
      }
    });

    this.scene.update();
    this._syncDaylight();
    this._updateHud();
    this._updateStats(true);
  }

  /** @inheritdoc */
  protected override update(deltaTime: number): void {
    const dtMs = deltaTime * 1000;
    this._frameTimes.push(dtMs);
    if (this._frameTimes.length > 120) this._frameTimes.shift();

    this._inputActions.update(deltaTime);

    // M4 Day/Night cycle
    this._dayNight.update(deltaTime);
    this._time += deltaTime;
    this._syncDaylight();

    this._updateHud();
    this._updateStats(false);
  }

  private _syncDaylight(): void {
    const daylight = this._dayNight.getDaylight();
    const sunDir = this._dayNight.getSunDirection();
    this._material.setDaylight(daylight);
    this._material.setSunDirection(sunDir);
    const tint = this._dayNight.getLightTint();
    this._material.setLightTint(tint.r, tint.g, tint.b);

    this._sky.setSun(this._dayNight.getSkySunDirection(), this._dayNight.getStarVisibility());
    this._sky.setGradient(this._dayNight.getHorizonColor(), this._dayNight.getZenithColor());
    this._sky.setTime(this._time);
    this._sky.setAtmosphere(
      this._dayNight.getCloudCover(),
      this._dayNight.getMoonPhase(),
      this._dayNight.getHazeStrength(),
    );

    const sky = this._dayNight.getSkyColor();
    this._clearColor.r = sky.r;
    this._clearColor.g = sky.g;
    this._clearColor.b = sky.b;
    this.renderer?.setClearColor(this._clearColor);
  }

  private _doRespawn(): void {
    this._rig.respawn();
    const generator = new TerrainGenerator({ seed: WORLD_SEED });
    const surface = generator.heightAt(Math.floor(SPAWN_X), Math.floor(SPAWN_Z));
    this._player.setSpawn(SPAWN_X, surface + 1, SPAWN_Z);
    if (this._deathEl) this._deathEl.style.display = "none";
    if (!this.input.isPointerLocked) {
      this.input.requestPointerLock(this.canvas);
    }
  }

  private _updateHud(): void {
    if (this._healthEl) {
      const hp = this._rig.health;
      let hearts = "";
      for (let i = 0; i < 10; i++) {
        const threshold = (i + 1) * 2;
        if (hp >= threshold) {
          hearts += "❤️";
        } else if (hp >= threshold - 1) {
          hearts += "💔";
        } else {
          hearts += "🖤";
        }
      }
      this._healthEl.textContent = `${hearts} ${hp}/20`;
    }

    if (this._hotbarEl) {
      const activeIdx = this._editor.handIndex;
      const slots = this._hotbarEl.children;
      for (let i = 0; i < slots.length; i++) {
        const el = slots[i] as HTMLElement;
        if (i === activeIdx) {
          el.classList.add("active");
        } else {
          el.classList.remove("active");
        }
      }
    }
  }

  /**
   * Minimal QA surface for the headless live gate (`check-voxel-m1.mjs`, showcase24 pattern):
   * structured reads of the player body and the world stats without parsing CSS/HTML text.
   * Inert for normal usage (a single property on `window`).
   */
  private _installQaHook(): void {
    (window as unknown as { __voxelM1?: VoxelM1QaApi }).__voxelM1 = {
      getPlayer: (): PlayerQaState => {
        const feet = this._player.getFeetPosition(); // fresh object; safe to hand out
        return { feet, onGround: this._player.isOnGround() };
      },
      getStats: (): WorldQaStats => {
        const s = this._world.getStats();
        return {
          ready: s.ready,
          generated: s.generated,
          inFlight: s.inFlight,
          voxelChunksRetained: s.voxelChunksRetained,
          meshMsLast: s.meshMsLast,
          meshMsTotal: s.meshMsTotal,
          edits: s.edits,
          persistCount: s.persistCount,
          persistBytes: s.persistBytes,
          workers: this._pool ? this._pool.workerCount : 0,
          focus: this._world.getFocusChunk(),
        };
      },
      getTelemetry: (): VoxelTelemetry => {
        const s = this._world.getStats();
        const n = this._frameTimes.length;
        const sum = n > 0 ? this._frameTimes.reduce((a, b) => a + b, 0) : 16.6;
        const avgDt = n > 0 ? sum / n : 16.6;
        const fps = avgDt > 0 ? Math.round(1000 / avgDt) : 60;
        let minDt = 0;
        for (const dt of this._frameTimes) {
          if (dt > minDt) minDt = dt;
        }
        const fpsMin = minDt > 0 ? Math.round(1000 / minDt) : 60;
        return {
          fps,
          fpsAvg: fps,
          fpsMin,
          frameTimeMsAvg: Number(avgDt.toFixed(2)),
          drawCalls: this.scene.lastFrustumVisibleObjects.length,
          triangles: this._host.triangleCount,
          chunksReady: s.ready,
          voxelChunksRetained: s.voxelChunksRetained,
          cpuVoxelMemoryKb: s.voxelChunksRetained * 4,
          meshMsAvg: s.ready > 0 ? Number((s.meshMsTotal / s.ready).toFixed(2)) : 0,
          meshMsTotal: Number(s.meshMsTotal.toFixed(1)),
          isBenchmark: this._isBenchmark,
        };
      },
      // M2 editing reads/writes for the headless gate (deterministic, no mouse-aim juggling).
      getWorldBlock: (x: number, y: number, z: number): number =>
        this._world.getWorldBlock(x, y, z),
      setBlock: (x: number, y: number, z: number, id: number): boolean =>
        this._world.setBlock(x, y, z, id),
      getHand: (): number => this._editor.getHand(),
      // M3 persistence + light reads for the headless gate.
      getLightFactor: (x: number, y: number, z: number): number =>
        this._world.lightFactorAt(x, y, z),
      forcePersist: (): Promise<{ persistCount: number; persistBytes: number }> =>
        this._world.persistAll().then(() => {
          const s = this._world.getStats();
          return { persistCount: s.persistCount, persistBytes: s.persistBytes };
        }),
      getStoredSeed: async (): Promise<number | null> =>
        this._store ? this._store.getSeed() : null,
      getStoreBackend: (): string => this._storeBackend,
      // M4 survival & day/night reads/controls
      getHealth: (): number => this._rig.health,
      isDead: (): boolean => this._rig.isDead,
      takeDamage: (amount: number): void => this._rig.takeDamage(amount),
      respawn: (): void => this._doRespawn(),
      getDaylight: (): number => this._dayNight.getDaylight(),
      getTimePhase: (): string => this._dayNight.getTimePhase(),
      getMoonPhase: (): number => this._dayNight.getMoonPhase(),
      setTime: (t: number): void => {
        this._dayNight.setTime(t);
        this._syncDaylight();
      },
      // Camera readability for the headless gates: where the camera is and where it looks
      // (degrees) -- proves the `?look=` dev param and the spawn view without parsing UIs.
      getCamera: (): { position: { x: number; y: number; z: number }; thetaDeg: number; phiDeg: number } => {
        const p = this.camera.position;
        return {
          position: { x: p.x, y: p.y, z: p.z },
          thetaDeg: (this.camera.theta * 180) / Math.PI,
          phiDeg: (this.camera.phi * 180) / Math.PI,
        };
      },
    };
  }

  /** M7: builds the worker-pool transport. `?workers=N` pins the arena count (>= 1); without it
   *  the pool derives the count from the hardware. The first worker is created synchronously so a
   *  spawn failure surfaces here (the caller falls back to `ForegroundMeshClient`). */
  private _createWorkerClient(): MeshClient {
    const query = new URLSearchParams(window.location.search);
    const pinned = Number(query.get("workers"));
    const workerCount =
      query.has("workers") && Number.isInteger(pinned) && pinned >= 1 ? pinned : undefined;
    const pool = new MeshWorkerPoolClient(workerCount !== undefined ? { workerCount } : undefined);
    this._pool = pool;
    return pool;
  }

  private _updateStats(force: boolean): void {
    if (!this._statsEl) return;
    const now = performance.now();
    if (!force && now - this._lastStatsUpdate < 250) return;
    this._lastStatsUpdate = now;
    const renderer = this.renderer;
    const backend = renderer ? renderer.type : "n/a";
    const stats = this._world.getStats();
    const feet = this._player.getFeetPosition();
    const workerMode =
      typeof Worker !== "undefined"
        ? this._pool
          ? `dedicated worker pool (${this._pool.workerCount})`
          : "dedicated worker"
        : "foreground (main!)";
    const n = this._frameTimes.length;
    const sum = n > 0 ? this._frameTimes.reduce((a, b) => a + b, 0) : 16.6;
    const avgDt = n > 0 ? sum / n : 16.6;
    const fps = avgDt > 0 ? Math.round(1000 / avgDt) : 60;

    this._statsEl.innerHTML =
      `<div class="stat-row"><span>renderer</span><b>${backend}</b></div>` +
      `<div class="stat-row"><span>engine</span><b>voxel M7 (pool + Greedy + S4)</b></div>` +
      `<div class="stat-row"><span>fps</span><b>${fps} (${avgDt.toFixed(1)} ms)</b></div>` +
      `<div class="stat-row"><span>day / phase</span><b>${this._dayNight.getTimePhase()} (${(this._dayNight.time * 24).toFixed(1)}h)</b></div>` +
      `<div class="stat-row"><span>daylight</span><b>${(this._dayNight.getDaylight() * 100).toFixed(0)}%</b></div>` +
      `<div class="stat-row"><span>health</span><b>${this._rig.health} / 20 HP</b></div>` +
      `<div class="stat-row"><span>player</span><b>${feet.x.toFixed(1)}, ${feet.y.toFixed(1)}, ${feet.z.toFixed(1)}</b></div>` +
      `<div class="stat-row"><span>grounded</span><b>${this._player.isOnGround() ? "yes" : "no"}</b></div>` +
      `<div class="stat-row"><span>hand</span><b>${this._blockName(this._editor.getHand())}</b></div>` +
      `<div class="stat-row"><span>edits</span><b>${stats.edits}</b></div>` +
      `<div class="stat-row"><span>Δ saved (session)</span><b>${stats.persistCount} / ${(stats.persistBytes / 1024).toFixed(1)} KB</b></div>` +
      `<div class="stat-row"><span>chunks ready</span><b>${stats.ready}</b></div>` +
      `<div class="stat-row"><span>voxels in RAM</span><b>${stats.voxelChunksRetained} (~${stats.voxelChunksRetained * 4} KB)</b></div>` +
      `<div class="stat-row"><span>chunks data</span><b>${stats.generated}</b></div>` +
      `<div class="stat-row"><span>in flight</span><b>${stats.inFlight}</b></div>` +
      `<div class="stat-row"><span>objects</span><b>${this.scene.lastFrustumVisibleObjects.length}</b></div>` +
      `<div class="stat-row"><span>triangles</span><b>${this._host.triangleCount}</b></div>` +
      `<div class="stat-row"><span>mesh last</span><b>${stats.meshMsLast.toFixed(2)} ms</b></div>` +
      `<div class="stat-row"><span>mesh total</span><b>${stats.meshMsTotal.toFixed(1)} ms</b></div>` +
      `<div class="stat-row"><span>meshing</span><b>${workerMode}</b></div>`;
  }

  private _blockName(id: number): string {
    switch (id) {
      case BLOCK_GRASS:
        return "grass";
      case BLOCK_DIRT:
        return "dirt";
      case BLOCK_STONE:
        return "stone";
      case BLOCK_WOOD:
        return "wood";
      case BLOCK_WATER:
        return "water";
      default:
        return `block ${id}`;
    }
  }
}

/**
 * QA gate state shapes (see `_installQaHook`). Plain serializable data -- evaluated through
 * Puppeteer's structured clone by `.agents/scratches/check-voxel-m1.mjs`.
 */
export interface PlayerQaState {
  feet: { x: number; y: number; z: number };
  onGround: boolean;
}

export interface WorldQaStats {
  ready: number;
  generated: number;
  inFlight: number;
  voxelChunksRetained: number;
  meshMsLast: number;
  meshMsTotal: number;
  edits: number;
  persistCount: number;
  persistBytes: number;
  /** M7: live worker-pool arena count (>= 1 proves the pool, not a single worker, is active). */
  workers: number;
  focus: { cx: number; cz: number };
}

export interface VoxelTelemetry {
  fps: number;
  fpsAvg: number;
  fpsMin: number;
  frameTimeMsAvg: number;
  drawCalls: number;
  triangles: number;
  chunksReady: number;
  voxelChunksRetained: number;
  cpuVoxelMemoryKb: number;
  meshMsAvg: number;
  meshMsTotal: number;
  isBenchmark: boolean;
}

export interface VoxelM1QaApi {
  getPlayer(): PlayerQaState;
  getStats(): WorldQaStats;
  getTelemetry(): VoxelTelemetry;
  getWorldBlock(x: number, y: number, z: number): number;
  setBlock(x: number, y: number, z: number, id: number): boolean;
  getHand(): number;
  getLightFactor(x: number, y: number, z: number): number;
  forcePersist(): Promise<{ persistCount: number; persistBytes: number }>;
  getStoredSeed(): Promise<number | null>;
  /** Active persistence backend label ("opfs" | "indexeddb" | "none") for store-gate proofs. */
  getStoreBackend(): string;
  // M4 Survival & Day/Night extensions
  getHealth(): number;
  isDead(): boolean;
  takeDamage(amount: number): void;
  respawn(): void;
  getDaylight(): number;
  getTimePhase(): string;
  /** Scenic moon phase in [0, 1) (0 = new, 0.5 = full); readable for capture determinism. */
  getMoonPhase(): number;
  setTime(t: number): void;
  /** Camera position + look angles (degrees) -- lets headless gates pin the view without UIs. */
  getCamera(): { position: { x: number; y: number; z: number }; thetaDeg: number; phiDeg: number };
}

/** World seed for deterministic terrain (same seed -> same world; see TerrainGenerator tests). */
const WORLD_SEED = 777;
/** Player spawn column (world units). Streaming centers on the player every frame. */
const SPAWN_X = 20.5;
const SPAWN_Z = 20.5;
/** Streaming add radius in chunks (Chebyshev). Data is generated within it. */
const GENERATE_RADIUS = 6;

if (typeof window !== "undefined") {
  const app: App = new App();
  app.start().catch((err: unknown) => console.error("[minceraft] Failed to start:", err));
}
