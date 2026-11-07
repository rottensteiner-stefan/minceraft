import { CullMode, CustomShaderMaterial, StandardWebGPULayout } from "@small-world-machine/engine";
import GLSL_FRAG from "./shaders/SkyMaterial.frag.glsl?raw";
import GLSL100_FRAG from "./shaders/SkyMaterial.frag.glsl100?raw";
import GLSL_VERT from "./shaders/SkyMaterial.vert.glsl?raw";
import GLSL100_VERT from "./shaders/SkyMaterial.vert.glsl100?raw";
import WGSL from "./shaders/SkyMaterial.wgsl?raw";
import type { SkyColor } from "./DayNightCycle.js";

/**
 * Procedural sky of the Minceraft (M6 + M6-nightsky): horizon-to-zenith gradient, sun and
 * moon discs (moon with a scenic phase terminator), twinkling stars, a procedural near-horizon
 * cloud deck and a horizon haze band, drawn by a `CustomShaderMaterial` on a cube that follows
 * the camera (GLSL300 for WebGL2, WGSL for WebGPU; the two sources must keep the same look).
 * Everything that changes over the day arrives through four lanes written in place, so a frame
 * allocates nothing:
 *
 * - `u_matParam0 = [sunDirection.xyz, starVisibility]` (the moon is opposite the sun)
 * - `u_matParam1 = [horizonColor.rgb, time]`
 * - `u_matParam2 = [zenithColor.rgb, 0]`
 * - `u_matParam3 = [cloudCover, moonPhase, haze, 0]`
 *
 * WebGL1 (glsl100) gets a deliberately SIMPLIFIED fallback (tiered-renderer autonomy): gradient,
 * sun, FULL moon and stars only -- no clouds / phases / haze. It reads the same lane names and
 * the app keeps writing all four lanes; the extra lane is simply not declared there. Display-
 * referred output without gamma encode, like every WebGL1 forward shader (MetalRelief, ADR 0049).
 */
export class SkyMaterial extends CustomShaderMaterial {
  private readonly _sunLane: number[] = [0, 1, 0, 0];
  private readonly _horizonLane: number[] = [0.45, 0.65, 0.95, 0];
  private readonly _zenithLane: number[] = [0.2, 0.4, 0.82, 0];
  /** [cloudCover, moonPhase, haze, 0]; moonPhase defaults to 0.5 = full moon (M6 look). */
  private readonly _atmosLane: number[] = [0, 0.5, 0, 0];

  constructor() {
    super({
      sources: {
        glsl300: { vs: GLSL_VERT, fs: GLSL_FRAG },
        glsl100: { vs: GLSL100_VERT, fs: GLSL100_FRAG },
        wgsl: WGSL,
      },
      layout: { ...StandardWebGPULayout, textures: {} },
      properties: {},
      cullMode: CullMode.NONE,
      depthWrite: false,
    });
    this.properties["u_matParam0"] = this._sunLane;
    this.properties["u_matParam1"] = this._horizonLane;
    this.properties["u_matParam2"] = this._zenithLane;
    this.properties["u_matParam3"] = this._atmosLane;
  }

  /** Sets where the sun is (it may be below the horizon) and how visible the stars are [0, 1]. */
  public setSun(direction: readonly [number, number, number], starVisibility: number): void {
    this._sunLane[0] = direction[0];
    this._sunLane[1] = direction[1];
    this._sunLane[2] = direction[2];
    this._sunLane[3] = starVisibility;
  }

  /** Sets the gradient: the colour at the horizon and at the zenith (display-referred sRGB). */
  public setGradient(horizon: SkyColor, zenith: SkyColor): void {
    this._horizonLane[0] = horizon.r;
    this._horizonLane[1] = horizon.g;
    this._horizonLane[2] = horizon.b;
    this._zenithLane[0] = zenith.r;
    this._zenithLane[1] = zenith.g;
    this._zenithLane[2] = zenith.b;
  }

  /** Sets the animation clock (seconds) that drives the star twinkle and the cloud drift. */
  public setTime(seconds: number): void {
    this._horizonLane[3] = seconds;
  }

  /**
   * Sets the nightsky atmosphere, all clamped to [0, 1]:
   * `cloudCover` (0 = clear, 1 = overcast), `moonPhase` (0 = new, 0.5 = full, 1 = new -- scenic
   * terminator, the moon stays opposite the sun) and `haze` (horizon haze strength). Writes the
   * `u_matParam3` lane in place (zero allocation per frame).
   */
  public setAtmosphere(cloudCover: number, moonPhase: number, haze: number): void {
    this._atmosLane[0] = clamp01(cloudCover);
    this._atmosLane[1] = clamp01(moonPhase);
    this._atmosLane[2] = clamp01(haze);
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
