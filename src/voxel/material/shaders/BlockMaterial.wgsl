// Voxel block shader -- WEBGPU / WGSL (M6; the GLSL300 pair is BlockMaterial.vert/frag.glsl and
// must keep the same lighting). Same contract as the WebGL2 path:
//   - the atlas is a `texture_2d_array` bound as `u_diffuseMap` (USE_TEXTURE_ARRAY, set by
//     CustomShaderMaterial for a TextureArray): array layers are separate textures, so tiles can
//     never bleed into each other;
//   - per-vertex layer / AO / baked light arrive in the vertex color (location 11, USE_VERTEX_COLOR):
//     color.x = atlas layer, color.y = AO (Minceraft 4-level scheme), color.z = baked light;
//   - u_matParam0 = [daylight, sunDirection.xyz], u_matParam1 = [lightTint.rgb, 0];
//   - the alpha of the atlas tile blends the water layer against the opaque beds.
// The vertex output is NOT called `Out`/`o`: GPUPipelineCache rewrites the engine's default
// output variable (see StylizedLava.vert.wgsl).
[WGSL_STRUCTS]

struct BlockOut {
    @builtin(position) pos: vec4f,
    @location(0) normal: vec3f,
    @location(1) uv: vec2f,
    @location(2) @interpolate(flat) layer: u32,
    @location(3) ao: f32,
    @location(4) light: f32,
}

@vertex fn vs(
    @location(0) pos: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @location(11) color: vec4f
) -> BlockOut {
    var vsOut: BlockOut;
    let worldPos = obj.model * vec4f(pos, 1.0);
    let m33 = mat3x3f(obj.model[0].xyz, obj.model[1].xyz, obj.model[2].xyz);
    vsOut.normal = normalize(m33 * normal);
    vsOut.uv = uv;
    vsOut.layer = u32(color.x + 0.5);
    vsOut.ao = color.y;
    vsOut.light = color.z;
    vsOut.pos = view.vp * worldPos;
    return vsOut;
}

@fragment fn fs(i: BlockOut) -> @location(0) vec4f {
    // textureSampleLevel: the array view is never mipmapped, and `textureSample` is rewritten by
    // the pipeline cache for the engine's own materials only. `fract` tiles block-unit mesher UVs
    // per block (greedy-merged quads emit 0..w / 0..h; 0..1 faces are untouched) -- the WGSL twin
    // of `fract(v_uv)` in the GLSL300 path, keeping the tiers look-identical.
    let tex = textureSampleLevel(u_diffuseMap, s, fract(i.uv), i.layer, 0.0);
    let daylight = obj.matParam0.x;
    let sunDirection = obj.matParam0.yzw;
    let lightTint = obj.matParam1.xyz;

    let normal = normalize(i.normal);
    let ndl = clamp(dot(normal, normalize(sunDirection)), 0.0, 1.0);
    let ambient = 0.34;
    let ao = clamp(i.ao, 0.0, 1.0);
    let lightFactor = clamp(i.light, 0.0, 1.0) * clamp(daylight, 0.15, 1.0);
    // The ambient floor stays inside the direct term: faces turned away from the sun have ndl == 0.
    let lit = tex.rgb * mix(ambient, 1.0, ao) * (ambient + (1.0 - ambient) * ndl) * lightFactor * lightTint;

    return vec4f(displayToTarget(lit), tex.a);
}
