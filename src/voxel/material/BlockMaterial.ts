import {
  CustomShaderMaterial,
  ShaderPropertyType,
  StandardWebGPULayout,
  VERTEX_COLOR_FLAG,
} from "@small-world-machine/engine";
import type { Texture, TextureArray } from "@small-world-machine/engine";
import { BLOCK_SWATCH_SIZE } from "../palette/AtlasPixels.js";
import GLSL_FRAG from "./shaders/BlockMaterial.frag.glsl?raw";
import GLSL100_FRAG from "./shaders/BlockMaterial.frag.glsl100?raw";
import GLSL_VERT from "./shaders/BlockMaterial.vert.glsl?raw";
import GLSL100_VERT from "./shaders/BlockMaterial.vert.glsl100?raw";
import WGSL from "./shaders/BlockMaterial.wgsl?raw";

/**
 * Block material: a `CustomShaderMaterial` whose shaders sample the block palette. On WebGPU
 * (WGSL) and WebGL2 (GLSL300) the palette is a `TextureArray`, so tiles can never bleed into each
 * other (`sampler2DArray` / `texture_2d_array`). WebGL1 has no array textures: given a single 2D
 * `Texture` (the WebGL1 2D atlas, `createBlockAtlas2D`), the GLSL100 pair maps the per-vertex layer
 * into the atlas root tile and tiles the mesher UVs per voxel in the fragment (`fract`, same as
 * the array tiers); a texel-lock keeps every sample inside its own tile
 * (`BlockMaterial.vert/frag.glsl100`).
 *
 * - The palette is bound as `u_diffuseMap`, the one texture name WebGPU binds as an array view
 *   (the engine flags a `TextureArray` as `USE_TEXTURE_ARRAY` on its own).
 * - Layer, AO and baked light travel per vertex in the vertex color (`a_color` / location 11,
 *   `USE_VERTEX_COLOR`): `x` = atlas layer, `y` = AO, `z` = baked light.
 * - The dynamic lanes are shared by every tier: `u_matParam0 = [daylight, sunDirection.xyz]`,
 *   `u_matParam1 = [lightTint.rgb, 0]`. They are written in place, nothing allocates per frame.
 * - WebGL1-only: `u_atlasGrid = [cols, rows, atlasWidthPx, atlasHeightPx]` (set via
 *   `setAtlasGrid`). The property is harmless on the array paths: `UniformPacker` ignores
 *   properties outside the layout and the GL renderers guard missing uniform locations by name.
 */
export class BlockMaterial extends CustomShaderMaterial {
  /** `u_matParam0`: `[daylight, sunDirection.xyz]`. */
  private readonly _sunLane: number[] = [1, 0.55, 0.82, 0.28];
  /** `u_matParam1`: `[lightTint.rgb, 0]`. */
  private readonly _tintLane: number[] = [1, 1, 1, 0];
  /** `u_atlasGrid`: `[cols, rows, atlasWidthPx, atlasHeightPx]` -- written by `setAtlasGrid` on
   *  the WebGL1 2D-atlas path only (see `createBlockAtlas2D`). */
  private readonly _atlasGridLane: number[] = [0, 0, 0, 0];

  constructor(atlas: Texture | TextureArray) {
    const arrayPath = (atlas as TextureArray).isTextureArray === true;
    super({
      sources: arrayPath
        ? {
            glsl300: { vs: GLSL_VERT, fs: GLSL_FRAG },
            wgsl: WGSL,
          }
        : {
            glsl100: { vs: GLSL100_VERT, fs: GLSL100_FRAG },
          },
      // The WGSL path packs the fixed 512-byte object block (`u_matParam0/1` ride in it); GLSL
      // reads the same lanes by name. `u_atlasGrid` is a plain property (no layout entry): the
      // WebGPU uniform packer iterates the layout only and ignores it, so the two tiers never see it.
      layout: {
        ...StandardWebGPULayout,
        textures: { u_diffuseMap: { type: ShaderPropertyType.TEXTURE } },
      },
      properties: {},
      textures: { u_diffuseMap: atlas },
      flags: [VERTEX_COLOR_FLAG],
      // M2 water (D3): the atlas alpha drives blending per fragment. Opaque tiles sample
      // alpha 1.0 and render opaque; the water layer blends against the opaque bed. depthWrite
      // stays true so opaque geometry keeps writing depth; the rare water-over-water overlap in
      // the transparent pass is an accepted alpha-sort limitation (documented in the plan).
      transparent: true,
      depthWrite: true,
    });
    if (!arrayPath) {
      this.properties["u_atlasGrid"] = this._atlasGridLane;
    }
    this.properties["u_matParam0"] = this._sunLane;
    this.properties["u_matParam1"] = this._tintLane;
  }

  /** Sets the dynamic day/night ambient multiplier [0.15, 1.0]. */
  public setDaylight(value: number): void {
    this._sunLane[0] = value;
  }

  /** Sets the 3D direction vector of the sun. */
  public setSunDirection(dir: readonly [number, number, number]): void {
    this._sunLane[1] = dir[0];
    this._sunLane[2] = dir[1];
    this._sunLane[3] = dir[2];
  }

  /** Sets the colour of the light (warm at sunrise, blue-grey by moonlight; white by day). */
  public setLightTint(r: number, g: number, b: number): void {
    this._tintLane[0] = r;
    this._tintLane[1] = g;
    this._tintLane[2] = b;
  }

  /**
   * Sets the WebGL1 2D-atlas grid so the GLSL100 shaders can remap tile-local UVs into the atlas
   * and texel-lock samples to their own tile. Must be called with the `cols/rows` returned by
   * `createBlockAtlas2D()` right after construction, before the first frame; the pixel size is
   * derived from `BLOCK_SWATCH_SIZE` (the shader and the factory share that constant via the
   * data-layer tests). No-op for the array-texture paths (the property is never declared there).
   */
  public setAtlasGrid(cols: number, rows: number): void {
    this._atlasGridLane[0] = cols;
    this._atlasGridLane[1] = rows;
    this._atlasGridLane[2] = cols * BLOCK_SWATCH_SIZE;
    this._atlasGridLane[3] = rows * BLOCK_SWATCH_SIZE;
  }
}
