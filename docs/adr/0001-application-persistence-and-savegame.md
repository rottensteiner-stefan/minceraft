# ADR 0001: Application Persistence & Savegame — Pflicht-Grundlage für App-Manifest, stabile IDs und Laufzeitzustand

> **Provenienz:** Übernommen aus Small World Machine (ehemals *Engine-ADR 0041*).
>
> **Stand-Hinweis (2026-10-31):** Stufen 1 bis 5 sind vollständig umgesetzt: `public/schemas/app.schema.json` sowie `app.json` für alle Sample-Apps (`yad`, `light-cycle-arena`), abgesichert durch `AppManifestValidation.test.ts` und `assertAppManifest()` (`APP_SCHEMA_VERSION = 1`). `public/schemas/level.schema.json` und alle `*.level.json`-Deskriptoren tragen `schemaVersion: 1`; `KitRegistry.loadLevel()` prüft und migriert über `migrateLevelDescriptor()` (`LEVEL_MIGRATIONS`) mit Fail-Fast bei unbekannter Version. **Stufe 3:** Level-Dateien liegen unter `apps/<app>/levels/` (umgezogen: `room1`, `room2`; `LevelValidation`-Scan-Regel erzwingt die Konvention, Stolperstein explizit geprüft). **Stufe 4 (inkl. Runtime-Wiring Teil 1 & 2, 2026-10-30):** `content/<sprache>.json` (`game-app`: `de`/`en`, 198 Schlüssel in 100 % Parität) mit stabilen Text-IDs, durch `app.json`-Deklaration (`content.languages`) ans Manifest gebunden und per `ContentPackageValidation.test.ts` geprüft; `HotspotManager`, `TerminalModal`, `ViennaMapModal`, `room1.level.json`, `room2.level.json` und `prologue.ts` lösen alle Texte über `ContentPackage.t(id)` auf. **Stufe 5 (inkl. Savegame-Treiber & ID-Tombstone-Validierung, 2026-10-31):** Savegame-Format v1 (`public/schemas/savegame.schema.json`, `SavegameTypes.ts` mit `SAVEGAME_SCHEMA_VERSION = 1`, `SAVEGAME_MIGRATIONS`, `migrateSavegameDescriptor` Fail-Fast, `backupSavegameDescriptor` = Backup-vor-Migration-Default, `assertSavegameIdReferences`) sowie die Speicher-Treiber in `SavegameStore.ts` (`OpfsSavegameStore`, `IndexedDbSavegameStore`, `FileSavegameStore`, `createSavegameStore`, `serializeSavegameToFile`, `parseSavegameFromFile`) und die ID-Tombstone-/Eindeutigkeits-Validierung (`retiredIds` in `app.schema.json`, `assertNoRetiredIdReuse`, `assertUniqueLevelEntityIds`) sind produktiv und durch `SavegameValidation.test.ts` (36 Tests) und `AppManifestValidation.test.ts` (23 Tests) abgesichert.

> **Status: ACCEPTED** — 2026-10-19 (Maintainer-Abnahme; ursprünglich DRAFT vom 2026-10-19, Session `swm-ops-b`). Grundlage sind die
> **verbindlichen** Entscheidungen aus `docs/research/application-persistence-whole-world-2026-09-29.md`
> (§12a, 2026-09-29) sowie deren Reihenfolgen-Vorgabe (§10, angepasst §12a).
> **Übernommen am 2026-10-19 (Maintainer-Abnahme):** ACCEPTED als Grundlagendokument; die Umsetzung von
> Schritt 1 (App-Manifest + Schema) erfolgt getrennt und bleibt Voraussetzung für die Implementierung.
> **Scope-Hinweis:** Reine Persistenz-/Dokumentation-Grundlage. Kein Code, kein Build-Eingriff in diesem ADR.

## Kontext & Problem

Die größte bekannte Richtungs-Lücke aus dem Onboarding-Audit: **Application Persistence ist 0 % umgesetzt.**
Der Ist-Zustand (Studie §2.1/§2.3):

- **Level-Deskriptoren** (`*.level.json`, `LevelDescriptor`) und die zweistufige Kit-/Instanz-Runtime
  (`meta.json`-Defaults → Level-Overrides, ADR 0020) existieren und sind der etablierte Weg für
  Dressing und Platzierungen. Kit-Definitionen liegen im Engine-Baum unter `public/assets/kits/`
  (ADR 0011), nicht in einer App.
