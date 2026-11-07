[BASE_FRAGMENT_HEADER]
[LIGHT_DEFS]
// Voxel sky dome (M6 + M6-nightsky) -- WebGL2 / GLSL300; SkyMaterial.wgsl is the WebGPU twin and
// must keep the same look. Lanes (written in place by SkyMaterial, shared with the WGSL path):
//   u_matParam0 = [sunDirection.xyz, starVisibility]
//   u_matParam1 = [horizonColor.rgb, time]
//   u_matParam2 = [zenithColor.rgb, 0]
//   u_matParam3 = [cloudCover, moonPhase, haze, 0]
// All colours are display-referred (sRGB, ADR 0049/0050): displayToTarget converts at the end.
// M6-nightsky: a procedural near-horizon cloud deck, a scenic moon phase and a horizon haze band.
// All deterministic from the lanes, no textures. The moon stays opposite the sun (M6); moonPhase
// (0 = new, 0.5 = full, 1 = new) only shapes the terminator -- a scenic simulation, not Sun-Moon
// astronomy. A full moon reproduces the M6 disc exactly.
in vec3 v_dir;
uniform vec4 u_matParam0;
uniform vec4 u_matParam1;
uniform vec4 u_matParam2;
uniform vec4 u_matParam3;

const float SUN_RADIUS = 0.045;  // angular radius in radians-ish (cos-space compare below)
const float MOON_RADIUS = 0.034;
const float STAR_GRID = 150.0;
const float STAR_DENSITY = 0.0035;
// Nightsky tuning constants -- keep byte-identical to SkyMaterial.wgsl (parity test).
const float CLOUD_GRID = 5.0;
const float CLOUD_DRIFT = 0.014;
const float CLOUD_BAND_BOTTOM = 0.06;
const float CLOUD_BAND_TOP = 0.24;
const float CLOUD_OCTAVES = 3.0;
const float HAZE_FALLOFF = 16.0;
// Terminator ramp width (angular). Small relative to MOON_RADIUS so the phase shape reads
// correctly; the phase offset is pushed past the disc for full/new (x1.06 below).
const float PHASE_SMOOTH = 0.004;

float starHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float cloudHash(vec2 p) {
  p = fract(p * 0.1031);
  p += vec2(dot(p, p + vec2(34.7, 34.7)));
  return fract(p.x * p.y * 71.9);
}

float cloudNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = cloudHash(i);
  float b = cloudHash(i + vec2(1.0, 0.0));
  float c = cloudHash(i + vec2(0.0, 1.0));
  float d = cloudHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float cloudFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < int(CLOUD_OCTAVES); i++) {
    v += a * cloudNoise(p);
    p = p * 2.0 + vec2(1.7, 1.7);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 d = normalize(v_dir);
  vec3 sunDir = normalize(u_matParam0.xyz);
  float starVisibility = u_matParam0.w;
  vec3 horizon = u_matParam1.rgb;
  vec3 zenith = u_matParam2.rgb;
  float time = u_matParam1.w;
  float cloudCover = u_matParam3.x;
  float moonPhase = u_matParam3.y;
  float hazeAmount = u_matParam3.z;

  // Gradient: horizon colour up to the zenith colour; below the horizon the horizon colour holds.
  float up = clamp(d.y, 0.0, 1.0);
  vec3 sky = mix(horizon, zenith, pow(up, 0.5));

  // M6-nightsky horizon haze: a soft luminous band hugging the horizon, amber tint while the sun
  // grazes it, cool faint tint at night -- masked by hazeAmount from the day/night cycle.
  float horizonGlow = exp(-abs(d.y) * HAZE_FALLOFF);
  float sunNearHorizon = smoothstep(0.12, 0.0, abs(sunDir.y));
  vec3 hazeColor = mix(vec3(0.05, 0.07, 0.12), vec3(1.0, 0.62, 0.34), sunNearHorizon);
  sky += hazeColor * (horizonGlow * hazeAmount);

  // Sun: warm glow around the disc (strongest at low elevation) plus the disc itself.
  float sunCos = dot(d, sunDir);
  float aboveHorizon = smoothstep(-0.03, 0.04, d.y);
  float sunVisible = smoothstep(-0.12, 0.02, sunDir.y);
  float glow = pow(max(sunCos, 0.0), 14.0) * 0.45 * sunVisible;
  sky += vec3(1.0, 0.72, 0.42) * glow;
  float disc = smoothstep(cos(SUN_RADIUS * 1.25), cos(SUN_RADIUS), sunCos) * sunVisible;
  sky = mix(sky, vec3(1.0, 0.97, 0.86), disc * aboveHorizon);

  // Moon: always opposite the sun (M6). Scenic phase: the terminator offset sweeps from c=-1
  // (full) to c=+1 (new) with moonPhase and cuts the disc along the moon's bitangent axis.
  vec3 moonDir = -sunDir;
  float moonCos = dot(d, moonDir);
  float moonVisible = smoothstep(-0.12, 0.02, moonDir.y);
  float moonDisc = smoothstep(cos(MOON_RADIUS * 1.3), cos(MOON_RADIUS), moonCos) * moonVisible;
  float terminator = cos(moonPhase * 6.2831853) * 1.06;
  vec3 tang = abs(moonDir.y) > 0.99 ? cross(vec3(1.0, 0.0, 0.0), moonDir)
                                    : cross(vec3(0.0, 1.0, 0.0), moonDir);
  vec3 bit = normalize(cross(moonDir, tang));
  float q = dot(d, bit);
  float phaseLit = smoothstep(0.0, PHASE_SMOOTH, q - terminator * MOON_RADIUS);
  sky = mix(sky, vec3(0.86, 0.9, 1.0), moonDisc * aboveHorizon * phaseLit);

  // Stars: sparse points on a cell grid over the sphere, twinkling, only above the horizon.
  vec3 cell = d * STAR_GRID;
  float h = starHash(floor(cell));
  float star = step(1.0 - STAR_DENSITY, h);
  float centre = 1.0 - smoothstep(0.0, 0.42, length(fract(cell) - 0.5));
  float twinkle = 0.65 + 0.35 * sin(time * 2.4 + h * 400.0);
  float starAlpha = star * centre * twinkle * starVisibility * smoothstep(0.02, 0.2, d.y) * (1.0 - moonDisc);
  sky += vec3(0.9, 0.93, 1.0) * starAlpha;

  // M6-nightsky clouds: a deterministic near-horizon deck drawn over the whole sky (opaque once
  // present). Sampled through the direction projected onto a ground plane, so the deck recedes
  // toward the horizon; it drifts slowly with the clock and is lit by sun height and twilight.
  float sunUp = smoothstep(-0.06, 0.28, sunDir.y);
  float twilight = (1.0 - sunUp) * (1.0 - smoothstep(0.0, 0.12, abs(sunDir.y)));
  vec2 cloudP = d.xz / (d.y + 0.16);
  vec2 drift = vec2(time * CLOUD_DRIFT, time * CLOUD_DRIFT * 0.37);
  float cn = cloudFbm(cloudP * CLOUD_GRID + drift);
  float band = smoothstep(CLOUD_BAND_BOTTOM * 0.6, CLOUD_BAND_BOTTOM * 1.4, d.y) *
               (1.0 - smoothstep(CLOUD_BAND_TOP * 0.9, CLOUD_BAND_TOP * 1.6, d.y));
  float thresh = 1.0 - cloudCover * 0.75;
  float cover = smoothstep(thresh - 0.14, thresh + 0.14, cn);
  vec3 cloudCol = mix(vec3(0.14, 0.17, 0.25), vec3(0.95, 0.97, 1.0), sunUp);
  cloudCol = mix(cloudCol, vec3(1.0, 0.6, 0.32), twilight * 0.9);
  float cloudShade = mix(0.45, 1.0, sunUp);
  sky = mix(sky, cloudCol * cloudShade, cover * band);

  fragColor = vec4(displayToTarget(sky), 1.0);
}
