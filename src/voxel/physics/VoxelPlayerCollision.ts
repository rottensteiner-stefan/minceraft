import { Behavior, Keys } from "@small-world-machine/engine";
import type { Camera, InputInterface } from "@small-world-machine/engine";
import type { VoxelInputActions } from "../input/VoxelInputActions.js";
import type { PlayerRig } from "../player/PlayerRig.js";
import type { ChunkWorld } from "../ChunkWorld.js";
import type { SweepWorld, Vec3 } from "./VoxelSweep.js";
import { sweepVoxel } from "./VoxelSweep.js";

/**
 * M1 first-person player with voxel-grid collision (dossier §4.4 E2: "Eigener App-seitiger
 * FPS-Behavior"). Runs the swept AABB resolver (`sweepVoxel`) against `ChunkWorld` every frame,
 * bakes the input into a desired planar velocity and feeds the engine's FPS camera strategy.
 *
 * Separation of concerns (M1 architecture):
 *   - PURE collision math stays in `voxel/physics/VoxelSweep.ts` (node-testable, no engine).
 *   - This behavior is thin, engine-coupled GLUE: input -> desired velocity -> sweep -> camera.
 *   - It owns "where the player is", so it is the ONLY place that can center streaming on the
 *     fresh body position: `world.setFocus()` + `world.update()` run here after the sweep
 *     (the engine runs camera behaviors AFTER `App.update`, so centering must happen here or
 *     stream dispatch would lag one frame behind the body -- see `SmallWorldMachine`'s loop).
 *
 * Camera conventions (exact engine parity, see `FPSController` + `FPSStrategy`):
 *   - Mouse-look is NOT applied here: the behavior only accumulates `pendingDx`/`pendingDy`
 *     (raw deltas, only while pointer is locked); the FPS strategy owns theta/phi and applies
 *     its fixed 0.005 sensitivity in `Camera.update`, which the engine calls per frame.
 *   - Forward/strafe math uses `camera.theta` (yaw) with the SAME sign convention as
 *     `FPSController` (W is -1 on the W/S axis, forward is -Z at theta = 0).
 *   - The camera position is set to the player's eye (body feet + `eyeHeight`). Because the
 *     engine passes `camera.target` itself, the FPS strategy does not overwrite the position.
 *
 * The body is a 0.6-wide, 1.8-tall AABB around a feet origin (see `options.body`); gravity is
 * passed as accel into the sweep (the gravity-in-accel model `VoxelSweep` documents). On
 * ground contact the vertical velocity is zeroed -- the Luanti-style "standing still" state.
 */

/** Minimal structural seam between the pure sweep and the world store (no engine, no coupling). */
class SweepWorldAdapter implements SweepWorld {
  private readonly _world: ChunkWorld;

  constructor(world: ChunkWorld) {
    this._world = world;
  }

  public isSolidCell(x: number, y: number, z: number): boolean {
    return this._world.isSolidAt(x, y, z);
  }
}

export interface VoxelPlayerOptions {
  /** The streaming world the player sweeps against + drives via its focus. Required. */
  world: ChunkWorld;
  /** Input source (no global fallback). Required. */
  input: InputInterface;
  /** Optional semantic action translator (composite bindings). */
  actions?: VoxelInputActions | undefined;
  /** Optional survival player rig (health, fall damage, respawn). */
  rig?: PlayerRig | undefined;
  /** Whether auto-jump over 1-block obstacles is enabled. Default true. */
  autoJump?: boolean;
  /** Maximum planar walk speed in m/s. Default 5. */
  walkSpeed?: number;
  /** Gravity in m/s² (positive number, applied downward). Default 20. */
  gravity?: number;
  /** Eye offset above the feet (camera Y). Default 1.62. */
  eyeHeight?: number;
  /** Player AABB as min/max OFFSETS relative to the feet origin. Default 0.6 × 1.8. */
  body?: { min: Vec3; max: Vec3 };
}

