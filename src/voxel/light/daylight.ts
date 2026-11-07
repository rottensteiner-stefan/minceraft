/**
 * M3 daylight + point-flood light model (dossier §4.2/§4.3 M3, decisions D4/D5): the baked
 * light factor that travels in the mesh `colors.b` channel. Pure module -- no I/O, no engine
 * import -- so the exact same code drives the worker mesher, the node tests and the QA gate.
 *
 * TWO deterministic, app-level rules (deliberately NOT MC-style physical light, D5 scope-cut):
 *
 * 1. DAYLIGHT HEIGHT RULE `daylightFactorAt(y, surfaceY)` -- bright at/above the column surface,
 *    darker per step downward on a FIXED golden scale. It is a pure function of a cell's OWN
 *    column, which is fully contained in one chunk (single-column world, heights < 16): therefore
 *    seam-exact BY CONSTRUCTION -- no cross-chunk sample, no corner protocol (in contrast to AO).
 *
 * 2. CHEAPEST POINT FLOOD `floodSealedness(openProbes)` -- a hard-cut probe over a fixed ring of
 *    single-axis offsets at Chebyshev distance 1..2 (12 probes). A truly SEALED cell (0 open
 *    probes -- an enclosed pocket/cavity) is darkened to a floor; ANY openness keeps it at full
 *    flood weight. This is the "billigster lokaler BFS + harter Cutoff" from D5: closed volumes
 *    read darker than open ones, with the hard cut -- NOT exact flooding. Probe offsets are
 *    single-axis only, so a border-crossing sample resolves through the existing M1 rim planes
 *    (never through an undefined diagonal), keeping border behaviour deterministic.
 *
 * `combineLight(daylight, flood)` multiplies the two factors and stays in [0,1]. All constants
 * are golden-pinned by `tests/MesherLight.test.ts`.
 */

/** Full daylight at/above the column surface (the gate's "Oberfläche = 1.0"). */
export const LIGHT_SURFACE_FACTOR = 1.0;
/** Daylight lost per block below the column surface (golden curve step). */
export const LIGHT_STEP = 0.16;
/** Hard global underground floor -- never pitch black (readability; AO term dims the rest). */
export const LIGHT_FLOOR = 0.1;
/** Point-flood: fixed single-axis probe offsets around a cell (6 axes x distance 1..2). */
export const FLOOD_OFFSETS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [2, 0, 0],
  [-1, 0, 0],
  [-2, 0, 0],
  [0, 1, 0],
  [0, 2, 0],
  [0, -1, 0],
  [0, -2, 0],
  [0, 0, 1],
  [0, 0, 2],
  [0, 0, -1],
  [0, 0, -2],
];
/** Point-flood sealedness floor: darkening applied to a fully enclosed (0 open probes) cell. */
export const FLOOD_SEALED_FACTOR = 0.7;

/** Rule 1 (D4): daylight from the cell height and its OWN column surface. Golden-pinned curve. */
export function daylightFactorAt(y: number, surfaceY: number): number {
  if (y >= surfaceY) return LIGHT_SURFACE_FACTOR;
  const depth = Math.max(0, surfaceY - y);
  return Math.max(LIGHT_FLOOR, LIGHT_SURFACE_FACTOR - LIGHT_STEP * depth);
}

/** Rule 2 (D5): cheapest point-flood -- sealed (0 open probes) darkens to the floor, any
 *  openness keeps full weight. Monotone, hard-cut, deterministic. */
export function floodSealedness(openProbes: number): number {
  return openProbes >= 1 ? LIGHT_SURFACE_FACTOR : FLOOD_SEALED_FACTOR;
}

/** Combined per-cell light factor in [0,1]. */
export function combineLight(daylight: number, flood: number): number {
  return Math.min(Math.max(daylight * flood, 0), 1);
}
