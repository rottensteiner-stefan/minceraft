import { describe, expect, it } from "vitest";
import { Keys } from "@small-world-machine/engine";
import type { InputInterface, MouseState } from "@small-world-machine/engine";
import { VoxelInputActions } from "../src/voxel/input/VoxelInputActions.js";

function createMockInput(): { input: InputInterface; pressedKeys: Set<string>; mouse: MouseState } {
  const pressedKeys = new Set<string>();
  const mouse: MouseState = {
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    wheelX: 0,
    wheelY: 0,
    zoom: 0,
    left: false,
    right: false,
  };
  const input: InputInterface = {
    mouse,
    isPointerLocked: true,
    isPressed: (code: string | Keys) => pressedKeys.has(code),
    getAxis: (neg: string | Keys, pos: string | Keys) => {
      let val = 0;
      if (pressedKeys.has(neg)) val -= 1;
      if (pressedKeys.has(pos)) val += 1;
      return val;
    },
  };
  return { input, pressedKeys, mouse };
}

describe("VoxelInputActions — composite semantic bindings", () => {
  it("translates WASD into planar movement", () => {
    const { input, pressedKeys } = createMockInput();
    const actions = new VoxelInputActions({ input, enableGamepad: false });

    // Rest
    expect(actions.update().move).toEqual({ x: 0, z: 0 });

    // W = forward (-1 z)
    pressedKeys.add(Keys.W);
    expect(actions.update().move).toEqual({ x: 0, z: -1 });

    // W + D = diagonal, clamped to the unit disc (no sqrt(2) speed boost)
    pressedKeys.add(Keys.D);
    const diagonal = actions.update().move;
    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(diagonal.z).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(Math.hypot(diagonal.x, diagonal.z)).toBeCloseTo(1, 9);
  });

  it("triggers breakBlock edge via LMB or KeyF or KeyQ without repeat", () => {
    const { input, pressedKeys, mouse } = createMockInput();
    const actions = new VoxelInputActions({ input, enableGamepad: false });

    // Initial frame
    expect(actions.update().breakBlock).toBe(false);

    // Trackpad alternative: KeyF pressed
    pressedKeys.add(Keys.F);
    expect(actions.update().breakBlock).toBe(true);
    // Holding KeyF does not fire again (edge-triggered)
    expect(actions.update().breakBlock).toBe(false);

    pressedKeys.delete(Keys.F);
    expect(actions.update().breakBlock).toBe(false);

    // Mouse LMB
    mouse.left = true;
    expect(actions.update().breakBlock).toBe(true);
    expect(actions.update().breakBlock).toBe(false);
  });

  it("triggers placeBlock edge via RMB or KeyE or KeyR without repeat", () => {
    const { input, pressedKeys } = createMockInput();
    const actions = new VoxelInputActions({ input, enableGamepad: false });

    expect(actions.update().placeBlock).toBe(false);

    // Trackpad alternative: KeyE pressed
    pressedKeys.add(Keys.E);
    expect(actions.update().placeBlock).toBe(true);
    // Holding KeyE does not fire again
    expect(actions.update().placeBlock).toBe(false);

    pressedKeys.delete(Keys.E);
    expect(actions.update().placeBlock).toBe(false);

    // Secondary Trackpad alternative: KeyR
    pressedKeys.add(Keys.R);
    expect(actions.update().placeBlock).toBe(true);
    expect(actions.update().placeBlock).toBe(false);
  });

  it("selects hand slots via Digit1..5", () => {
    const { input, pressedKeys } = createMockInput();
    const actions = new VoxelInputActions({ input, enableGamepad: false });

    expect(actions.update().selectedSlot).toBeNull();

    pressedKeys.add(Keys.D3);
    expect(actions.update().selectedSlot).toBe(2); // Slot index 2 (zero-based)
    // Holding does not re-emit
    expect(actions.update().selectedSlot).toBeNull();
  });

  it("debounces mouse wheel for slot cycling to prevent trackpad inertia spam", () => {
    const { input, mouse } = createMockInput();
    const actions = new VoxelInputActions({ input, enableGamepad: false, wheelDebounceMs: 100 });

    // First wheel gesture
    mouse.wheelY = 15;
    expect(actions.update().cycleSlot).toBe(1);

    // Immediate second wheel gesture within debounce window should be ignored
    mouse.wheelY = 15;
    expect(actions.update().cycleSlot).toBe(0);
  });

  it("suppresses break, place, slot digits and Ctrl+LMB when Cmd/Ctrl/Alt modifiers are held (M11)", () => {
    const { input, pressedKeys, mouse } = createMockInput();
    const actions = new VoxelInputActions({ input, enableGamepad: false });

    // Cmd+R (browser reload), Cmd+F (find), Cmd+1 (tab switch) must not trigger game actions
    pressedKeys.add("MetaLeft");
    pressedKeys.add(Keys.R);
    pressedKeys.add(Keys.F);
    pressedKeys.add(Keys.D1);
    const cmdFrame = actions.update();
    expect(cmdFrame.breakBlock).toBe(false);
    expect(cmdFrame.placeBlock).toBe(false);
    expect(cmdFrame.selectedSlot).toBeNull();

    // Ctrl+Click on macOS (ControlLeft + mouse.left) must not trigger breakBlock
    pressedKeys.clear();
    pressedKeys.add(Keys.CTRL_L);
    mouse.left = true;
    expect(actions.update().breakBlock).toBe(false);

    // Releasing modifier allows normal action
    pressedKeys.clear();
    mouse.left = false;
    actions.update();
    pressedKeys.add(Keys.R);
    expect(actions.update().placeBlock).toBe(true);
  });

  it("does not double-count gamepad sticks or jump when engine Input already has an active gamepad (H4)", () => {
    const { input, mouse } = createMockInput();
    (
      input as unknown as { gamepadController: { getActiveDevice: () => object } }
    ).gamepadController = {
      getActiveDevice: (): object => ({ id: "mock-pad" }),
    };
    // Simulate engine Input already folding 0.5 stick deflection into getAxis and 6px into mouse.dx
    input.getAxis = (_neg, pos): number => (pos === Keys.S ? 0.5 : 0);
    mouse.dx = 6;

    const origGetGamepads = navigator.getGamepads;
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: (): unknown[] => [
        {
          connected: true,
          axes: [0, 0.5, 0.8, 0],
          buttons: [
            { pressed: true, value: 1 }, // 0: Jump
            { pressed: false, value: 0 },
            { pressed: false, value: 0 },
            { pressed: false, value: 0 },
            { pressed: false, value: 0 }, // 4: L1
            { pressed: true, value: 1 }, // 5: R1
            { pressed: false, value: 0 }, // 6: L2
            { pressed: true, value: 0.9 }, // 7: R2 (Break)
          ],
        },
      ],
    });

    try {
      const actions = new VoxelInputActions({ input, enableGamepad: true });
      const state = actions.update(1 / 60);
      // Movement is 0.5 (from engine getAxis), NOT 0.5 + 0.5 = 1.0
      expect(state.move.z).toBeCloseTo(0.5, 5);
      // Look dx is 6 (from engine mouse.dx), NOT 6 + rightStick
      expect(state.look.dx).toBeCloseTo(6, 5);
      // R2 break and R1 slot cycle still work (engine Input does not map them)
      expect(state.breakBlock).toBe(true);
      expect(state.cycleSlot).toBe(1);
    } finally {
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: origGetGamepads,
      });
    }
  });
});
