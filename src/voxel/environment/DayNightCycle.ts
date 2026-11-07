export interface DayNightCycleOptions {
  /** Total seconds for a full 24h cycle. Default 120s (fast prototype cycle). */
  cycleDuration?: number;
  /** Initial normalized time in [0, 1). Default 0.2 (mid-morning). */
  initialTime?: number;
  /** Initial day-cycle count for the slow scenic lunar cycle. Default 0. */
  initialDays?: number;
}

export interface SkyColor {
  r: number;
  g: number;
  b: number;
}

export type TimePhase = "sunrise" | "day" | "sunset" | "night";

/**
 * M4 Day/Night cycle controller.
 *
 * Drives time of day, sun vector, surface daylight multiplier (for shader uniform `u_daylight`),
 * and renderer clear color without modifying chunk mesh geometry (zero remesh overhead).
 *
 * Normalized time [0, 1):
 *   0.00: Sunrise (sun rises on horizon)
 *   0.25: Noon (sun at zenith)
 *   0.50: Sunset (sun sets on horizon)
 *   0.75: Midnight (deep night)
 */
export class DayNightCycle {
  private _time: number;
  private readonly _cycleDuration: number;
  /** Full day-cycles elapsed since construction -- drives the slow scenic lunar cycle without
   *  breaking the [0,1) normalization of `_time` (reproducible `?time=` captures still work). */
  private _days: number = 0;
  /** Phase-pinning offset in lunar days (`?moon=`): keeps an arbitrary scenic phase exactly
   *  reachable at any time of day without bending `_days` or `_time` (see {@link pinMoonPhase}). */
  private _lunarOffset: number = 0;

  constructor(options?: DayNightCycleOptions) {
    this._cycleDuration = options?.cycleDuration ?? 120;
    const initial = options?.initialTime ?? 0.2;
    this._time = ((initial % 1) + 1) % 1;
    this._days = Math.max(0, Math.floor(options?.initialDays ?? 0));
  }

  /** Current normalized time in [0, 1). */
  public get time(): number {
    return this._time;
  }

  public setTime(t: number): void {
    this._time = ((t % 1) + 1) % 1;
  }

  /** Progresses time by `deltaTime` seconds. */
  public update(deltaTime: number): void {
    if (this._cycleDuration <= 0) return;
    const total = this._time + deltaTime / this._cycleDuration;
    this._days += Math.floor(total);
    this._time = total - Math.floor(total);
  }

  /**
   * Sun elevation factor in [-1, 1].
   * 1.0 at noon, 0.0 at sunrise/sunset, -1.0 at midnight.
   */
  public getSunElevation(): number {
    return Math.sin(this._time * 2 * Math.PI);
  }

  /**
   * Daylight multiplier in [0.15, 1.0].
   * Ramps smoothly from night floor (0.15) to full noon sunlight (1.0).
   */
  public getDaylight(): number {
    const elevation = this.getSunElevation();
    if (elevation >= 0) {
      // Daytime: 0.15 + 0.85 * elevation
      return 0.15 + 0.85 * elevation;
    }
    // Nighttime twilight transition between 0 and -0.2
    if (elevation > -0.2) {
      const t = (elevation - -0.2) / 0.2; // 0 at -0.2, 1 at 0
      return 0.15 * t;
    }
    return 0.15;
  }

  /**
   * Normalized 3D directional vector of the sun for lighting shaders.
   */
  public getSunDirection(): [number, number, number] {
    const angle = this._time * 2 * Math.PI;
    const x = Math.cos(angle);
    // Keep positive Y component so light always shines slightly downwards or sideways
    const y = Math.max(0.12, Math.sin(angle));
    const z = 0.25;
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
  }

  /**
   * True direction of the sun, unlike {@link getSunDirection} (which keeps the light above the
   * horizon) it sinks below it at night. The sky dome draws the sun with it and the moon opposite.
   */
  public getSkySunDirection(): [number, number, number] {
    const angle = this._time * 2 * Math.PI;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    const z = 0.25;
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
  }

  /**
   * How visible the stars are: 0 by day, 1 in full night, fading through twilight.
   */
  public getStarVisibility(): number {
    return smoothstep(0.05, -0.25, this.getSunElevation());
  }

  /**
   * Colour of the direct light: white by day, amber around sunrise/sunset, blue-grey moonlight
   * at night. Multiplies the shaded block colour on top of the baked light and daylight.
   */
  public getLightTint(): SkyColor {
    return this._byElevation(DAY_LIGHT, TWILIGHT_LIGHT, NIGHT_LIGHT);
  }

  /** Sky colour at the horizon (what {@link getSkyColor} returns). */
  public getHorizonColor(): SkyColor {
    return this.getSkyColor();
  }

  /** Sky colour at the zenith: a deeper blue by day, dusk violet at twilight, near black at night. */
  public getZenithColor(): SkyColor {
    return this._byElevation(DAY_ZENITH, TWILIGHT_ZENITH, NIGHT_ZENITH);
  }

