import { Keys } from "@small-world-machine/engine";
import type { InputInterface } from "@small-world-machine/engine";

/**
 * Resolved semantic actions for the Minceraft.
 * Evaluates raw inputs (mouse, touchpad gestures, keyboard, and gamepad) into
 * unified actions, decoupling game mechanics from physical hardware.
 */
export interface VoxelActionsState {
  /** Planar movement: x is strafe (-1 left, +1 right), z is forward/back (-1 forward, +1 back). */
  move: { x: number; z: number };
  /** Camera look delta in pixels/points (pointer dx/dy + gamepad right stick). */
  look: { dx: number; dy: number };
  /** Jump action (Space or Gamepad ✕/A). */
  jump: boolean;
  /** Primary interaction: Break targeted block (LMB, F, Q, or Gamepad R2). Edge-triggered. */
  breakBlock: boolean;
  /** Secondary interaction: Place selected block (RMB, E, R, or Gamepad L2). Edge-triggered. */
  placeBlock: boolean;
  /** Explicit hand slot index (0..4 for Digit1..5), or null if no digit pressed this frame. */
  selectedSlot: number | null;
  /** Slot cycling delta: -1 (previous), +1 (next), 0 (none). Edge-triggered & debounced. */
  cycleSlot: number;
}

export interface VoxelInputActionsOptions {
  input: InputInterface;
  /** Wheel debounce time in ms (guards against trackpad momentum scroll). Default 120ms. */
  wheelDebounceMs?: number;
  /** Deadzone for gamepad analog sticks. Default 0.15. */
  gamepadDeadzone?: number;
  /** Sensitivity multiplier for gamepad right-stick look. Default 12.0. */
  gamepadLookSensitivity?: number;
  /** Whether to poll HTML5 gamepads. Default true. */
  enableGamepad?: boolean;
}

const DIGIT_KEYS: readonly Keys[] = [Keys.D1, Keys.D2, Keys.D3, Keys.D4, Keys.D5];
const SYSTEM_MODIFIER_CODES: readonly string[] = [
  "MetaLeft",
  "MetaRight",
  Keys.CTRL_L,
  Keys.CTRL_R,
  Keys.ALT_L,
  Keys.ALT_R,
];

/**
 * Semantic input translator for the Minceraft.
 *
 * Provides composite bindings across:
 *   - Desktop Mouse & Keyboard (LMB break, RMB place, WASD, digits 1..5)
 *   - macOS Trackpad (F/Q break, E/R place, debounced inertia-free wheel slot switching)
 *   - Standard Gamepads (DualShock 4 / DualSense / Xbox / Switch Pro via HTML5 Gamepad API)
 */
export class VoxelInputActions {
  private readonly _input: InputInterface;
  private readonly _wheelDebounceMs: number;
  private readonly _gamepadDeadzone: number;
  private readonly _gamepadLookSensitivity: number;
  private readonly _enableGamepad: boolean;

  private _prevBreak = false;
  private _prevPlace = false;
  private _prevBumperL1 = false;
  private _prevBumperR1 = false;
  private _prevDigitMask = 0;
  private _lastWheelTime = -Infinity;
  private _current: VoxelActionsState = {
    move: { x: 0, z: 0 },
    look: { dx: 0, dy: 0 },
    jump: false,
    breakBlock: false,
    placeBlock: false,
    selectedSlot: null,
    cycleSlot: 0,
  };

  constructor(options: VoxelInputActionsOptions) {
    this._input = options.input;
    this._wheelDebounceMs = options.wheelDebounceMs ?? 120;
    this._gamepadDeadzone = options.gamepadDeadzone ?? 0.15;
    this._gamepadLookSensitivity = options.gamepadLookSensitivity ?? 12.0;
    this._enableGamepad = options.enableGamepad ?? true;
  }

  /**
   * Evaluates all input sources and updates the semantic action state.
   */
  public update(deltaTime: number = 0.016): VoxelActionsState {
    const input = this._input;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();

    // 1. Gamepad state (if available)
    let gpMoveX = 0;
    let gpMoveZ = 0;
    let gpLookX = 0;
    let gpLookY = 0;
    let gpJump = false;
    let gpBreak = false;
    let gpPlace = false;
    let gpBumperL1 = false;
    let gpBumperR1 = false;

    // System modifier guard (M11): Cmd/Ctrl/Alt shortcuts (e.g. Cmd+R reload, Cmd+1..5 tab switch,
    // Ctrl+Click on macOS) must never trigger block break/place or hotbar slot selection.
    const hasSystemModifier = SYSTEM_MODIFIER_CODES.some((code) => input.isPressed(code));
    // Engine Input already maps active gamepad left stick -> getAxis, button 0 -> SPACE, and
    // right stick -> mouse.dx/dy. Detect that so sticks/jump are never double-counted (H4).
    const engineHasActiveGamepad = Boolean(
      (
        input as { gamepadController?: { getActiveDevice?: () => unknown } }
      ).gamepadController?.getActiveDevice?.(),
    );

    if (this._enableGamepad && typeof navigator !== "undefined" && navigator.getGamepads) {
      const pads = navigator.getGamepads();
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (!pad || !pad.connected) continue;

        const dz = this._gamepadDeadzone;
        // Left stick with radial deadzone: axes[0] = strafe (X), axes[1] = forward/back (Y)
        const lx = pad.axes[0] ?? 0;
        const lz = pad.axes[1] ?? 0;
        if (!engineHasActiveGamepad && Math.hypot(lx, lz) > dz) {
          gpMoveX += lx;
          gpMoveZ += lz;
        }

        // Right stick with radial deadzone: axes[2] = look X, axes[3] = look Y
        const rx = pad.axes[2] ?? 0;
        const ry = pad.axes[3] ?? 0;
        if (!(engineHasActiveGamepad && input.isPointerLocked) && Math.hypot(rx, ry) > dz) {
          gpLookX += rx * this._gamepadLookSensitivity * (deltaTime * 60);
          gpLookY += ry * this._gamepadLookSensitivity * (deltaTime * 60);
        }

        // Standard buttons: 0 = ✕/A (Jump), 6 = L2 (Place), 7 = R2 (Break), 4 = L1, 5 = R1
        if (!engineHasActiveGamepad && pad.buttons[0]?.pressed) gpJump = true;
        if ((pad.buttons[7]?.value ?? 0) > 0.25 || pad.buttons[7]?.pressed) gpBreak = true;
        if ((pad.buttons[6]?.value ?? 0) > 0.25 || pad.buttons[6]?.pressed) gpPlace = true;
        if (pad.buttons[4]?.pressed) gpBumperL1 = true;
        if (pad.buttons[5]?.pressed) gpBumperR1 = true;
      }
    }