export class VoxelPlayerCollision extends Behavior<Camera> {
  private readonly _options: Required<
    Omit<VoxelPlayerOptions, "world" | "input" | "actions" | "rig">
  > & {
    world: ChunkWorld;
    input: InputInterface;
    actions: VoxelInputActions | undefined;
    rig: PlayerRig | undefined;
  };
  private readonly _world: SweepWorldAdapter;

  /** Player body origin (feet centre, world units). */
  private _body: Vec3 = { x: 0, y: 0, z: 0 };
  private _velocity: Vec3 = { x: 0, y: 0, z: 0 };
  private _onGround: boolean = false;
  private _spawned: boolean = false;

  constructor(options: VoxelPlayerOptions) {
    super();
    if (!options.world || !options.input) {
      throw new Error("VoxelPlayerCollision requires 'world' and 'input' options.");
    }
    this._world = new SweepWorldAdapter(options.world);
    this._options = {
      world: options.world,
      input: options.input,
      actions: options.actions,
      rig: options.rig,
      autoJump: options.autoJump ?? true,
      walkSpeed: options.walkSpeed ?? 5,
      gravity: options.gravity ?? 20,
      eyeHeight: options.eyeHeight ?? 1.62,
      body: options.body ?? { min: { x: -0.3, y: 0, z: -0.3 }, max: { x: 0.3, y: 1.8, z: 0.3 } },
    };
  }

  /** Whether the body is standing on solid ground (as resolved by the previous frame). */
  public isOnGround(): boolean {
    return this._onGround;
  }

  /**
   * Evaluates whether a 1-block step-up / auto-jump obstacle is directly ahead of the player.
   */
  public canStepUp(vx: number, vz: number): boolean {
    if (!this._onGround) return false;
    const speedSq = vx * vx + vz * vz;
    if (speedSq < 0.01) return false;

    const len = Math.sqrt(speedSq);
    const normX = vx / len;
    const normZ = vz / len;

    // Probe beyond the body bounds in movement direction
    const bodyExtent = Math.hypot(
      normX * this._options.body.max.x,
      normZ * this._options.body.max.z,
    );
    const probeDist = bodyExtent + 0.25;
    const probeX = Math.floor(this._body.x + normX * probeDist);
    const probeZ = Math.floor(this._body.z + normZ * probeDist);
    const footY = Math.floor(this._body.y + 0.2);

    // Obstacle at foot level
    const hasObstacle = this._world.isSolidCell(probeX, footY, probeZ);
    if (!hasObstacle) return false;

    // Room above the obstacle (1-block height + 1.8m player headroom)
    const head1 = this._world.isSolidCell(probeX, footY + 1, probeZ);
    const head2 = this._world.isSolidCell(probeX, footY + 2, probeZ);
    const aboveCurrent = this._world.isSolidCell(
      Math.floor(this._body.x),
      footY + 2,
      Math.floor(this._body.z),
    );

    return !head1 && !head2 && !aboveCurrent;
  }

  /** Current feet position (player body origin) in world units. A fresh object, never shared. */
  public getFeetPosition(): Vec3 {
    return { x: this._body.x, y: this._body.y, z: this._body.z };
  }

  /**
   * Whether the full voxel cell (wx, wy, wz) intersects the player AABB (world space). Strict
   * inequalities, so resting exactly ON a surface (feet at an integer) does not overlap the
   * cell below -- the same contact semantics the sweep resolver applies. Used by the block
   * editor's placement guard (M2) so a player cannot embed itself in a freshly placed block.
   */
  public overlapsCell(wx: number, wy: number, wz: number): boolean {
    const body = this._options.body;
    const minX = this._body.x + body.min.x;
    const maxX = this._body.x + body.max.x;
    const minY = this._body.y + body.min.y;
    const maxY = this._body.y + body.max.y;
    const minZ = this._body.z + body.min.z;
    const maxZ = this._body.z + body.max.z;
    return maxX > wx && minX < wx + 1 && maxY > wy && minY < wy + 1 && maxZ > wz && minZ < wz + 1;
  }

