---
name: coding-guide
description: Coding standards, TypeScript templates, guard clauses, engine boundary rules, hot-path performance rules, and Vitest guidelines.
---

# Game Application Coding Guide (Small World Machine Consumer)

This guide provides coding standards, strict TypeScript conventions, and zero-allocation patterns for applications built on top of Small World Machine.

---

## 1. Hard Architectural Boundary: The Engine Boundary Law

This project consumes Small World Machine as an external package (pinned release in `package.json`).

- **Root Imports Only:** Import exclusively from the package root:
  ```typescript
  import { Scene, Object3D, Vector3D, Color, StandardMaterial } from "@small-world-machine/engine";
  ```
- **NO Deep Imports:** Never import from subpaths or source files like `@small-world-machine/engine/src/...` or `@small-world-machine/engine/renderers/...`.
- **Never Edit `node_modules`:** Any missing engine capability must be added and tested in the engine repository, published via a release, and consumed here by updating `package.json`.

---

## 2. TypeScript Standards & Templates

All TypeScript source files must adhere to strict type-safety, explicit visibility modifiers, and correct relative imports.

### Import Template

Relative imports within the app source must explicitly end in `.js` (required by runtime module resolution):

```typescript
import { PlayerController } from "./controllers/PlayerController.js";
import { GameState } from "../enums/GameState.js";
import { Vector3D } from "@small-world-machine/engine";

export class GameSession {
  public state: GameState;
  private _player: PlayerController;

  constructor(player: PlayerController) {
    this.state = GameState.RUNNING;
    this._player = player;
  }

  public getPlayer(): PlayerController {
    return this._player;
  }
}
```

### Code Comments & Philosophy

Write self-documenting code. Comments are for what the code cannot say.

- **Never explain WHAT the code does.** If logic needs narration, rewrite it. A comment that restates the line below it is a defect.
- **Only explain WHY:** Non-obvious intent, gameplay or atmospheric constraints, workarounds, or why an alternative approach was discarded.
- **Refactor before you comment.** Extract named variables for complex conditions and break down dense methods until the comment becomes redundant.

### Naming Conventions & Typing

- **PascalCase** for types, classes, interfaces, and enums (e.g. `PlayerRig`, `GameState`).
- **camelCase** for variables, properties, methods, and parameters (e.g. `activeWeapon`, `updatePosition`).
- **Underscore prefix (`_`)** for private and protected class members (e.g. `_scratchVec3`, `_isDead`).
- **Strict Types:** Explicit types, access modifiers, and **NO `any`**. Every function and method MUST declare an explicit return type (e.g., `(): void`, `(): Promise<boolean>`).
- **DOM Manipulations:** Never use `@ts-nocheck` or `any` when dealing with DOM elements. Cast explicitly to specific types (`HTMLElement`, `HTMLCanvasElement`, `HTMLInputElement`).
- **DOM Assignments:** Never use optional chaining on the left side of an assignment (e.g. `el?.style.cursor = 'pointer'`). Always use explicit `if (el)` checks to prevent bundler crashes.
- **No Magic Strings or Numbers:** Use explicit enums or constants for fixed gameplay states, sound keys, and animation names.

---

## 3. Control Flow: Guard Clauses & Early Returns

To maximize readability and avoid deep indentation pyramids, use flat guard clauses.

### ❌ Bad (Deeply Nested)
```typescript
public handleInteraction(target: Interactable | null): void {
  if (target) {
    if (this._isPlayerAlive) {
      if (this.distanceTo(target) < 2.0) {
        target.interact(this);
      }
    }
  }
}
```

### ✅ Good (Flat Guard Clauses)
```typescript
public handleInteraction(target: Interactable | null): void {
  if (!target || !this._isPlayerAlive) {
    return;
  }
  if (this.distanceTo(target) >= 2.0) {
    return;
  }

  target.interact(this);
}
```

---

## 4. Hot-Path TypeScript Performance ("Zero Allocation in the Loop")

Any code executed inside the per-frame loop (`update(dt)`, input polling, physics tick, raycasting, camera follow) is a **hot path**.

- **No Per-Frame Allocations:** Never create objects (`new Vector3D()`, `new Array()`, `{}`) or closure callbacks inside per-frame methods.
- **Scratch Objects:** Allocate scratch instances once as private class fields (e.g., `private _scratchVec3: Vector3D = new Vector3D()`) and reuse them across frames.
- **No Scratch Leaks:** Scratch objects must never be returned or stored outside the immediate method call that fills them.
- **Classic `for` Loops:** In per-frame loops, prefer `for (let i = 0; i < len; i++)` over `.map()`, `.filter()`, `.forEach()`, or `for...of` to avoid intermediate iterator allocation and call overhead.
- **Monomorphism & Stable Shapes:** Always initialize all object fields in the constructor. Never delete properties with `delete` or change field types dynamically.
- **Hoist Repeated Lookups:** Cache array lengths and repeated deep property lookups in local `const` variables before running tight loops.

---

## 5. Testing Guide & Vitest Guidelines

We use **Vitest** for running unit and behavior tests.

- Run tests via `npm test` (`vitest run --maxWorkers=8`).
- Place test files in `tests/` with the `.test.ts` extension.
- Isolate browser/DOM interactions using the mock helpers in `tests/setup.ts`.
