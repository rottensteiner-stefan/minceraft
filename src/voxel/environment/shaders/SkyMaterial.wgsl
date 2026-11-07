// Voxel sky dome (M6 + M6-nightsky) -- WebGPU / WGSL twin of SkyMaterial.vert/frag.glsl; keep the
// look in sync. Lanes: u_matParam0 = [sunDirection.xyz, starVisibility],
// u_matParam1 = [horizonColor.rgb, time], u_matParam2 = [zenithColor.rgb, 0],
// u_matParam3 = [cloudCover, moonPhase, haze, 0]. Own output struct (not `Out`): see BlockMaterial.wgsl.
[WGSL_STRUCTS]

struct SkyOut {
    @builtin(position) pos: vec4f,
    @location(0) dir: vec3f,
}

const SUN_RADIUS: f32 = 0.045;
const MOON_RADIUS: f32 = 0.034;
const STAR_GRID: f32 = 150.0;
const STAR_DENSITY: f32 = 0.0035;
// Nightsky tuning constants -- keep byte-identical to SkyMaterial.frag.glsl (parity test).
const CLOUD_GRID: f32 = 5.0;
const CLOUD_DRIFT: f32 = 0.014;
const CLOUD_BAND_BOTTOM: f32 = 0.06;
const CLOUD_BAND_TOP: f32 = 0.24;
const CLOUD_OCTAVES: f32 = 3.0;
const HAZE_FALLOFF: f32 = 16.0;
// Terminator ramp width (angular). Small relative to MOON_RADIUS so the phase shape reads
// correctly; the phase offset is pushed past the disc for full/new (x1.06 below).
const PHASE_SMOOTH: f32 = 0.004;

