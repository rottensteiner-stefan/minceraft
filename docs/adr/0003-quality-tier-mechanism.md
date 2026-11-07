# ADR 0003: Quality-Tier-Mechanismus (Detektion → Policy → Override-Sperre)

> **Provenienz:** Übernommen aus Small World Machine (ehemals *Engine-ADR 0035*).
>
> **Bezug für diese App (2026-11-07):** Die Entscheidung ist im Engine-Repo umgesetzt. Alle Dateipfade (`packages/engine/…`, `.agents/…`), Showcase-Nummern, Session-/Claim-Namen und ADR-Nummern im Text beziehen sich auf das Engine-Repo zum Entscheidungszeitpunkt. Für die App relevant: Engine-Optionen `quality`/`postProcessing` (explizit gesetzte Felder sperren ihre Achse gegen die Tier-Policy), Test-Override `?tier=low|medium|high` bzw. `DeviceCaps.forcedTier`.
>
> **Stand-Hinweis (2026-10-21):** Umgesetzt (V1, statischer Resolver, 2026-10-18/19): `core/quality/QualityConfigResolver.ts`, `DeviceCaps.forcedTier` / `?tier=`; das Feld `autoDowngrade` ist entfernt. Die LOW-Matrix weicht von der Skizze ab (kein Post-Resolution-Scale; `hdr=false`, `msaa=0`, `maxAnisotropy=1`, `maxShadowResolution=512`, `maxPixelRatio=1`, HBAO/Fog/LightShafts/MotionTrail/TAA/Bloom aus) und ist unkalibriert (Redmi-Kalibrierung offen). Ebene 4 (Runtime-Feedback) ist wie vorgesehen nicht umgesetzt. Zeilenangaben im Text sind ein historischer Stand.

> **Folgenachricht (2026-10-22, im Zuge EVSM/ADR 0043):** `maxShadowResolution` war ein toter
> Knopf (in keiner Schatten-Allokation gelesen — die Auflösung stammt ausschließlich vom
> `ShadowLight.shadowResolution`-Feld) und ist deshalb aus `QualityConfig`, der LOW-Matrix und
> `AbstractRenderer` entfernt worden (statt es migrationsriskant nachzuwiren). Die Schatten-
> Auflösung steuert der Autor pro Licht; die Tier-Matrix und die Doku erheben hierfür keine
> Behauptung mehr.

> **Status: ACCEPTED** — Promoted 2026-10-18 (Session `swm-quality-tier`). Grundlage: 4-Agent-Recherche
> „mobile-rendering-testing" (Konsens 4/4, Berichte `.agents/scratches/mobile-research/01–04*.md`),
> Audit-Verifikation gegen `HEAD 9ba78f16` und Nutzer-Entscheid zu den offenen Punkten
> (1=V1 statisch, 2=`autoDowngrade`**-Feld wird entfernt**, 3=Generische Override-Sperre).
> **Pfade bezogen auf `HEAD e2227bfc` (2026-10-18, nach ADR 0036/0037/…); parallele Sessions
> können Zeilen verschieben — vor Umsetzung re-validieren.**
> **Übernahme am 2026-10-18:** `claude-perf` committeete dieses ADR als DRAFT in `e2227bfc`;
> die vorliegende Fassung ist die von `swm-quality-tier` darauffolgend auf Accepted gesetzte Version.

## Kontext & Problem

Der Nutzer kann Showcases eines Xiaomi Redmi (Modell 23108RN04Y, identifiziert als Redmi 13C,
MediaTek Helio G85, Mali-G52 MC2, ~96 GFLOPS, ~13.4 GB/s geteilter Speicher, ~5 W sustained) im
selben WLAN nur „sehr zähflüssig" ausführen. Der Audit (Bericht `02`) bestätigt: Die Engine hat
**keine per-Effekt-Auflösungs-/Qualitätssteuerung und keine dynamische Render-Skala** — HBAO,
Volumetrik, Light Shafts, CSM und der Full-Res-Uber-Pass (ACES) laufen alle auf voller
Canvas-Auflösung, was auf Tile-based-Mobile-GPUs (TBR/TBDR) der Worst Case ist.

Der heutige Auto-Downgrade-Pfad (`packages/engine/src/core/SmallWorldMachine.ts:173-200`) setzt im
`start()` **nur einzelne Booleans**, abhängig von `DeviceCaps.getPerformanceTier()`:

| Tier | Effekt des heutigen Blocks |
|---|---|
| LOW | `hdr=false`, `msaa=0`, `maxAnisotropy=1`, `maxShadowResolution=512`, **`postProcessing.enabled=false`** (Post komplett aus) |
| MEDIUM | `msaa=2`, `maxAnisotropy=2` |
| HIGH | keine Overrides |

Dieser Block **schreibt `this.config.quality` und `this.config.postProcessing` nachträglich um**
(zwei Schreiborte für dieselbe Konfiguration — ein Widerspruch zur Fail-Fast-Doktrin in den
AGENTS-Instructions) und **berührt nie Auflösung, Post-Scale oder Einzel-Effekte**. Die einzige
existierende Auflösungs-Stellschraube ist `maxPixelRatio` (`EngineOptions.ts:78`, konsumiert in
`AbstractWebGLRenderer.ts:208` und `WebGPURenderer.ts`), keine Post-Resolution-Scale.

Konsequenz: Das Problem muss die Engine lösen, nicht jede App bzw. jeder Showcase einzeln (kein
Spezialfix für Engine-Showcase 29). Die Persona (Power-User/Art Director, der bewusst konfiguriert) darf dabei
nicht entmündigt werden.

## Entscheidung

Der Quality-Tier-Mechanismus trennt **vier Ebenen**, die heute in einem mutablen `config.quality`
verklebt sind. Kernprinzip: **eine Ebene = eine Zuständigkeit, ein einmaliger Schreibort der
resolved Config, explizite Wahl sperrt Automatik.**

### Ebene 1 — Detektion (bleibt, unverändert)
`DeviceCaps.getPerformanceTier()` und `isMobile()` bleiben die einzige Quelle der
Geräteklassifikation. Das ist Input, kein Hook: keine neuen User-konfigurierbaren Gerät-Knobs.

**Nachtrag 2026-10-18 (Score-Korrektur):** Der Score wurde entgegen der
ursprünglichen „keine Score-Veränderung in V1"-Zeile korrigiert, weil er systematisch falsch lag:
- `deviceMemory` fehlt in Safari/Firefox → zählt jetzt wie ein gut ausgestattetes Gerät (vorher
  Fallback 4 GB = 0 Punkte, dadurch war dort nie HIGH möglich).
