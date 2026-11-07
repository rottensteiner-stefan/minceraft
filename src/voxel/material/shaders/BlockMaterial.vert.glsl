#version 300 es
// Voxel block vertex shader -- WEBGL2 / GLSL300 (M0, see docs/log.md).
// NOTE: the GLSL ES `#version` directive MUST stay on the first line (before these comments) so
// strict compilers (ANGLE/SwiftShader) do not treat the source as ES 1.00 -- engine convention,
// see web_gl2/chunks/base_vertex_header.vert.glsl.
// Fully custom source: the engine feeds EVERY program the same GlobalUniforms std140 block via
// `WebGLProgramCache.bindToProgram` + the per-draw `u_model` uniform, so this shader declares
// that block VERBATIM (structs + field order must stay byte-identical -- see
// `web_gl2/chunks/base_vertex_header.vert.glsl` for the canonical copy) and reads the atlas
// layer from the fixed vertex-color attribute location 11 (`a_color`, `VERTEX_COLOR_LOCATION`).
in vec3 a_position;
in vec3 a_normal;
in vec2 a_uv;
in vec4 a_color;

struct PointLight {
    vec3 pos;
    float distance;
    vec3 color;
    float decay;
};

struct SpotLight {
    vec3 pos;
    float _pad;
    vec3 dir;
    float _pad2;
    vec3 color;
    float _pad3;
    vec4 params;
};

struct AreaLight {
    vec3 pos;
    float _pad;
    vec3 color;
    float _pad2;
    vec3 right;
    float _pad3;
    vec3 up;
    float _pad4;
    vec3 normal;
    float _pad5;
    vec2 size;
    vec2 params; // x: distance, y: decay
};

layout(std140) uniform GlobalUniforms {
    mat4 u_vp;
    vec3 u_viewPos;
    int _pad0;
    vec3 u_ambientColor;
    int _pad1;
    vec3 u_dirLightColor;
    int _pad2;
    vec3 u_dirLightDir;
    int _pad3;
    int u_numPointLights;
    int u_numSpotLights;
    int u_numAreaLights;
    float u_gamma;
    float u_exposure;
    float _pad4;
    vec2 u_cameraNearFar;
    PointLight u_pointLights[16];
    SpotLight u_spotLights[16];
    AreaLight u_areaLights[4];
    vec2 u_tileSizePx;
    vec4 u_clusterDims;
};

uniform mat4 u_model;

out vec3 v_normal;
out vec2 v_uv;
flat out uint v_texLayer;
out float v_ao;
out float v_light;

void main() {
    vec4 wp = u_model * vec4(a_position, 1.0);
    v_normal = normalize(mat3(u_model) * a_normal);
    v_uv = a_uv;
    v_texLayer = uint(a_color.x + 0.5);
    // M2 baked vertex occlusion (Minceraft 4-level scheme), carried to the fragment.
    v_ao = a_color.y;
    // M3 baked daylight/point-flood light factor (colors.b), carried to the fragment.
    v_light = a_color.z;
    gl_Position = u_vp * wp;
}