- **Es gibt kein Savegame.** Laufzeitzustand (Fortschritt, Einstellungen) existiert nicht; es gibt
  keinen Schnitt zwischen „Inhalt" und „Fortschritt" (Schmerzpunkt 7). Sobald ein Level-Update alte
  Spielstände trifft, hat niemand geregelt, wie sie überleben.
- **Es gibt kein App-Manifest.** Was eine App *ist* (Einstieg, Level, Figuren, Kits, Code), ergibt sich
  aus Ordnerkonvention + manuellen Eingängen in `vite.config.ts` (Schmerzpunkt 1).
- **Inhalt lebt im Engine-Repo** und ohne stabile IDs für Konfigurations-/Textinhalte sind
  Lokalisierung, Lektorat und Maker-Editierbarkeit nicht adressierbar (Schmerzpunkte 3, 6).

Die Studie hat in §7 zehn Invarianten synthetisiert (u. a. **IDs zuerst, Authored ≠ Cooked ≠ Runtime,
Prefab = Vorlage + Overrides, Manifest benennt die Einheit, Format rückwärts/forward-kompatibel mit
expliziter Versionsnummer und Migrationskette**) und in §12a acht Auftraggeber-Fragen verbindlich
beantwortet. Dieses ADR verankert die daraus folgenden, die Persistenz betreffenden Entscheidungen als
verbindliche Grundlage, damit alle künftigen Umsetzungen (Docs wie Code) auf einem dokumentierten
Fundament arbeiten statt auf Konventionen.

