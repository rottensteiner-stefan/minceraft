export interface PlayerRigOptions {
  /** Maximum health in HP (20 = 10 full hearts). Default 20. */
  maxHealth?: number;
  /** Fall threshold in blocks before damage begins (Minceraft default: 3.0). */
  safeFallDistance?: number;
  /** Y coordinate below which the player dies from the void. Default -30. */
  voidY?: number;
  /** Callbacks for UI/HUD feedback. */
  onDamage?: (amount: number, newHealth: number) => void;
  onDeath?: () => void;
  onRespawn?: () => void;
}

/**
 * M4 Player Rig: Manages survival state (health, fall damage, void protection, death and respawn).
 * Pure TS, zero-allocation per frame, fully node-testable.
 */
export class PlayerRig {
  public readonly maxHealth: number;
  public readonly safeFallDistance: number;
  public readonly voidY: number;

  private _health: number;
  private _isDead: boolean = false;
  private _fallPeakY: number | null = null;

  public onDamage?: ((amount: number, newHealth: number) => void) | undefined;
  public onDeath?: (() => void) | undefined;
  public onRespawn?: (() => void) | undefined;

  constructor(options?: PlayerRigOptions) {
    this.maxHealth = options?.maxHealth ?? 20;
    this.safeFallDistance = options?.safeFallDistance ?? 3.0;
    this.voidY = options?.voidY ?? -30.0;
    this._health = this.maxHealth;
    if (options?.onDamage !== undefined) {
      this.onDamage = options.onDamage;
    }
    if (options?.onDeath !== undefined) {
      this.onDeath = options.onDeath;
    }
    if (options?.onRespawn !== undefined) {
      this.onRespawn = options.onRespawn;
    }
  }

  public get health(): number {
    return this._health;
  }

  public get isDead(): boolean {
    return this._isDead;
  }

  /** Current fall peak Y while airborne, or null if grounded. */
  public get fallPeakY(): number | null {
    return this._fallPeakY;
  }

  /** Inflicts damage, clamps health to 0, and triggers death when depleted. */
  public takeDamage(amount: number): void {
    if (this._isDead || amount <= 0) return;
    this._health = Math.max(0, this._health - amount);
    this.onDamage?.(amount, this._health);
    if (this._health <= 0) {
      this._isDead = true;
      this.onDeath?.();
    }
  }

  /** Restores health up to `maxHealth`. No effect if dead. */
  public heal(amount: number): void {
    if (this._isDead || amount <= 0) return;
    this._health = Math.min(this.maxHealth, this._health + amount);
  }

  /**
   * Called every physics tick with current grounding status and feet Y.
   * Tracks airborne fall peak and calculates Minceraft-accurate fall damage upon landing.
   */
  public updateGroundState(onGround: boolean, currentY: number): void {
    if (this._isDead) return;

    // Void safety check
    if (currentY < this.voidY) {
      this.takeDamage(this.maxHealth);
      return;
    }

    if (!onGround) {
      // Airborne: track peak Y
      if (this._fallPeakY === null || currentY > this._fallPeakY) {
        this._fallPeakY = currentY;
      }
    } else {
      // Landed
      if (this._fallPeakY !== null) {
        const fallDistance = this._fallPeakY - currentY;
        if (fallDistance > this.safeFallDistance) {
          const damage = Math.floor(fallDistance - this.safeFallDistance);
          if (damage > 0) {
            this.takeDamage(damage);
          }
        }
        this._fallPeakY = null;
      }
    }
  }

  /**
   * Resets health, clears airborne tracking, and restores alive state.
   */
  public respawn(): void {
    this._health = this.maxHealth;
    this._isDead = false;
    this._fallPeakY = null;
    this.onRespawn?.();
  }
}