    // 2. Planar Movement (WASD + Arrows + Gamepad Left Stick)
    const kbMoveZ = input.getAxis(Keys.W, Keys.S); // W = -1 (forward)
    const kbStrafe = input.getAxis(Keys.A, Keys.D);
    const arrowMoveZ = input.getAxis(Keys.UP, Keys.DOWN);
    const arrowStrafe = input.getAxis(Keys.LEFT, Keys.RIGHT);

    const rawMoveZ = (kbMoveZ !== 0 ? kbMoveZ : arrowMoveZ) + gpMoveZ;
    const rawStrafe = (kbStrafe !== 0 ? kbStrafe : arrowStrafe) + gpMoveX;

    // Clamp to the unit disc (not per axis): W+D must not be sqrt(2) faster than W alone.
    // Analog sticks below full deflection keep their magnitude.
    const moveLen = Math.hypot(rawStrafe, rawMoveZ);
    const moveScale = moveLen > 1 ? 1 / moveLen : 1;
    const move = { x: rawStrafe * moveScale, z: rawMoveZ * moveScale };

    // 3. Look Deltas (Pointer movement + Gamepad Right Stick)
    const look = {
      dx: (input.isPointerLocked ? input.mouse.dx : 0) + gpLookX,
      dy: (input.isPointerLocked ? input.mouse.dy : 0) + gpLookY,
    };

    // 4. Jump
    const jump = (!hasSystemModifier && input.isPressed(Keys.SPACE)) || gpJump;

    // 5. Break Block (LMB + KeyF + KeyQ + Gamepad R2; suppressed under Cmd/Ctrl/Alt)
    const isBreakDown =
      (!hasSystemModifier &&
        (input.mouse.left || input.isPressed(Keys.F) || input.isPressed(Keys.Q))) ||
      gpBreak;
    const breakEdge = isBreakDown && !this._prevBreak;
    this._prevBreak = isBreakDown;

    // 6. Place Block (RMB + KeyE + KeyR + Gamepad L2; keyboard suppressed under Cmd/Ctrl/Alt)
    const isPlaceDown =
      input.mouse.right ||
      (!hasSystemModifier && (input.isPressed(Keys.E) || input.isPressed(Keys.R))) ||
      gpPlace;
    const placeEdge = isPlaceDown && !this._prevPlace;
    this._prevPlace = isPlaceDown;

    // 7. Explicit Hand Slot (Digits 1..5; suppressed under Cmd/Ctrl/Alt)
    let digitMask = 0;
    if (!hasSystemModifier) {
      for (let i = 0; i < DIGIT_KEYS.length; i++) {
        if (input.isPressed(DIGIT_KEYS[i]!)) digitMask |= 1 << i;
      }
    }
    const newlyPressedDigits = digitMask & ~this._prevDigitMask;
    this._prevDigitMask = digitMask;

    let selectedSlot: number | null = null;
    for (let i = 0; i < DIGIT_KEYS.length; i++) {
      if ((newlyPressedDigits & (1 << i)) !== 0) {
        selectedSlot = i;
        break;
      }
    }

    // 8. Slot Cycling (Debounced Wheel + Gamepad L1/R1 Bumpers)
    let cycleSlot = 0;

    // Bumper rising edges
    if (gpBumperL1 && !this._prevBumperL1) cycleSlot -= 1;
    if (gpBumperR1 && !this._prevBumperR1) cycleSlot += 1;
    this._prevBumperL1 = gpBumperL1;
    this._prevBumperR1 = gpBumperR1;

    // Wheel with momentum debounce
    const wheelY = input.mouse.wheelY;
    if (Math.abs(wheelY) > 8 && now - this._lastWheelTime >= this._wheelDebounceMs) {
      this._lastWheelTime = now;
      cycleSlot += wheelY > 0 ? 1 : -1;
      // Reset wheel accumulator so it doesn't leak into subsequent frames
      input.mouse.wheelY = 0;
    }

    const state: VoxelActionsState = {
      move,
      look,
      jump,
      breakBlock: breakEdge,
      placeBlock: placeEdge,
      selectedSlot,
      cycleSlot,
    };
    this._current = state;
    return state;
  }

  /** The most recently resolved action state. */
  public get current(): VoxelActionsState {
    return this._current;
  }
}
