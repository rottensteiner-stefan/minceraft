import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const fragSource = readFileSync(
  new URL("../src/voxel/material/shaders/BlockMaterial.frag.glsl", import.meta.url),
  "utf8",
);

const wgslSource = readFileSync(
  new URL("../src/voxel/material/shaders/BlockMaterial.wgsl", import.meta.url),
  "utf8",
);

const frag100Source = readFileSync(
  new URL("../src/voxel/material/shaders/BlockMaterial.frag.glsl100", import.meta.url),
  "utf8",
);

const vert100Source = readFileSync(
  new URL("../src/voxel/material/shaders/BlockMaterial.vert.glsl100", import.meta.url),
  "utf8",
);

describe("BlockMaterial fragment lighting", () => {
  it("keeps the ambient floor inside the direct term (faces with ndl == 0 must not go black)", () => {
    expect(fragSource).toMatch(/\(ambient \+ \(1\.0 - ambient\) \* ndl\)/);
    expect(fragSource).not.toMatch(/\*\s*ndl\s*\*\s*lightFactor/);
  });

  it("WGSL keeps the same ambient floor and reads the same lanes as GLSL", () => {
    expect(wgslSource).toMatch(/\(ambient \+ \(1\.0 - ambient\) \* ndl\)/);
    expect(wgslSource).toContain("obj.matParam0.x"); // daylight
    expect(wgslSource).toContain("obj.matParam0.yzw"); // sun direction
    expect(wgslSource).toContain("obj.matParam1.xyz"); // light tint
    expect(fragSource).toContain("u_matParam0.x");
    expect(fragSource).toContain("u_matParam0.yzw");
    expect(fragSource).toContain("u_matParam1.rgb");
  });

  it("both tiers use the shared ambient constant", () => {
    const ambient = (source: string): string | undefined =>
      /ambient = (\d\.\d+);/.exec(source)?.[1];
    expect(ambient(wgslSource)).toBeDefined();
    expect(ambient(wgslSource)).toBe(ambient(fragSource));
    // The GLSL100 WebGL1 fallback keeps the same ambient floor (shared lighting contract).
    expect(ambient(frag100Source)).toBe(ambient(fragSource));
  });

  it("WGSL samples the palette as an array layer and never names the engine's output struct", () => {
    expect(wgslSource).toContain(
      "textureSampleLevel(u_diffuseMap, s, fract(i.uv), i.layer, 0.0)",
    );
    expect(wgslSource).not.toMatch(/-> Out\b/);
  });

  it("greedy block-unit UVs are tiled per voxel on EVERY tier (fract -- M6-Nachtrag regression)", () => {
    // The greedy mesher emits UVs in block units (0..w over a merged quad); every tier must
    // tile via `fract` in the FRAGMENT stage (never the vertex: interpolating 0..w through
    // `fract` on integer endpoints would collapse the whole quad onto texel 0).
    expect(fragSource).toContain("texture(u_diffuseMap, vec3(fract(v_uv), float(v_texLayer)));");
    expect(wgslSource).toContain("textureSampleLevel(u_diffuseMap, s, fract(i.uv), i.layer, 0.0)");
    expect(frag100Source).toContain("fract(v_uv)");
    // The frag-level `fract` must NOT be shadowed by a vertex-level remap (the WebGL1 twin would
    // leak into neighbouring atlas tiles for merged quads).
    expect(frag100Source).toContain("tile / u_atlasGrid.xy + fract(v_uv)");
    expect(vert100Source).not.toContain("u_atlasGrid");
  });

  it("GLSL100 forwards raw mesher UVs + the per-vertex layer to the fragment stage", () => {
    expect(vert100Source).toContain("attribute vec4 a_color;");
    expect(vert100Source).toContain("v_uv = a_uv;");
    expect(vert100Source).toContain("v_layer = floor(a_color.x + 0.5);");
    expect(vert100Source).toContain("varying float v_layer;");
    expect(vert100Source).toContain("uniform mat4 u_vp;");
    expect(vert100Source).toContain("uniform mat4 u_model;");
    expect(vert100Source).toContain("gl_Position = u_vp * wp;");
    expect(vert100Source).not.toContain("#version 300 es");
    expect(vert100Source).not.toMatch(/sampler2DArray\s+\w+\s*;/); // no array-texture declaration
  });

  it("GLSL100 fragment selects the root tile from v_layer, tiles per voxel and texel-locks inside it", () => {
    // Root tile from the per-vertex layer -- the exact `mod`/`floor` contract of `atlasTilePosition`.
    expect(frag100Source).toContain("mod(v_layer, u_atlasGrid.x)");
    expect(frag100Source).toContain("floor(v_layer / u_atlasGrid.x)");
    // Texel-lock that never steps across the tile seam: `floor(px) + 0.5` stays inside the tile.
    expect(frag100Source).toContain("(floor(px) + vec2(0.5)) / u_atlasGrid.zw");
    expect(frag100Source).toMatch(/\(ambient \+ \(1\.0 - ambient\) \* ndl\)/);
    expect(frag100Source).toContain("gl_FragColor = vec4(lit, tex.a);");
    expect(frag100Source).toContain("u_atlasGrid.zw"); // atlas pixel size for the texel lock
    expect(frag100Source).not.toMatch(/displayToTarget\(/); // WebGL1 writes display-referred
    expect(frag100Source).not.toMatch(/sampler2DArray\s+\w+\s*;/);
    expect(frag100Source).not.toContain("#version 300 es");
  });
});