  /**
   * Descriptive phase string for HUD.
   */
  public getTimePhase(): TimePhase {
    const t = this._time;
    if (t >= 0.95 || t < 0.08) return "sunrise";
    if (t >= 0.08 && t < 0.42) return "day";
    if (t >= 0.42 && t < 0.58) return "sunset";
    return "night";
  }

  /**
   * Cloud cover for the sky's near-horizon deck, deterministic in [0, 1]: a light overcast by
   * day, clearing toward the night. Derived from the sun elevation, `@derived`.
   */
  public getCloudCover(): number {
    const elevation = this.getSunElevation();
    return 0.2 + 0.22 * smoothstep(-0.1, 0.35, elevation);
  }

  /**
   * Scenic moon phase in [0, 1) on a slow lunar cycle (0 = new, 0.5 = full, 1 = new): one full
   * cycle every `LUNAR_MONTH_DAYS` day-cycles. The moon stays opposite the sun (M6) -- the phase
   * only shapes the terminator in the sky shader (see `SkyMaterial`), so no Sun-Moon astronomy.
   * Deterministic from the elapsed clock (`_days + _time + _lunarOffset`, so pinned `?time=` /
   * `?moon=` captures are reproducible and the cycle still evolves across days in play), @derived.
   */
  public getMoonPhase(): number {
    return fract((this._days + this._time + this._lunarOffset) / LUNAR_MONTH_DAYS);
  }

  /**
   * Pins the scenic moon phase to `phase` in [0, 1) for the CURRENT time of day, exactly:
   * `_lunarOffset = phase * LUNAR_MONTH_DAYS - _time` (a real number; `fract` normalizes the
   * phase). `_time` stays untouched, `_days` keeps counting whole day-cycles afterwards, so the
   * phase evolves from the pinned point -- a running cycle is deterministic and a capture stays
   * exactly where it was pinned. Drives the `?moon=` dev param.
   */
  public pinMoonPhase(phase: number): void {
    const p = ((phase % 1) + 1) % 1;
    this._lunarOffset = p * LUNAR_MONTH_DAYS - this._time;
  }

  /**
   * Horizon haze strength in [0, 1]: peaks while the sun grazes the horizon (twilight), floors
   * at noon and at midnight. The shader additionally gates the tint by the sun's elevation.
   * Deterministic from the sun elevation, `@derived`.
   */
  public getHazeStrength(): number {
    const elevation = this.getSunElevation();
    const nearHorizon = 1.0 - smoothstep(0.05, 0.45, Math.abs(elevation));
    return 0.35 + 0.6 * nearHorizon;
  }

  /**
   * Interpolated sky color based on sun elevation.
   */
  public getSkyColor(): SkyColor {
    return this._byElevation(DAY_SKY, TWILIGHT_SKY, NIGHT_SKY);
  }

  /** Blends a day / twilight / night palette entry by the sun elevation. */
  private _byElevation(day: SkyColor, twilight: SkyColor, night: SkyColor): SkyColor {
    const elevation = this.getSunElevation();
    if (elevation > 0.2) {
      // Full day
      return lerpColor(twilight, day, Math.min(1, (elevation - 0.2) / 0.4));
    }
    if (elevation >= -0.1) {
      // Twilight (sunrise / sunset): 0 at -0.1, 1 at 0.2
      return lerpColor(night, twilight, (elevation - -0.1) / 0.3);
    }
    // Full night
    return night;
  }
}

// Palettes. Day: bright Minceraft sky blue; twilight: warm amber/orange; night: deep navy.
const DAY_SKY: SkyColor = { r: 0.45, g: 0.65, b: 0.95 };
const TWILIGHT_SKY: SkyColor = { r: 0.82, g: 0.42, b: 0.24 };
const NIGHT_SKY: SkyColor = { r: 0.03, g: 0.04, b: 0.08 };
const DAY_ZENITH: SkyColor = { r: 0.2, g: 0.4, b: 0.82 };
const TWILIGHT_ZENITH: SkyColor = { r: 0.28, g: 0.3, b: 0.55 };
const NIGHT_ZENITH: SkyColor = { r: 0.005, g: 0.01, b: 0.035 };
const DAY_LIGHT: SkyColor = { r: 1, g: 1, b: 1 };
const TWILIGHT_LIGHT: SkyColor = { r: 1, g: 0.78, b: 0.6 };
const NIGHT_LIGHT: SkyColor = { r: 0.55, g: 0.66, b: 1 };
/** One full scenic lunar cycle every N day-cycles (see {@link DayNightCycle.getMoonPhase}). */
export const LUNAR_MONTH_DAYS = 4;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function fract(x: number): number {
  return ((x % 1) + 1) % 1;
}

function lerpColor(a: SkyColor, b: SkyColor, t: number): SkyColor {
  const clampT = Math.max(0, Math.min(1, t));
  return {
    r: a.r + (b.r - a.r) * clampT,
    g: a.g + (b.g - a.g) * clampT,
    b: a.b + (b.b - a.b) * clampT,
  };
}