**STOP-Regel-Befund (Widerspruch benennen, keine stille Glättung):** Die Studie selbst ist in sich
konsistent (siehe Reihenfolge unten). Allein die im Onboarding-Auftrag verwendeten Kurz-Beschriftungen
einzelner Einstiegs-Schritte weichen von den Studien-§10-Titeln ab — „Manifest-Schema" steht dort für
Studien-Schritt 2 („Level-Dateien nach `apps/…/levels/`"), „Text-Paket" für Studien-Schritt 9
(„Dialog-/Terminaltexte als JSON `content/`"). Inhaltlich besteht kein Widerspruch; die Zuordnung wird
in Abschnitt „Primär-Einstieg" explizit ausgewiesen, damit die Nummerierung nachverfolgbar bleibt.

## Entscheidung

Die folgenden Entscheidungen werden aus Studie §12a **als verbindlich verankert**. Sie legen eine
**reine Persistenz-Schicht** fest: Sie bestimmt, *wo* Laufzeitzustand und App-Grenze liegen und *wie*
Versionierung, IDs und Inhalte organisiert sind. Sie überlagert bewusst **keine** Entscheidungen anderer
Subsysteme (Uniforms-Slots, Materialpfade) — siehe Abschnitt „Gleichgewicht".

### 1. Savegame: ja — im Level-Deskriptor-Kontext, nicht als globaler App-Zustand

- Ein **Savegame-Format** wird eingeführt (§12a-4; Studien-Schritt 7 in die erste Runde gezogen).
- Das Savegame ist eine **Erweiterung des Level-Deskriptor-Kontexts** (ADR 0020): Es speichert
  Laufzeitzustand *bezogen auf* konkrete Levels/Instanzen, **keinen** globalen App-Zustand und keine
  Serialisierungen von Inhalts-Objekten (Props/Lichter werden nicht mitgespeichert).
- Es enthält ausschließlich **ID-Referenzen + minimale Zustandsflags** — nie Inhalte
  („Level `room1`, Item `bunker/blast_door` aufgehoben", nicht das Prop selbst). Dadurch
  bricht ein Content-Update Spielstände nicht, solange IDs nie wiederverwendet werden (§9.6, §15.3).
- **Ablage:** IndexedDB/OPFS als Standard, Export als Datei optional; nie `localStorage` für alles
  (Größe, synchron). Sprache ist **Einstellung, kein Spielinhalt**.
- **Harte Regeln beim Bauen** (Studie §15.5): Backup-vor-Migration als Default und
  ID-Referenz-Verbot sind Pflicht, nicht Empfehlung.

### 2. App-Manifest `app.json` mit `schemaVersion`-Kette und stabilen IDs

- Jede App bekommt ein **App-Manifest `app.json`** als einzigen verpflichtenden App-Baustein (§8-B,
  §9.2). Es benennt, was die App *ist*: `id`, `version`, `entry`, eigener Inhalt (Level, Figuren, Code),
  Kit-Abhängigkeiten, Savegame-Deklaration.
- Das Manifest trägt eine **`schemaVersion`-Kette**: die Version des `app.json`-Formats selbst,
  zusammen mit den versionierten Inhaltsschemas, die es referenziert.
- **Stabile IDs:** `namespace:path`; Level-/Figuren-/Text- und Kit-IDs werden **nie wiederverwendet**
  (§12a-4, „IDs werden nie wiederverwendet" als harte Regel). IDs von Tag 1 — billig und nicht
  rückholbar (Godot-UID-Lehre, §3.3).
- Schema-getrieben mit `additionalProperties: false` (wie `level.schema.json`), stabile
  Schlüsselreihenfolge und Pretty-Print für saubere Git-Diffs; jede Änderung als Befehl
  `(id, path, old, new)` im Undo-Stack (Maker-Kompatibilität, §12a-3).

### 3. Text-Ressourcen getrennt (`content/<sprache>.json`), kompiliert gegen das Manifest

- Alle Spielertexte (Dialoge, Terminal, Hotspot-Beschriftungen) bekommen **stabile Text-IDs** und
  liegen in **`content/<sprache>.json`** (§12a-7). Der Code referenziert nur IDs, nie Inhalte.
- Text-IDs unterliegen derselben Regel wie alle IDs: **nie wiederverwenden**.
- Sprachdateien werden im Test gegeneinander auf fehlende/überzählige Schlüssel geprüft — analog
  `AssetKitValidation.test.ts` (§12a-7), d. h. die Text-Pakete **kompilieren gegen das Manifest**
  (jede Text-ID muss im Manifest aufgelöst sein), nicht lose daneben liegen.
- Sprache im Savegame ist eine **Einstellung**, kein Inhalt (§12a-7).

### 4. `schemaVersion`-Politik: Rückwärts-Migration, Fail-Fast bei unbekannter Version

- Jedes persistente Format (`app.json`, `level.json`, Savegame, später `content/*`) trägt eine
  **explizite `schemaVersion`** plus eine **Kette von Migrationen** (alt lesen, neu schreiben) —
  Handmade-Hero-`hha`-Lehre (§4.5), Minecraft-DFU-Muster (§15.3).
- **Fail-Fast bei unbekannter Version:** unbekannte/künftige `schemaVersion` wird beim Laden **hart
  abgelehnt** (ausdrücklicher Fehler) statt still akzeptiert. Rückwärts-Migration nur für die
  dokumentierte, abwärts lesbare Kette — nicht für „beliebige Zukunft".
- Unbekannte **Felder** beim Laden hingegen werden **ignoriert** (Forward-Toleranz, §5.2), damit alte
  Engine-Versionen neue Dateien überleben — das gilt nicht für die `schemaVersion` selbst, die das
  Fail-Fast auslöst.
- Das Savegame-Format wird **vor** dem ersten Speichern-Feature entworfen („Format v1 zuerst",
  §12a-4 — Mojang/DFU kam erst nach dem Schema nach, mit jahrelangem Legacy-Schlepp).

### 5. Umsetzung als eigenständiges Projekt — **Empfehlung, nicht Pflicht** (Scope-Schnitt)

- Die Studie hat in §12a-1 entschieden: *Game App* wird ein **eigenständiges Projekt** und das erste
  Referenzbeispiel. Für den **Persistenz-Scope dieses ADR** gilt das als **Empfehlung, nicht als
  Pflicht**: Die hier verankerten Entscheidungen (Manifest, IDs, Savegame, Text-Pakete, Versionierung)
  greifen unabhängig davon, wo die App physisch lebt (Engine-Repo, Workspace-Paket `private: true`,
  später eigenes Repo). Der physische Auszug (Kits raus aus dem Engine-Repo, ADR-0011-Phase 2; eigenes
  Repo, eigene CI) ist ein eigenständiges Vorhaben mit eigener Planung und bewusst **außerhalb** dieses
  ADR.

### 6. Gleichgewicht mit ADR 0026/0027 (Uniforms) & ADR 0013 — reine Persistenz-Schicht, keine verlustbehaftete Überlagerung

- Diese Schicht **überlagert nicht verlustbehaftet**: Sie wendet keine Ganz-Objekt-Ersetzungen an
  (Bethesda-ESP-Warnung, §4.2), sondern speichert und referenziert Overrides/Patch-Daten am
  Instanz-Branch (Roblox-/Content-Patcher-Muster, §15.1).
- Sie greift **nicht** in die Slot-gebundenen Uniform-Entscheidungen ein (ADR 0026/0027:
  `ObjectUniforms` 256→512 Byte) und **nicht** in die Material-Vereinheitlichung (ADR 0013). Persistenz
  speichert Referenzen und Instanz-Overrides zu diesen Subsystemen, ohne deren interne Layouts zu
  kopieren oder zu überschreiben.
- Ergebnis: Persistenz ist eine **eigene, entkoppelte Schicht** über ADR 0020/0011, die andere
  Architektur-Entscheidungen unangetastet lässt.

### 7. Primär-Einstieg (klein → groß) — die Reihenfolge stoppt, nicht alles auf einmal bauen

Die Umsetzung folgt **zwingend dieser Reihenfolge**; jeder Schritt ist für sich wertvoll, darf hier
aufhören und setzt **keinen** späteren voraus (§10-Begleitsatz). Die Nummern bezeichnen die
Studien-§10-Schritte; die Zuordnung der Kurz-Beschriftung ist explizit ausgewiesen.

| Stufe | Studien-§10-Schritt | ADR-Beschriftung (Inhalt) | Stopp-Gate („hier anhalten") |
| :-: | :-: | :--- | :--- |
| **1** | ggf. 0 (ADR-0011-Statusdrift) · **1** | **`app.json` + `app.schema.json`** — nur `id`, `version`, `entry`, `levels`, `characters`, `kits`; Validierungstest im Stil von `AssetKitValidation.test.ts` (Text-/Authoring-Stufe, kein Laufzeit-Eingriff) | Manifest validiert; App-Grenze benennbar |
| **2** | **5** | **`schemaVersion`-Check** — `schemaVersion` + Migrationskette in `level.schema.json` (Wert `1`, leere Kette) + Fail-Fast-Regel dokumentiert; kostet fast nichts und gehört vor alle Umzüge | Invariante 9 vorbereitet, `schemaVersion`-Politik greift |
| **3** | **2** | **Manifest-Schema** — Level-Dateien nach `apps/…/levels/` (unter das Manifest); `LevelValidation`-Scan-Stolperstein explizit prüfen (Test muss > 0 Dateien finden) | Daten von Controller-Code getrennt, Referenzen laufen über das Manifest |
| **4** | **9** („Text-Paket") | **`content/<sprache>.json`** — stabile Text-IDs + Sprachdateien, gegenseitige Schlüsselprüfung, Kompilierung gegens Manifest | Texte adressierbar, Lokalisierung möglich |
| **5** | **7** | **Savegame-Format v1** — nur Format-Entwurf: ID-Referenzen + minimale Zustandsflags, `schemaVersion`, Migrationskette, Diff-/Patch-Semantik, Ablage IndexedDB/OPFS; Backup-vor-Migration | Format steht, *bevor* das erste Speichern-Feature gebaut wird |

Danach **anhalten und beobachten** (§10/§12a): Build-Umbau (`vite.config.ts` liest `app.json`, Schritt 3),
Assets zu den Konsumenten (Schritt 6) und Kit-Auslagerung (Schritt 8, eigenes Vorhaben mit eigenem
ADR-Update) folgen erst, wenn sie tatsächlich schmerzen.

**Bewusst NICHT Teil dieses ADR** (Studie §10/§12a-2, §12a-8): kein eigenes Archivformat `.swapp`
(auch nicht als Export), keine dritte Layer-Ebene / kein Mod-System (bis ein zweiter Konsument es
braucht), kein Sandbox-Scripting, kein Umbau von Story-Controllern in Deklarativdaten, kein
YAML/TOML/USD, kein SharedArrayBuffer/COOP-COEP-Zwang.

## Konsequenzen

- **Savegames überleben Content-Updates** nur über stabile IDs; „IDs werden nie wiederverwendet" ist
  damit harte, testbare Regel — Folgearbeit: ID-Registry/Validierung in den Persistenz-Tests.
- **App-Grenze wird benennbar** (Manifest) und ist die Grundlage für Maker-Projekt-Ebene (§12a-3),
  `vite.config.ts`-Entlastung (Studien-Schritt 3) und spätere Kit-Auslagerung (Schritt 8) — ohne dass
  dieser ADR eines davon heute baut.
- **Lokalisierung wird machbar** (Text-IDs + `content/<sprache>.json`) und erzwingt die physische
  Trennung von Weltdaten, Text und (später) Stimme (§15.1/§15.2).
- **Fail-Fast-Politik** macht Versionskonflikte zu frühen, klaren Fehlern statt stiller Korruption —
  konsistent mit der Fail-Fast-Doktrin der AGENTS-Instructions.
- **API/Kompatibilität:** Es entstehen neue Dateiformate (`app.json`, `content/*`, Savegame);
  `*.level.json` erfährt eine additive `schemaVersion`-Erweiterung (rückwärts lesbar, solange die
  Migrationskette gepflegt wird). Kein bestehendes Engine-API wird in diesem ADR geändert.
- **CI/Regression:** Neue Validierungstests (Manifest, Text-Pakete, Schema-Versionen) im Stil der
  bestehenden Loader-Tests; `LevelValidation`-Stolperstein (Scan bricht bei `levels/`-Umzug) ist vor
  jedem Umzug explizit zu prüfen.
- **Parallel-Aktivität:** Reine Doku jetzt; die Umsetzung von Stufe 1 (Manifest-Text + Validierungstest)
  berührt `public/schemas/` und Loader-Tests und ist mit den laufenden Wave-2-Owner-Pfaden
  kollisionsarm (keine Renderer-/Material-/Geometrie-Pfade).
- **Verdikt (Scope dieses ADR):** Dieser ADR ist die **Grundlage für alle künftigen
  Persistenz-Umsetzungen** (Docs wie Code). Er verankert die §12a-Entscheidungen, stoppt die
  Umsetzung in der kleinsten nützlichen Stufe und verlangt für alles Weitere einen realen
  Schmerzpunkt (Invariante 10, Muratori/ADR 0015).

## Referenzen

- Studie: `docs/research/application-persistence-whole-world-2026-09-29.md` (§7 Invarianten, §9
  Vorschlag, §10 Migrationspfad, §12a Entscheidungen + angepasste Reihenfolge, §15 Belege aus der
  Industrie-Praxis)
- **Verwandte ADRs** (verlinkt, nicht geändert):
  - [0020 — Declarative Level-Deskriptoren & Kit-Runtime](0020-declarative-level-descriptors-and-kit-runtime.md)
    (Savegame erweitert diesen Kontext)
  - [0011 — Modulare Asset-Kits & Remote-Katalog](0011-modular-asset-kits-and-remote-catalog.md)
    (Kit-Manifeste; Phase 2 Out-of-Tree = eigenständiges Folgevorhaben)
  - [0021 — Ökosystem-Pakete](0021-ecosystem-packages-exotic-geometry-and-physics.md)
    (Paket-Grenzen: App-Inhalt vs. Ökosystem)
  - [0028 — Dünner Normal-Buffer MRT](0028-thin-normal-buffer-mrt.md)
    (Beispiel: Persistenz referenziert Subsystem-Zustand, ohne ihn zu überlagern)
  - [0026/0027 — `ObjectUniforms`-Slots](0026-object-uniforms-256-byte-moat.md) /
    [0027](0027-object-uniforms-512-byte-expansion.md), [0013 — Vereinheitlichte
    Flüssigkeits-Materialien](0013-unified-liquid-surface-material.md)
    (Gleichgewicht: reine Persistenz-Schicht, keine verlustbehaftete Überlagerung)
- Audit-Vorgabe: `.agents/scratches/ops-b-spec.md`; Arbeitsplan (gitignored):
  `.agents/scratches/persistence-impl-plan.md`
- Schemas (Bestand): `public/schemas/{kit,prop-meta,level}.schema.json`; Tests (Bestand):
  `packages/engine/tests/loaders/{AssetKitValidation,LevelValidation}.test.ts`