  /**
   * Teleports the player to a feet position (e.g. the terrain surface at spawn). Clears velocity
   * and the ground flag. Must be called once before the first frame renders.
   */
  public setSpawn(x: number, y: number, z: number): void {
    this._body = { x, y, z };
    this._velocity = { x: 0, y: 0, z: 0 };
    this._onGround = false;
    this._spawned = true;
  }

  public override update(deltaTime: number): void {
    const cam = this.target;
    if (!cam || !this._spawned) return;

    // Survival: if player is dead, immobilize and maintain view
    if (this._options.rig?.isDead) {
      cam.position.x = this._body.x;
      cam.position.y = this._body.y + this._options.eyeHeight;
      cam.position.z = this._body.z;
      return;
    }

    const input = this._options.input;

    const actions = this._options.actions?.current;

    // 1. Feed the FPS strategy with look deltas (it owns sensitivity + theta/phi).
    if (input.isPointerLocked) {
      cam.pendingDx += actions ? actions.look.dx : input.mouse.dx;
      cam.pendingDy += actions ? actions.look.dy : input.mouse.dy;
    }

    // Cold-start guard (H2): keep streaming centered on the player, but do not run gravity/sweep
    // while the chunk column directly beneath the player still lacks generated voxel data.
    const hasColumnData =
      typeof this._options.world.hasChunkDataAt === "function"
        ? this._options.world.hasChunkDataAt(this._body.x, this._body.z)
        : true;
    if (!hasColumnData) {
      this._velocity = { x: 0, y: 0, z: 0 };
      this._options.world.setFocus(this._body.x, this._body.z);
      this._options.world.update();
      cam.position.x = this._body.x;
      cam.position.y = this._body.y + this._options.eyeHeight;
      cam.position.z = this._body.z;
      return;
    }

    // 2. Desired planar velocity from WASD / actions, in the camera's yaw frame (FPSController parity).
    const moveZ = actions ? actions.move.z : input.getAxis(Keys.W, Keys.S); // W / forward is -1
    const strafe = actions ? actions.move.x : input.getAxis(Keys.A, Keys.D);
    const sin = Math.sin(cam.theta);
    const cos = Math.cos(cam.theta);
    const speed = this._options.walkSpeed;

    const planarVx = -moveZ * sin * speed + strafe * cos * speed;
    const planarVz = moveZ * cos * speed + strafe * sin * speed;

    // Jump impulse if grounded, or auto-jump / step-up over 1-block obstacles
    const isManualJump = this._onGround && (actions ? actions.jump : input.isPressed(Keys.SPACE));
    const isAutoJump =
      !isManualJump && this._options.autoJump && this.canStepUp(planarVx, planarVz);

    let vyStart = this._velocity.y;
    if (isManualJump) {
      vyStart = 8.5;
    } else if (isAutoJump) {
      vyStart = 6.8;
    }

    const velocity: Vec3 = {
      x: planarVx,
      y: vyStart,
      z: planarVz,
    };

    // 3. Sweep against the voxel grid (gravity always active; the resolver caps the axis).
    const result = sweepVoxel({
      world: this._world,
      options: {
        boxOffset: this._options.body,
        accel: { x: 0, y: -this._options.gravity, z: 0 },
      },
      position: this._body,
      velocity,
      dt: deltaTime,
    });

    // 4. Stand still on ground (Luanti convention: zero the falling speed once supported).
    let vy = result.velocity.y;
    if (result.onGround && vy < 0) vy = 0;
    this._velocity = { x: result.velocity.x, y: vy, z: result.velocity.z };
    this._body = { x: result.position.x, y: result.position.y, z: result.position.z };
    this._onGround = result.onGround;

    // Update survival state (fall damage, void detection)
    this._options.rig?.updateGroundState(result.onGround, this._body.y);

    // 5. Center streaming on the fresh body and dispatch the bounded world tasks.
    this._options.world.setFocus(this._body.x, this._body.z);
    this._options.world.update();

    // 6. Put the eye where the body is (FPS strategy keeps the view direction; see header).
    cam.position.x = this._body.x;
    cam.position.y = this._body.y + this._options.eyeHeight;
    cam.position.z = this._body.z;
  }
}
