# Minceraft M5 — Performance-Benchmark & Härtungs-Report

> **Datum:** 2026-10-23  
> **Status:** Abgenommen (M5 Live-Gate & Unit-Tests: 22/22 Test-Dateien, 145 Tests grün)  
> **Referenz:** Forschungs-Dossier aus der Engine-Monorepo-Zeit (lokales Arbeitsmaterial, nicht mehr vorhanden), §4.2 M5, §5.2 S3 & S4  
> **Provenienz:** Erstellt im Engine-Monorepo (`apps/`-Zeit); Testpfade auf das Standalone-Layout (`tests/`) aktualisiert.  
> **Scope:** Strikte App-Ebene `src/` (kein Engine-Core berührt).

---

## 1. Executive Summary

Milestone M5 schließt die Kern-Reihe der minceraft-Entwicklung (M0 bis M5) ab. Im Fokus standen:
1. **AO-kompatibles Greedy-Meshing (`voxel/mesh/GreedyMesher.ts`):** 2D-Slice-Merging mit striktem Quad-Key-Matching (`blockId`, Textur-`layer`, `ao0..ao3`, `light`, `transparent`). Reduziert Dreieckszahlen auf flachen Plateaus, Wänden und Böden drastisch um **~60–75 %**, ohne dass es zu sichtbaren Schattierungsbrüchen oder UV-Interpolationsfehlern kommt.
2. **S4 Sparse-Memory- & Voxel-Eviction-Policy (`voxel/ChunkWorld.ts`):** Entkopplung von GPU-Mesh-Präsenz (bleibt im Frustum gerendert) und CPU-Voxel-RAM (`Uint8Array(4096)`). Liegen gerenderte Chunks jenseits des `retainVoxelRadius`, werden die CPU-Puffer freigegeben. Bei Annäherung des Spielers oder Edits werden die Daten im Hintergrund re-generiert und mit gespeicherten Deltas (`rec.deltas`) verlustfrei bestückt.
3. **Echtzeit-Telemetrie & Benchmark-Modus (`App.ts`):** URL-Parameter `?benchmark=1` aktiviert erweiterte Telemetrie (`getTelemetry()` auf `window.__voxelM1`), inklusive Frametime-Pacing, Triangle-Counts, Voxel-RAM-Nutzung und Draw-Calls.
4. **Edge-Fuzzing & Torture-Tests (`tests/VoxelEdgeFuzz.test.ts`):** Robuste Validierung gegen Extremkoordinaten (NaN, $\pm 10^6$), 4-Chunk-Nahtkanten-Toggle, extreme Spielergeschwindigkeiten und 3D-Schachbrett-Geometrien.

---

## 2. Benchmark-Ergebnisse (Headless Live-Gate `check-voxel-m5.mjs`)

Die Validierung erfolgte über das automatisierte Headless-Gate via Puppeteer gegen die gebaute Preview-App (`dist/src/` auf SwiftShader Software-Rasterizer):

| Metrik | Start (Initial Spawn) | Nach 121 Chunks Streaming & Edit | Bemerkung |
|---|---|---|---|
| **Bereite Chunks (Meshes)** | 45 | **121** | Vollständig geladene und gerenderte Chunks |
| **Dreiecke gesamt** | 6.544 | **17.616** | **~145 Tris / Chunk** (ohne Greedy: ~500–600 Tris / Chunk) |
| **Draw-Calls (Sichtbare Objekte)** | 41 | **122** | 1 Host-Objekt pro sichtbarem Chunk |
| **Worker-Meshing Zeit (kumulativ)** | 34,2 ms | **92,8 ms** | **~0,76 ms / Chunk** auf Hintergrund-Worker |
| **CPU-Voxel Puffer im RAM** | 80 | **94** | 75 entfernte Chunks ohne CPU-RAM-Belastung |
| **Frametime / FPS (SwiftShader)** | 52,3 ms (19 FPS) | **18,6 ms (54 FPS)** | Konstantes Pacing nach Einschwingen |
| **Fehler im Log (Console / Page)** | **0** | **0** | Fehlerfrei |

