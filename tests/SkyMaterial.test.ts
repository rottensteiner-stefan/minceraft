import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SkyMaterial } from "../src/voxel/environment/SkyMaterial.js";

const read = (name: string): string =>
  readFileSync(new URL(`../src/voxel/environment/shaders/${name}`, import.meta.url), "utf8");
const frag = read("SkyMaterial.frag.glsl");
const wgsl = read("SkyMaterial.wgsl");

describe("SkyMaterial", () => {
  it("packs sun, gradient and clock into the three lanes in place", () => {
    const material = new SkyMaterial();
    const props = material.getRenderManifest().properties as Record<string, number[]>;
    const [sun, horizon, zenith] = [
      props["u_matParam0"]!,
      props["u_matParam1"]!,
      props["u_matParam2"]!,
    ];

    material.setSun([0, -0.9, 0.4], 0.8);
    material.setGradient({ r: 0.1, g: 0.2, b: 0.3 }, { r: 0.4, g: 0.5, b: 0.6 });
    material.setTime(12.5);

    const next = material.getRenderManifest().properties as Record<string, number[]>;
    expect(next["u_matParam0"]).toBe(sun);
    expect(sun).toEqual([0, -0.9, 0.4, 0.8]);
    expect(horizon).toEqual([0.1, 0.2, 0.3, 12.5]);
    expect(zenith.slice(0, 3)).toEqual([0.4, 0.5, 0.6]);
  });

  it("packs the nightsky atmosphere into the fourth lane in place", () => {
    const material = new SkyMaterial();
    const props = material.getRenderManifest().properties as Record<string, number[]>;
    const atmos = props["u_matParam3"]!;

    material.setAtmosphere(0.4, 0.6, 0.2);

    const next = material.getRenderManifest().properties as Record<string, number[]>;
    expect(next["u_matParam3"]).toBe(atmos); // same array: lanes are written in place
    expect(atmos).toEqual([0.4, 0.6, 0.2, 0]);
  });

  it("defaults the nightsky atmosphere to a clear sky with a full moon and clamps to [0, 1]", () => {
    const material = new SkyMaterial();
    const props = material.getRenderManifest().properties as Record<string, number[]>;
    const atmos = props["u_matParam3"]!;
    expect(atmos).toEqual([0, 0.5, 0, 0]); // full moon (M6 look), no clouds, no haze

    material.setAtmosphere(-1, 2, 3);
    expect(atmos).toEqual([0, 1, 1, 0]);
  });

  it("does not write depth and is visible from inside the cube", () => {
    const manifest = new SkyMaterial().getRenderManifest();
    expect(manifest.state?.depthWrite).toBe(false);
    expect(manifest.state?.culling).toBeDefined();
  });

  it("GLSL and WGSL share the sky look constants", () => {
    for (const name of [
      "SUN_RADIUS",
      "MOON_RADIUS",
      "STAR_GRID",
      "STAR_DENSITY",
      "CLOUD_GRID",
      "CLOUD_DRIFT",
      "CLOUD_BAND_BOTTOM",
      "CLOUD_BAND_TOP",
      "CLOUD_OCTAVES",
      "HAZE_FALLOFF",
      "PHASE_SMOOTH",
    ]) {
      const value = (source: string): string | undefined =>
        new RegExp(`${name}(?::\\s*f32)?\\s*=\\s*([\\d.]+)`).exec(source)?.[1];
      expect(value(wgsl)).toBeDefined();
      expect(value(wgsl)).toBe(value(frag));
    }
  });

  it("pins the sky to the far plane so every terrain pixel wins the depth test", () => {
    expect(read("SkyMaterial.vert.glsl")).toContain("clip.w * 0.99999");
    expect(wgsl).toContain("clip.w * 0.99999");
  });

  it("ships a simplified GLSL100 fallback for WebGL1 (no clouds/phases/haze, display-referred)", () => {
    const sources = new SkyMaterial().getShaderDefinition().sources;
    expect(sources.glsl100?.vs).toBeDefined();
    expect(sources.glsl100?.fs).toBeDefined();

    const frag100 = read("SkyMaterial.frag.glsl100");
    // Tiered-autonomy fallback: the expensive/niche lanes are intentionally absent.
    expect(frag100).not.toContain("CLOUD_GRID");
    expect(frag100).not.toContain("HAZE_FALLOFF");
    expect(frag100).not.toMatch(/moonPhase/); // no scenic phase code
    expect(frag100).not.toContain("u_matParam3"); // the fourth lane is never read on WebGL1
    // Same lane-name contract, display-referred output (no gamma encode).
    expect(frag100).toContain("u_matParam0");
    expect(frag100).toContain("u_matParam1");
    expect(frag100).toContain("u_matParam2");
    expect(frag100).toContain("gl_FragColor");
    expect(frag100).not.toMatch(/displayToTarget\(/);

    const vert100 = read("SkyMaterial.vert.glsl100");
    expect(vert100).toContain("clip.w * 0.99999"); // pinned to the far plane, same trick
    expect(vert100).toContain("uniform vec3 u_viewPos;"); // engine uploads it by name on WebGL1
    expect(vert100).not.toContain("#version 300 es");
  });
});
