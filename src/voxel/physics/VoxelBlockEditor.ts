import { Behavior, Keys } from "@small-world-machine/engine";
import type { Camera, InputInterface } from "@small-world-machine/engine";
import type { VoxelInputActions } from "../input/VoxelInputActions.js";
import {
  BLOCK_AIR,
  BLOCK_DIRT,
  BLOCK_GRASS,
  BLOCK_STONE,
  BLOCK_WATER,
  BLOCK_WOOD,
} from "../BlockRegistry.js";
import type { PlayerRig } from "../player/PlayerRig.js";
import type { ChunkWorld } from "../ChunkWorld.js";
import { raycastVoxel } from "./VoxelRaycast.js";
import type { RaycastWorld } from "./VoxelRaycast.js";

/**
 * M2 first-person block editing (dossier §4.2 "Break/Place"), camera-hosted like the player
 * behavior. Minceraft muscle memory: LMB breaks the targeted solid block, RMB places the
 * selected hand block on the face under the crosshair, Digit1..Digit5 select the hand
 * (dirt/stone/wood/water/grass). The view ray reuses the EXACT FPS forward from
 * `FPSStrategy` (sin(theta)cos(phi), sin(phi), -cos(theta)cos(phi)), so the ray matches the
 * rendered crosshair center.
 *
 * Thin engine glue, mirroring `VoxelPlayerCollision`:
 *   - PURE math (DDA targeting) lives in `VoxelRaycast.ts` (node-testable, no engine).
 *   - All state mutations go through `ChunkWorld.setBlock`; the behavior never calls
 *     `world.update()` (that stays the player's job -- no double streaming).
 *   - Actions are EDGE-triggered (false->true) so holding a button does not repeat, and they
 *     only fire while the pointer is locked, so the initial "click to capture" does not punch
 *     a hole at spawn. Placement is refused when the target cell overlaps the player body
 *     (injected `placementBlocker` from `VoxelPlayerCollision.overlapsCell`) -- otherwise the
 *     player would embed itself in a freshly placed block.
 */
/**
 * Minimal structural seam between the pure DDA and the world store (same pattern as the
 * player's `SweepWorldAdapter`): matches the `RaycastWorld.isSolidCell` contract to
 * `ChunkWorld.isSolidAt` -- the registry collidability semantics (water passes through).
 */
class RaycastWorldAdapter implements RaycastWorld {
  private readonly _world: ChunkWorld;

  constructor(world: ChunkWorld) {
    this._world = world;
  }

  public isSolidCell(x: number, y: number, z: number): boolean {
    return this._world.isSolidAt(x, y, z);
  }
}

const HAND_KEY_CODES: readonly Keys[] = [Keys.D1, Keys.D2, Keys.D3, Keys.D4, Keys.D5];

const DEFAULT_HAND_SLOTS: readonly number[] = [
  BLOCK_DIRT,
  BLOCK_STONE,
  BLOCK_WOOD,
  BLOCK_WATER,
  BLOCK_GRASS,
];

export interface VoxelEditorOptions {
  /** The streaming world the edits mutate. Required. */
  world: ChunkWorld;
  /** Input source (no global fallback). Required. */
  input: InputInterface;
  /** Optional semantic action translator (composite bindings). */
  actions?: VoxelInputActions | undefined;
  /** Optional survival player rig (blocks editing while dead). */
  rig?: PlayerRig | undefined;
  /** Hand blocks for Digit1..N (default dirt/stone/wood/water/grass). At most 5 slots. */
  handSlots?: readonly number[];
  /** Maximum reach of the targeting ray in meters. Default 6. */
  maxDistance?: number;
  /** Placement guard: returns true when the target cell may not host a block (player body). */
  placementBlocker?: (x: number, y: number, z: number) => boolean;
}

export class VoxelBlockEditor extends Behavior<Camera> {
  private readonly _rayWorld: RaycastWorldAdapter;
  private readonly _world: ChunkWorld;
  private readonly _input: InputInterface;
  private readonly _actions: VoxelInputActions | undefined;
  private readonly _rig: PlayerRig | undefined;
  private readonly _handSlots: readonly number[];
  private readonly _maxDistance: number;
  private readonly _placementBlocker: ((x: number, y: number, z: number) => boolean) | undefined;

