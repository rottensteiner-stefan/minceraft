#version 300 es
// Voxel block fragment shader -- WEBGL2 / GLSL300 (M0+M2+M3, see docs/log.md).
// NOTE: the GLSL ES `#version` directive MUST stay on the first line (engine convention).
// Samples the block palette through a `sampler2DArray` (array textures eliminate atlas seam
// bleeding by construction -- dossier §1.4, Dave-Report fact 4) using the per-vertex layer
// from `v_texLayer` and the face-normal-driven UV. M2/M3:
//   - per-vertex baked AO (`v_ao`, Minceraft 4-level scheme from the VoxelMeshData colors.g)
//     dims the direct term in crevices while the ambient floor keeps them readable;
//   - per-vertex baked light (`v_light`, colors.b -- daylight height rule x cheapest point
//     flood, M3 D4/D5) scales the shaded result underneath the surface;
//   - alpha comes from the ATLAS texture, so the semi-transparent WATER layer blends against
//     the opaque beds beneath (solid tiles sample alpha 1.0 and stay opaque).
// Lighting stays lightweight and SELF-CONTAINED: a fixed stylized directional term, no engine
// light data, no IBL (a later milestone).
precision highp float;
precision highp sampler2DArray;

in vec3 v_normal;
in vec2 v_uv;
flat in uint v_texLayer;
in float v_ao;
in float v_light;

// Global gamma lane + displayToTarget: this stylized shader shades display-referred (ADR 0049).
[LIGHT_DEFS]

// u_diffuseMap: the engine's name for the albedo map, which is what WebGPU binds as a
// texture_2d_array (BlockMaterial.wgsl). Dynamic lanes shared with the WGSL path:
//   u_matParam0 = [daylight, sunDirection.xyz], u_matParam1 = [lightTint.rgb, 0]
uniform sampler2DArray u_diffuseMap;
uniform vec4 u_matParam0;
uniform vec4 u_matParam1;

out vec4 fragColor;

void main() {
    // `fract` tiles block-unit mesher UVs per block: the greedy mesher emits UVs in block units
    // (0..w / 0..h across a merged quad), so 0..1 faces are untouched while merged quads repeat
    // the tile per voxel (same semantics as REPEAT wrap per array layer).
    vec4 tex = texture(u_diffuseMap, vec3(fract(v_uv), float(v_texLayer)));
    vec3 albedo = tex.rgb;

    // M3 baked daylight/point-flood light + M4 dynamic daylight multiplier and sun direction
    vec3 normal = normalize(v_normal);
    vec3 lightDir = normalize(u_matParam0.yzw);
    float ndl = clamp(dot(normal, lightDir), 0.0, 1.0);
    float ambient = 0.34;
    float ao = clamp(v_ao, 0.0, 1.0);
    float lightFactor = clamp(v_light, 0.0, 1.0) * clamp(u_matParam0.x, 0.15, 1.0);
    // The ambient floor must stay inside the direct term: faces turned away from the light
    // (-X, -Y, -Z) have ndl == 0 and would otherwise render pure black.
    vec3 lit = albedo * mix(ambient, 1.0, ao) * (ambient + (1.0 - ambient) * ndl) * lightFactor * u_matParam1.rgb;

    fragColor = vec4(displayToTarget(lit), tex.a);
}