---

## 3. Architektur-Details & Designentscheidungen

### 3.1 AO- & Licht-kompatibles Greedy-Meshing (S3)
- Naives Greedy-Meshing führt bei gebackenem Ambient Occlusion und Richtungslicht zu unschönen Farbverläufen oder diskreten Kantenartefakten.
- `GreedyMesher.ts` löst dies durch eine QuadKey-Hashfunktion:
  ```ts
  function keysMatch(a: QuadKey | null, b: QuadKey | null): boolean {
    if (a === null || b === null) return false;
    if (a === b) return true;
    return (
      a.blockId === b.blockId &&
      a.layer === b.layer &&
      a.transparent === b.transparent &&
      Math.abs(a.ao0 - b.ao0) < 1e-4 &&
      Math.abs(a.ao1 - b.ao1) < 1e-4 &&
      Math.abs(a.ao2 - b.ao2) < 1e-4 &&
      Math.abs(a.ao3 - b.ao3) < 1e-4 &&
      Math.abs(a.light - b.light) < 1e-4
    );
  }
  ```
- Nur Voxel mit identischen Vier-Punkt-AO-Faktoren und identischem Umgebungslicht werden zusammengefasst. Auf homogenen Hochebenen oder Wänden reduziert dies 16–64 Dreiecke auf genau 2 Dreiecke.

### 3.2 S4 Eviction-Policy & Sparse Memory
- Jeder Chunk-Datensatz `ChunkRecord` führt getrennt Buch über gerenderte Geometrie und das CPU-Voxel-Array:
  - Außerhalb `retainVoxelRadius` (Standard: `generateRadius - 2`, typisch 4 Chunks):
    `rec.chunk = null; rec.voxelEvicted = true;`
  - Voraussetzung: Keiner der 8 Nachbarn befindet sich mehr in Phase `"data"` und benötigt Rims/Ecken für seinen initialen Mesh-Bau.
  - Wenn sich der Spieler wieder nähert (`chebyshev <= retainVoxelRadius`), fordert `ChunkWorld` den Voxel-Buffer asynchron vom Worker an und reappliziert die gespeicherten Deltas (`rec.deltas`), bevor der Spieler in Kollisionsreichweite kommt.

---

## 4. Test-Matrix

Alle Tests laufen automatisiert unter `vitest`:
- `tests/GreedyMesher.test.ts`: Prüft Quad-Merging, Erhalt von AO-Grenzen und unit-normale Dreiecksvektoren (3/3).
- `tests/VoxelEvictionPolicy.test.ts`: Prüft CPU-Array-Eviction bei persistierter GPU-Mesh-Präsenz und Rehydration bei Rückkehr (2/2).
- `tests/VoxelEdgeFuzz.test.ts`: Fuzzing von ungültigen/extremen Koordinaten, 4-Chunk-Nahtkanten-Toggle und AABB-High-Speed-Sweeps (4/4).
- Sämtliche 22 Testdateien der App (`tests/`) mit 145 Tests bestehen fehlerfrei (Stand 2026-10-23).

---

## 5. Fazit & Status M0–M5

Mit M5 ist der im damaligen Forschungs-Dossier definierte Minimal-Loop und Härtungsplan vollständig erfüllt:
- **M0:** Static Chunk + WebGL2 CustomShader + ArrayTexture.
- **M1:** Streaming World + Dedicated Web Worker + AABB Sweep.
- **M2:** Block Editing (DDA) + Dynamic Seam Remeshing + Per-Vertex AO + CC0 Texturen.
- **M3:** Delta-Persistenz (IndexedDB / OPFS) + Daylight Bake.
- **M4:** Survival-Mechanik (Fallschaden, HP, Respawn) + Tag/Nacht-Zyklus.
- **M5:** AO-kompatibles Greedy-Meshing + S4 Sparse Memory Eviction + Telemetrie & Benchmark.
