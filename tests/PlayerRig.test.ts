import { describe, expect, it, vi } from "vitest";
import { PlayerRig } from "../src/voxel/player/PlayerRig.js";

describe("PlayerRig (M4 Survival State)", () => {
  it("initializes with 20 HP and alive status", () => {
    const rig = new PlayerRig();
    expect(rig.health).toBe(20);
    expect(rig.maxHealth).toBe(20);
    expect(rig.isDead).toBe(false);
  });

  it("calculates fall damage accurately according to Minceraft rules (> 3 blocks)", () => {
    const onDamage = vi.fn();
    const rig = new PlayerRig({ onDamage });

    // Start on ground at Y=10
    rig.updateGroundState(true, 10);
    expect(rig.health).toBe(20);

    // Jump / airborne up to Y=15
    rig.updateGroundState(false, 11);
    rig.updateGroundState(false, 15);
    expect(rig.fallPeakY).toBe(15);

    // Fall to Y=11 (fall distance = 4 blocks -> 4 - 3 = 1 damage)
    rig.updateGroundState(true, 11);
    expect(rig.health).toBe(19);
    expect(onDamage).toHaveBeenCalledWith(1, 19);

    // Another fall: from Y=11, jump to 13, land at 11 (fall distance = 2 blocks <= 3 -> no damage)
    rig.updateGroundState(false, 13);
    rig.updateGroundState(true, 11);
    expect(rig.health).toBe(19);
  });

  it("triggers death when health drops to 0 and blocks further damage until respawn", () => {
    const onDeath = vi.fn();
    const onRespawn = vi.fn();
    const rig = new PlayerRig({ onDeath, onRespawn });

    rig.takeDamage(15);
    expect(rig.health).toBe(5);
    expect(rig.isDead).toBe(false);
    expect(onDeath).not.toHaveBeenCalled();

    rig.takeDamage(10);
    expect(rig.health).toBe(0);
    expect(rig.isDead).toBe(true);
    expect(onDeath).toHaveBeenCalledTimes(1);

    // Further damage ignored while dead
    rig.takeDamage(5);
    expect(rig.health).toBe(0);

    // Respawn restores health
    rig.respawn();
    expect(rig.health).toBe(20);
    expect(rig.isDead).toBe(false);
    expect(onRespawn).toHaveBeenCalledTimes(1);
  });

  it("kills player if falling into the void", () => {
    const rig = new PlayerRig({ voidY: -30 });
    rig.updateGroundState(false, -20);
    expect(rig.isDead).toBe(false);

    rig.updateGroundState(false, -31);
    expect(rig.isDead).toBe(true);
    expect(rig.health).toBe(0);
  });
});