  private _handIndex = 0;
  private _prevLeft = false;
  private _prevRight = false;
  private _prevDigitMask = 0;

  constructor(options: VoxelEditorOptions) {
    super();
    if (!options.world || !options.input) {
      throw new Error("VoxelBlockEditor requires 'world' and 'input' options.");
    }
    const handSlots = options.handSlots ?? DEFAULT_HAND_SLOTS;
    if (handSlots.length > HAND_KEY_CODES.length) {
      throw new Error(
        `VoxelBlockEditor supports at most ${HAND_KEY_CODES.length} hand slots, got ${handSlots.length}`,
      );
    }
    this._rayWorld = new RaycastWorldAdapter(options.world);
    this._world = options.world;
    this._input = options.input;
    this._actions = options.actions;
    this._rig = options.rig;
    this._handSlots = handSlots;
    this._maxDistance = options.maxDistance ?? 6;
    this._placementBlocker = options.placementBlocker;
  }

  /** The currently selected hand slot index (0..4). */
  public get handIndex(): number {
    return this._handIndex;
  }

  /** The currently selected hand block id (for the stats/QA readout). */
  public getHand(): number {
    return this._handSlots[this._handIndex]!;
  }

  /** The world-space view direction of the camera (FPS forward, unit by construction). */
  public getViewDirection(cam: Camera): { x: number; y: number; z: number } {
    const cosPhi = Math.cos(cam.phi);
    return {
      x: Math.sin(cam.theta) * cosPhi,
      y: Math.sin(cam.phi),
      z: -Math.cos(cam.theta) * cosPhi,
    };
  }

  public override update(_deltaTime: number): void {
    const cam = this.target;
    if (!cam || this._rig?.isDead) return;

    let breakEdge: boolean;
    let placeEdge: boolean;

    if (this._actions) {
      const actions = this._actions.current;
      if (actions.selectedSlot !== null && actions.selectedSlot < this._handSlots.length) {
        this._handIndex = actions.selectedSlot;
      } else if (actions.cycleSlot !== 0) {
        const len = this._handSlots.length;
        this._handIndex = (((this._handIndex + actions.cycleSlot) % len) + len) % len;
      }
      breakEdge = actions.breakBlock;
      placeEdge = actions.placeBlock;
    } else {
      this._updateHandSelection();
      const leftDown = this._input.mouse.left;
      const rightDown = this._input.mouse.right;
      breakEdge = leftDown && !this._prevLeft;
      placeEdge = rightDown && !this._prevRight;
      this._prevLeft = leftDown;
      this._prevRight = rightDown;
    }

    if ((!breakEdge && !placeEdge) || !this._input.isPointerLocked) {
      return;
    }

    const hit = raycastVoxel(
      this._rayWorld,
      cam.position,
      this.getViewDirection(cam),
      this._maxDistance,
    );
    if (!hit) return;

    if (breakEdge) {
      this._world.setBlock(hit.x, hit.y, hit.z, BLOCK_AIR);
    }
    if (placeEdge) {
      const blocked =
        this._placementBlocker !== undefined
          ? this._placementBlocker(hit.placeX, hit.placeY, hit.placeZ)
          : false;
      if (!blocked) {
        this._world.setBlock(hit.placeX, hit.placeY, hit.placeZ, this.getHand());
      }
    }
  }

  /** Edge-triggered hand switch via Digit1..N (a held digit does not re-select each frame). */
  private _updateHandSelection(): void {
    let mask = 0;
    for (let i = 0; i < this._handSlots.length; i++) {
      if (this._input.isPressed(HAND_KEY_CODES[i]!)) mask |= 1 << i;
    }
    const newlyPressed = mask & ~this._prevDigitMask;
    this._prevDigitMask = mask;
    for (let i = 0; i < this._handSlots.length; i++) {
      if ((newlyPressed & (1 << i)) !== 0) {
        this._handIndex = i;
      }
    }
  }
}