- WebGPU-Präsenz gibt keine Punkte mehr (API-Achse ≠ Performance-Achse).
- `isMobile()` nutzt die physische Bildschirmgröße statt der Fensterbreite (Touch-Laptop mit
  schmalem Fenster war „Mobile").
- Neu: GPU-Klasse aus dem unmasked Renderer-String (`GpuClass.ts`, Regex-Tabelle: ±2 Punkte,
  unbekannt = neutral). Software-Renderer (SwiftShader/llvmpipe) zählen als LOW.
- Neu: Test-/Debug-Override `DeviceCaps.forcedTier` bzw. URL-Parameter `?tier=low|medium|high`
  (Device-Simulation, z. B. Redmi-Gegenprobe). Der Golden-Capture (`.agents/scripts/goldens/capture.js`)
  erzwingt `tier=high`, weil SwiftShader sonst auf LOW fiele und die Baselines verändern würde.
Die AGENTS.md-Architektur-Law „Tiered Renderer Autonomy" (aktualisiert 2026-10-18) trennt explizit
**API-Tier** (WebGPU/WebGL2/WebGL1 = Fähigkeiten) von **Performance-Tier** (schwaches/starkes Gerät =
Speed) und verankert, dass jeder Renderer Features/Budgets (Auflösung, Samples, Radii, Counts) nach
Performance-Tier reduzieren darf — genau diese Ebene-1/2-Trennung setzt dieser Resolver um.

### Ebene 2 — Policy (NEU: Quality-Tier-Resolver)
Neu ist ein **deterministischer, einmaliger Resolver**, aufgerufen exakt einmal in
`start()` (nach `createDefaultRendererContext()`, ersetzt den Block `:173-200`). Er bildet
`(Tier, explizite Overrides) → vollständige, normalisierte `QualityConfig` + `PostProcessingConfig``
ab — **inklusive** Post-Resolution-Scale und per-Effekt-Stufen (HBAO/Bloom/Kaskaden/Fog).
Regeln:
- Die Fallback-Werte des heutigen Blocks wandern ersatzlos in die Tier-Matrix (kein Verhaltenstabu).
- Der Resolver liefert eine **geschlossene, einmalig validierte** Konfiguration; `start()` schreibt
  danach nichts mehr an `config.quality`/`config.postProcessing` nach (Fail-Fast: genau ein
  Auflösungsschritt, danach gilt die Config).
- **Kein API-Parity-Cap** (AGENTS-Doktrin „Tiered Renderer Autonomy", Fassung 2026-10-18): WebGPU
  wird nie begrenzt, *weil* WebGL2/1 etwas nicht können, und kein Backend wird als Downgrade-Schritt
  deaktiviert. Die Tier-Matrix ist renderer-unabhängig und gehört zur **Performance-Achse**: Sie
  darf auf jedem Renderer Effekte stufen (half-res, Samples, Kaskaden) oder abschalten, wenn das
  Gerät sonst sein Frame-Budget reißt.
- **Keine Shader-Recompiles durch Tier-Wechsel.** Tier-Entscheidungen werden als
  on/off-Konfiguration und Auflösungs-/Samples-Werte modelliert (statische Variationen via
  konfigurierbarer Uniforms/Konstanten), nicht als Wechsel zwischen verschiedenen Shader-Varianten —
  sonst erzeugen Tier-Wechsel genau die Ruckler, die sie beheben sollen (Bericht `04`).

### Ebene 3 — Override (bleibt, aber als explizite Sperre)
Explizite App-/User-Werte haben **Vorrang** vor der Tier-Policy (Muster aus Bericht `04`,
„explicit choice locks out auto"). Präzisierung (beschlossen 2026-10-18 nach
claude-device-tier-Feedback): Die gesperrte „Achse" ist für Post-Effekte der **gesamte
Effekt-Schlüssel** (Effekt-Objekte sind atomare Einstellgruppen, vgl. Engine-ADR 0001). Wer ein Feld
eines Effekts setzt (z. B. nur `effects.hbao.radius`), übernimmt den ganzen Effekt — die
Policy kann einen vom Autor bearbeiteten Effekt nie auf `enabled:false` setzen; die Tier-Matrix
steuert nur Effekte, die der Autor überhaupt nicht erwähnt hat. Auf der flachen
`QualityConfig`-Ebene bleibt die Feld-Semantik (jedes explizit gesetzte Feld gewinnt).

### Ebene 4 — Runtime-Feedback (optional, NICHT in V1)
Dynamische Render-Skala mit Frame-Time-Hysterese (Mechanismus b, Bericht `04`) — respektiert
Overrides, nur wenn GPU-bound-Evidenz vorliegt, nicht bei CPU-gebundenen Szenen. Wird bewusst aus
V1 heraus gehalten: Es benötigt Eingriffe in `setSize`/Resize-Pfade (damals parallel zu einem laufenden
Renderer-Umbau im Engine-Repo) und verlangt Sustained-Thermal-Messung auf dem Redmi, bevor Werte kalibriert
werden können. Als eigener, späterer Meilenstein (ADR-Ergänzung).

### Was verschwindet / was bleibt

| Hook / Mechanismus | Entscheidung |
|---|---|
| `autoDowngrade`-Block `SmallWorldMachine.ts:173-200` + nachträgliche `config.quality`-Überschreibung | **Entfernt**, ersetzt durch Ebene-2-Resolver |
| `QualityConfig.autoDowngrade`-Feld (`EngineOptions.ts:76`) | **Entfernt (beschlossen, V1)** — API-brechend |
| `DeviceCaps.getPerformanceTier()` / `isMobile()` | **Bleibt** (Ebene 1, Detektion) |
| `maxPixelRatio` + manuelle `msaa`/Qualitätswerte | **Bleibt**, als Override-Sperre (Ebene 3, generisch) |
| Vorhandene Hebel (`renderer.type`-Branching, Post-Pipeline-Runtime-Config, per-Effekt-`enabled`) | **Bleiben** als Implementierungs-Surface der Tier-Matrix |

## Implementierungsansatz (V1-Skizze)

1. Neue logische Einheit (im Kern, in Nähe von `DeviceCaps`/`SmallWorldMachine`): ein
   `QualityConfigResolver` (nicht-global, per Engine-Instanz — AGENTS-Doktrin „No Global Singletons",
   Konsistenz mit `RendererContext`-Muster aus ADR 0032).
2. Tier-Matrix als Daten (fertige Defaults je Tier; Werte müssen am Redmi kalibriert werden,
   Runbook Bericht `03`): LOW = Quarter-Res-AO/HBAO, ≤2 Kaskaden, kleine Bloom-Mips, kein
   Volumetrik-Composite full-res, Post-Resolution-Scale < 1.0; MEDIUM = konservative Stufen;
   HIGH = heutiges Verhalten. Baseline-Invariant: **HIGH muss exakt heutigem Desktop-Verhalten
   entsprechen** (Regressionstest auf die bestehenden Engine-Showcases).
3. `start()` ruft den Resolver einmal auf; danach ist die Config geschlossen.
4. Override-Sperre: explizit gesetzte Felder in `config.quality`/`config.postProcessing` gewinnen
   gegen die Matrix (V1 nur für die dokumentierten Achsen, siehe offene Punkte).

## Offene Entscheidungspunkte — beschlossen (2026-10-18, Nutzer-Entscheid)

1. **V1-Umfang:** **Beschlossen: V1 nur statischer Tier-Resolver (Ebene 2), keine dynamische
   Render-Skala.** Ebene 4 (Runtime-Feedback) bleibt explizit aus V1 heraus; eigener, späterer
   Meilenstein nach Redmi-Kalibrierung und nach dem damaligen Renderer-Umbau.
2. **API-Breaking `autoDowngrade`:** **Beschlossen: Feld wird in V1 entfernt** (nicht nur
   deprecaten). Aufrufer, die `quality.autoDowngrade` setzen, müssen das Feld streichen; die
   Automatik ist künftig implizit (Tier-Policy greift immer, Override-Sperre schützt explizite
   Werte). Konsistent mit dem „Move fast, one cut"-Muster der parallelen Deprecation-Removals.
3. **Override-Umfang in V1:** **Beschlossen: generische Sperre.** Jedes explizit gesetzte
   Qualitäts- bzw. Post-Config-Feld sperrt seine Achse gegen die Tier-Policy („gesetzter Wert =
   gesperrte Achse"). Kein V1 nur für `maxPixelRatio`+`msaa` — die generische Semantik ist weniger
   Code-Sonderfälle und entspricht dem „explizite Wahl sperrt Auto"-Prinzip konsequent.
4. **Kaskaden-/Fog-Werte der LOW-Matrix:** Startwerte in der Tier-Matrix hinterlegt, finale Werte
   nach Redmi-Kalibrierung (Runbook `03`). Kein Block für die Promotion.

Damit sind alle vier Punkte entschieden; die V1-Implementierung beginnt unmittelbar nach dieser
Promotion.

## Consequences

- **API:** `autoDowngrade`-Feld entfällt (beschlossen, V1); Konfigurationssemantik ändert
  sich von „mutabl, zweimal geschrieben" zu „einmal resolved, danach geschlossen".
- **CI/Regression:** Entfernen verlangt eine **Golden-/Showcase-Gegenprobe auf erzwungenem LOW**
  (Redmi-Simulation via erzwungenem Tier + niedriger Auflösung, Runbook `03`) und eine
  HIGH-Invarianz-Prüfung (HIGH muss exakt heutigem Desktop-Verhalten entsprechen).
- **Apps & Showcases:** Neue Default-Sicherheit für Mobile, ohne dass Apps oder Showcases Code
  ändern müssen (kein Sonderfall für Engine-Showcase 29).
- **Engine-intern (historisch):** Die Umsetzung war mit parallelen Engine-Sessions abgestimmt;
  Ebene-4-Eingriffe in `setSize` folgen erst nach dem Renderer-Umbau. Für Apps ohne Belang.

## Referenzen

> Alle Referenzen liegen im Engine-Repo; `.agents/scratches/…` und `.agents/notes/…` sind dort lokales Arbeitsmaterial und nicht versioniert.

- Berichte: `.agents/scratches/mobile-research/01-mobile-gpu-primer.md`, `02-engine-cost-audit.md`,
  `03-device-testing-howto.md`, `04-industry-quality-tier-benchmark.md`
- Wissen: `.agents/notes/codebase-search-knowledge.md` (Abschnitt „2026-10-17 Smartphone-Rendering-Recherche")
- Backlog: Eintrag `2026-09-28 — Smartphone-Performance` (→ Update 2026-10-17)
- Verwandte Engine-ADRs: 0032 (per-Engine Shader Registry, Muster für nicht-globalen Resolver),
  0028 (Normal-Buffer), 0030/0031 (Light Shafts / Froxel Fog als Kostenpunkte der Matrix)
