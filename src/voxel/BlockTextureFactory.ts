import {
  Texture,
  TextureArray as TextureArrayImpl,
  TextureFilter,
  TextureWrap,
} from "@small-world-machine/engine";
import type { TextureArray } from "@small-world-machine/engine";
import { BLOCK_TEX_LAYER } from "./BlockRegistry.js";
import {
  ATLAS_PIXEL_HEX,
  BLOCK_ATLAS_COLS,
  BLOCK_SWATCH_SIZE,
  atlasPacking,
  atlasTilePosition,
  decodeHexRgba,
  flipVertical,
} from "./palette/AtlasPixels.js";

/**
 * Builds the M2 block palette as a `TextureArray` from the EMBEDDED 16x16 pixel grids
 * (`voxel/palette/AtlasPixels.ts`, reload: CC0 "16x16 Block Texture Set" (2023) by
 * ARoachIFoundOnMyPillow + Water-Nachzeichnung). No borrowed Mojang textures, provenance in
 * `AtlasPixels.ATLAS_SOURCES`. Switching from the M0 procedural swatches to real art is the
 * M2 atlas turn-in (Entscheid 2026-10-19); the layer indices must match `BLOCK_TEX_LAYER`,
 * which the factory enforces fail-fast here and which a node test pins on the data level
 * (palette/AtlasPixels keys vs BLOCK_TEX_LAYER keys).
 *
 * `createBlockAtlas2D()` is the WebGL1 twin: WebGL1 has no `sampler2DArray`, so the palette is
 * packed into ONE 2D `Texture` (row-major, `BLOCK_ATLAS_COLS` columns) and the block shader
 * selects the root tile from the per-vertex layer (`a_color.x`) and tiles the mesher UVs per
 * voxel in the fragment via `u_atlasGrid` (`fract`, see `BlockMaterial.frag.glsl100`). Every
 * swatch is pre-flipped vertically (`flipVertical`) so "V=1 = swatch top" holds without a GPU
 * flip -- the WebGL1 renderer uploads canvases as-is (`UNPACK_FLIP_Y_WEBGL = false`). Nearest +
 * clamp keeps sampling crisp; the fragment texel-locks to its own tile so 2D-atlas seams stay
 * bleed-free.
 *
 * Browser-only (canvases + `createImageBitmap`); unit tests never touch this module, so the
 * pure voxel/data layer stays node-testable.
 */
function canvasFromRgba(rgba: Uint8Array): HTMLCanvasElement {
  if (rgba.length !== BLOCK_SWATCH_SIZE * BLOCK_SWATCH_SIZE * 4) {
    throw new Error(
      `[BlockTextureFactory] expected ${BLOCK_SWATCH_SIZE * BLOCK_SWATCH_SIZE * 4} rgba bytes, got ${rgba.length}`,
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = BLOCK_SWATCH_SIZE;
  canvas.height = BLOCK_SWATCH_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("[BlockTextureFactory] 2d context unavailable");
  const img = ctx.createImageData(BLOCK_SWATCH_SIZE, BLOCK_SWATCH_SIZE);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Shared fail-fast resolution: returns one RGBA byte array per layer index 0..highest in
 * `BLOCK_TEX_LAYER` order. Both palette builders (array + 2D atlas) call this so the
 * registry/atlas desync guard lives in exactly one place.
 */
function resolveLayerRgba(): Uint8Array[] {
  const entries = Object.entries(BLOCK_TEX_LAYER) as ReadonlyArray<readonly [string, number]>;
  const highest = Math.max(...entries.map(([, index]) => index));
  const grids: Array<Uint8Array | null> = new Array<Uint8Array | null>(highest + 1).fill(null);

  for (const [name, index] of entries) {
    const hex = ATLAS_PIXEL_HEX[name];
    if (hex === undefined) {
      throw new Error(`[BlockTextureFactory] atlas pixel layer "${name}" fehlt in AtlasPixels`);
    }
    grids[index] = decodeHexRgba(hex);
  }

  const missing = grids.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0);
  if (missing.length > 0) {
    throw new Error(
      `[BlockTextureFactory] BLOCK_TEX_LAYER verweist auf unbefüllte Layer-Indizes: ${missing.join(", ")}`,
    );
  }

  return grids as Uint8Array[];
}

/**
 * Creates the block palette `TextureArray`. Layer order follows `BLOCK_TEX_LAYER` indices
 * (the sampler2DArray layer selector in the block shader). Fails fast on any
 * registry/atlas-pixel desync.
 */
export async function createBlockPalette(): Promise<TextureArray> {
  const grids = resolveLayerRgba();

  const bitmaps: ImageBitmap[] = [];
  for (const grid of grids) {
    // Engine standard: "Human Convention First" (flipY: true) so top-of-canvas (grass rim)
    // maps to V=1 (top of 3D block).
    bitmaps.push(await createImageBitmap(canvasFromRgba(grid), { imageOrientation: "flipY" }));
  }
  return TextureArrayImpl.fromImages(bitmaps, {
    minFilter: TextureFilter.NEAREST,
    magFilter: TextureFilter.NEAREST,
    generateMipmaps: false,
    addressModeU: TextureWrap.CLAMP_TO_EDGE,
    addressModeV: TextureWrap.CLAMP_TO_EDGE,
  });
}

/** Result of the WebGL1 2D-atlas build: the texture plus the grid the material feeds `u_atlasGrid`. */
export interface BlockAtlas2D {
  texture: Texture;
  cols: number;
  rows: number;
}

/**
 * Creates the WebGL1 block palette as a single 2D `Texture` (no array textures on WebGL1).
 * Row-major packing with `BLOCK_ATLAS_COLS` columns; the returned `cols/rows` MUST be handed to
 * `BlockMaterial.setAtlasGrid()` so the shader maps tile-local UVs into the atlas -- the factory
 * and the shader share this grid contract (pinned by the data-layer tests against
 * `atlasPacking`/`atlasTilePosition`).
 */
export function createBlockAtlas2D(): BlockAtlas2D {
  const grids = resolveLayerRgba();
  const { cols, rows } = atlasPacking(grids.length, BLOCK_ATLAS_COLS);

  const canvas = document.createElement("canvas");
  canvas.width = cols * BLOCK_SWATCH_SIZE;
  canvas.height = rows * BLOCK_SWATCH_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("[BlockTextureFactory] 2d context unavailable");

  for (let layer = 0; layer < grids.length; layer++) {
    const { col, row } = atlasTilePosition(layer, cols);
    // Pre-flip each swatch vertically (see `flipVertical`): the composite is uploaded as-is, so
    // this CPU-side flip is what keeps grass/water orientation identical to the array path.
    ctx.drawImage(
      canvasFromRgba(flipVertical(grids[layer]!, BLOCK_SWATCH_SIZE)),
      col * BLOCK_SWATCH_SIZE,
      row * BLOCK_SWATCH_SIZE,
    );
  }

  const texture = Texture.fromCanvas(canvas, {
    minFilter: TextureFilter.NEAREST,
    magFilter: TextureFilter.NEAREST,
    generateMipmaps: false,
    addressModeU: TextureWrap.CLAMP_TO_EDGE,
    addressModeV: TextureWrap.CLAMP_TO_EDGE,
  });
  return { texture, cols, rows };
}