fn starHash(pIn: vec3f) -> f32 {
    var p = fract(pIn * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

fn cloudHash(pIn: vec2f) -> f32 {
    var p = fract(pIn * 0.1031);
    p = p + vec2f(dot(p, p + vec2f(34.7, 34.7)));
    return fract(p.x * p.y * 71.9);
}

fn cloudNoise(pIn: vec2f) -> f32 {
    let i = floor(pIn);
    let f = fract(pIn);
    let u = f * f * (3.0 - 2.0 * f);
    let a = cloudHash(i);
    let b = cloudHash(i + vec2f(1.0, 0.0));
    let c = cloudHash(i + vec2f(0.0, 1.0));
    let d = cloudHash(i + vec2f(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn cloudFbm(pIn: vec2f) -> f32 {
    var p = pIn;
    var v = 0.0;
    var a = 0.5;
    for (var i = 0u; i < u32(CLOUD_OCTAVES); i = i + 1u) {
        v += a * cloudNoise(p);
        p = p * 2.0 + vec2f(1.7, 1.7);
        a *= 0.5;
    }
    return v;
}

@vertex fn vs(@location(0) pos: vec3f) -> SkyOut {
    var vsOut: SkyOut;
    let wp = obj.model * vec4f(pos, 0.0) + vec4f(global.viewPos.xyz, 1.0);
    let clip = view.vp * wp;
    vsOut.pos = vec4f(clip.xy, clip.w * 0.99999, clip.w);
    vsOut.dir = pos;
    return vsOut;
}

@fragment fn fs(i: SkyOut) -> @location(0) vec4f {
    let d = normalize(i.dir);
    let sunDir = normalize(obj.matParam0.xyz);
    let starVisibility = obj.matParam0.w;
    let horizon = obj.matParam1.rgb;
    let zenith = obj.matParam2.rgb;
    let time = obj.matParam1.w;
    let cloudCover = obj.matParam3.x;
    let moonPhase = obj.matParam3.y;
    let hazeAmount = obj.matParam3.z;

    let up = clamp(d.y, 0.0, 1.0);
    var sky = mix(horizon, zenith, pow(up, 0.5));

    // M6-nightsky horizon haze: see the GLSL twin.
    let horizonGlow = exp(-abs(d.y) * HAZE_FALLOFF);
    let sunNearHorizon = smoothstep(0.12, 0.0, abs(sunDir.y));
    let hazeColor = mix(vec3f(0.05, 0.07, 0.12), vec3f(1.0, 0.62, 0.34), sunNearHorizon);
    sky += hazeColor * (horizonGlow * hazeAmount);

    let sunCos = dot(d, sunDir);
    let aboveHorizon = smoothstep(-0.03, 0.04, d.y);
    let sunVisible = smoothstep(-0.12, 0.02, sunDir.y);
    let glow = pow(max(sunCos, 0.0), 14.0) * 0.45 * sunVisible;
    sky += vec3f(1.0, 0.72, 0.42) * glow;
    let disc = smoothstep(cos(SUN_RADIUS * 1.25), cos(SUN_RADIUS), sunCos) * sunVisible;
    sky = mix(sky, vec3f(1.0, 0.97, 0.86), disc * aboveHorizon);

    // Moon: always opposite the sun (M6); scenic phase terminator (see the GLSL twin).
    let moonDir = -sunDir;
    let moonCos = dot(d, moonDir);
    let moonVisible = smoothstep(-0.12, 0.02, moonDir.y);
    let moonDisc = smoothstep(cos(MOON_RADIUS * 1.3), cos(MOON_RADIUS), moonCos) * moonVisible;
    let terminator = cos(moonPhase * 6.2831853) * 1.06;
    var tang = cross(vec3f(0.0, 1.0, 0.0), moonDir);
    if (abs(moonDir.y) > 0.99) {
        tang = cross(vec3f(1.0, 0.0, 0.0), moonDir);
    }
    let bit = normalize(cross(moonDir, tang));
    let q = dot(d, bit);
    let phaseLit = smoothstep(0.0, PHASE_SMOOTH, q - terminator * MOON_RADIUS);
    sky = mix(sky, vec3f(0.86, 0.9, 1.0), moonDisc * aboveHorizon * phaseLit);

    let cell = d * STAR_GRID;
    let h = starHash(floor(cell));
    let star = step(1.0 - STAR_DENSITY, h);
    let centre = 1.0 - smoothstep(0.0, 0.42, length(fract(cell) - vec3f(0.5)));
    let twinkle = 0.65 + 0.35 * sin(time * 2.4 + h * 400.0);
    let starAlpha = star * centre * twinkle * starVisibility * smoothstep(0.02, 0.2, d.y) * (1.0 - moonDisc);
    sky += vec3f(0.9, 0.93, 1.0) * starAlpha;

    // M6-nightsky clouds: see the GLSL twin.
    let sunUp = smoothstep(-0.06, 0.28, sunDir.y);
    let twilight = (1.0 - sunUp) * (1.0 - smoothstep(0.0, 0.12, abs(sunDir.y)));
    let cloudP = d.xz / (d.y + 0.16);
    let drift = vec2f(time * CLOUD_DRIFT, time * CLOUD_DRIFT * 0.37);
    let cn = cloudFbm(cloudP * CLOUD_GRID + drift);
    let band = smoothstep(CLOUD_BAND_BOTTOM * 0.6, CLOUD_BAND_BOTTOM * 1.4, d.y) *
               (1.0 - smoothstep(CLOUD_BAND_TOP * 0.9, CLOUD_BAND_TOP * 1.6, d.y));
    let thresh = 1.0 - cloudCover * 0.75;
    let cover = smoothstep(thresh - 0.14, thresh + 0.14, cn);
    var cloudCol = mix(vec3f(0.14, 0.17, 0.25), vec3f(0.95, 0.97, 1.0), sunUp);
    cloudCol = mix(cloudCol, vec3f(1.0, 0.6, 0.32), twilight * 0.9);
    let cloudShade = mix(0.45, 1.0, sunUp);
    sky = mix(sky, cloudCol * cloudShade, cover * band);

    return vec4f(displayToTarget(sky), 1.0);
}
