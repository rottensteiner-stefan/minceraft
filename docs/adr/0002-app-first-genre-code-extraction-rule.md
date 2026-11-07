# ADR 0002: App-First — Genre-spezifischer Gameplay-Code bleibt außerhalb des Kerns

> **Provenienz:** Übernommen aus Small World Machine (ehemals *Engine-ADR 0015*).
>
> **Stand-Hinweis (2026-11-07):** Status: Akzeptiert, gültig. Seit 2026-11-05 leben die Spiele-Apps (u. a. `yad`, `minceraft`) als Standalone-Repos und konsumieren die Engine als versionierte Release-Pakete; im Engine-Monorepo verbleibt nur `apps/sample-apps/light-cycle-arena`. Für Standalone-Apps erzwingt die Paketgrenze die Regel (nur Root-Imports aus `@small-world-machine/*`), im Engine-Repo `eslint.config.js`.

## Kontext

Small World Machine ist eine universelle 3D-Engine. Jede neue Projektidee (ein Doom-artiger Shooter, eine
Lichtzyklus-Arena, ein postapokalyptisches Erkundungsspiel, und jetzt ein hypothetischer
Dino-Plattformer) verleitet zu einer naheliegenden Abkürzung: die genre-spezifische
Mechanik — ein Flatter-Sprung-Charakter-Controller, ein Ei-Wurf-Projektil, eine Seitenscroll-
Verfolgungskamera, ein Lichtspur-Kollisionsraster — direkt in `packages/engine/src/core` zu bauen, weil "die
Engine das doch unterstützen sollte." Unkontrolliert verwandelt das die Engine in einen Haufen
einmaliger, gegenseitig irrelevanter Gameplay-Systeme, von denen jedes für immer seine eigene
Last an API-Stabilität und Abwärtskompatibilität trägt — für ein Feature, das je nur ein einziges
Projekt genutzt hat.

Zum Entscheidungszeitpunkt lagen bereits mehrere Apps im Engine-Monorepo unter `apps/` (`yad`,
`light-cycle-arena`), jede mit ihrem eigenen genre-spezifischen Gameplay-Code vollständig im eigenen
App-Ordner, nicht in `packages/engine/src/core`. Im Engine-Repo wurde dieselbe Entscheidung zuvor in
kleinerem Maßstab getroffen: `Optics.refract()`/`Optics.cauchyIndex()`/`Ray2D.intersectSegment()`
wurden erst dann aus dem Prisma-Dispersions-Code des Engine-Showcases 28 nach `packages/engine/src/math/`
extrahiert, als sie bewusst wiederverwendbar sein sollten — die Extraktion geschah nicht spekulativ beim
Schreiben des Showcases, und der Showcase selbst besitzt weiterhin `outwardFaceNormal()` und die
gesamte `computeSpectralRays()`-Orchestrierung, die lokal blieb, weil nichts anderes sie (bisher)
braucht.

## Entscheidung

**Neuer genre-spezifischer Gameplay-Code für ein neues Projekt beginnt im App-Repo (`src/`),
niemals in `packages/engine/src/core`.** Das gilt für Dinge wie: Charakter-Controller mit genre-spezifischem
Bewegungsgefühl (Flatter-Sprung, Coyote-Time, Jump-Buffering), Waffen-/Projektil-Mechanik,
genre-spezifisches Kamera-Folgeverhalten und jedes andere System, das nur im Kontext des Designs
eines einzigen Spiels Sinn ergibt.

Die Aufgabe der Engine ist es, die *Primitive* bereitzustellen, aus denen diese gebaut werden,
nicht die Genre-Mechanik selbst — z. B. für einen Seitenscroll-Plattformer: das `Behavior`-System
für den Charakter-Controller selbst, `BillboardInstancer`/`Sprite` für 2D-in-3D-Rendering,
`GridLevelBuilder` (`geometry/procgen`) für kachelbasierte Level-Daten, und die
`CameraStrategy`-Architektur als die Nahtstelle, an der eine neue Seitenscroll-Folge-Strategie
andockt (eine neue Strategie-Klasse, die dem bestehenden Muster folgt, kein neues Kernkonzept).

**Die Extraktion an einen gemeinsamen, wiederverwendbaren Ort (ein `packages/engine/src/math`/`packages/engine/src/core`-Utility,
oder irgendwann ein eigenständiges Plugin-Paket) geschieht nur, wenn ein *zweites* echtes Projekt
dasselbe braucht** — nicht spekulativ beim Bau des ersten. Bis dahin ist scheinbare Duplikation
zwischen den genre-spezifischen Systemen zweier Apps kein Problem, das man vorab lösen muss; es
sind einfach zwei Apps, die noch nicht bewiesen haben, dass sie dieselbe Abstraktion brauchen.

## Konsequenzen

- Die Engine bleibt als *universelle* 3D-Engine nutzbar — ein Konsument, der nur Materialien/
  Renderer/Physik will, erbt niemals ein Ei-Wurf-Projektilsystem oder ein Lichtzyklus-
  Kollisionsraster in seinem Bundle.
- Jede App kann lokal-optimale, meinungsstarke Design-Entscheidungen für ihr Genre treffen, ohne
  sie als dauerhafte öffentliche Engine-API aushandeln zu müssen.
- Der Preis wird beim zweiten Projekt bezahlt: etwas bewusste, rückblickende Extraktionsarbeit,
  wenn ein echter zweiter Anwendungsfall auftaucht, statt einer spekulativen, für einen
  hypothetischen Fall entworfenen Abstraktion. Das ist der Tausch, den wir wollen — siehe den
  `Optics`/`Ray2D`-Präzedenzfall oben dafür, wie diese Extraktion in der Praxis aussieht.

**Das hier überdenken, falls:** ein einzelnes genre-spezifisches Projekt sich herausstellt, *genau
dieselbe* Mechanik in zwei seiner eigenen Szenen/Showcases intern zu brauchen (nicht über
getrennte Projekte hinweg) — das ist bereits das "zweiter Bedarf"-Signal und rechtfertigt die
sofortige Extraktion innerhalb der Grenzen dieses Projekts, genau wie `Optics`/`Ray2D` es
innerhalb des Engine-Repositorys getan haben.

**Update (2026-09-12):** Die hypothetische dritte Extraktionsstufe ("oder irgendwann ein
eigenständiges Plugin-Paket") ist jetzt technisch real: Mit der npm-Workspaces-Restrukturierung
sind die Apps (`yad`, `light-cycle-arena`) zu Unterordnern des gemeinsamen
Workspace-Package `@small-world-machine/sample-apps` (`apps/sample-apps/light-cycle-arena`) zusammengefasst, das die Engine
als `@small-world-machine/engine`-Package-Abhängigkeit konsumiert. Die Kernregel bleibt unverändert —
neuer genre-spezifischer Code beginnt weiterhin in der jeweiligen App, Extraktion nach
`packages/engine/src/math`/`src/core` (statt `src/math`/`src/core`) erfolgt weiterhin erst beim
echten zweiten Bedarf.

**Update (2026-11-05):** Die Standalone-Repos (u. a. `yad`, `minceraft`) haben das
Workspace-Package verlassen und binden die Engine über gepinnte GitHub-Release-URLs ein. Damit ist
die Grenze physisch: Genre-Code lebt im App-Repo; braucht ein zweites echtes Projekt dieselbe
Mechanik, wird sie im Engine-Repo extrahiert, released und per Versions-Bump übernommen.
