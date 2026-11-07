# Minceraft Steuerung: PC, macOS, PlayStation (PS4/PS5) & Nintendo Switch Referenzdossier

> Referenzdokument für die Steuerungs- und Eingabe-Architektur des **Minceraft** in Small World Machine (SWM).
> Basis: Minceraft Java & Bedrock Edition Standard-Belegungen, macOS-Besonderheiten, Trackpad-/Maus-Verhalten, DualShock 4 / DualSense, Nintendo Switch (Joy-Con & Pro Controller) sowie Ableitung für WebGL/WebGPU & HTML5 Gamepad API.

---

## 1. Vollständige Standardbelegung (Minceraft Java Edition)

### 1.1 Bewegung & Fortbewegung
| Aktion | Taste (PC / Windows / Linux) | Taste (macOS) | Bemerkung |
| :--- | :--- | :--- | :--- |
| **Vorwärts** | `W` | `W` | Standard-Bewegung |
| **Rückwärts** | `S` | `S` | Standard-Bewegung |
| **Links strafen** | `A` | `A` | Seitwärtsschritt |
| **Rechts strafen** | `D` | `D` | Seitwärtsschritt |
| **Springen / Auftauchen** | `Space` (Leertaste) | `Space` (Leertaste) | Im Wasser: Auftauchen |
| **Fliegen (Kreativ)** | `Doppeltipp Space` | `Doppeltipp Space` | Startet/beendet Flugmodus; Halten = Aufsteigen |
| **Schleichen / Absteigen** | `Left Shift` | `Left Shift` | Verhindert Herunterfallen an Blockkanten; im Flug: Sinken |
| **Sprinten** | `Left Ctrl` oder `Doppeltipp W` | `Left Control` oder `Doppeltipp W` | Erhöht Schritttempo und Sprungweite |

---

### 1.2 Maus- & Spielwelt-Interaktionen
| Aktion | Eingabe | Funktion & Verhalten |
| :--- | :--- | :--- |
| **Kamera / Blickrichtung** | Mausbewegung (Pointer Lock) | Pitch (Auf/Ab) & Yaw (Links/Rechts); Cursor ist gefangen |
| **Angreifen / Abbauen** | `Linksklick` (Button 0 / LMB) | Einzeltreffer bei Mobs; Halten baut Blöcke schrittweise ab (Break-Animation) |
| **Benutzen / Platzieren** | `Rechtsklick` (Button 2 / RMB) | Block anvisiert an Nachbarfläche platzieren; Kisten/Türen/Hebel betätigen; Essen |
| **Block wählen (Pick Block)** | `Mittelklick` (Button 1 / MMB) | Im Survival: Wählt Block aus Inventar in Hotbar. Im Kreativmodus: Kopiert anvisierten Block direkt |
| **Hotbar durchscrollen** | `Mausrad Auf / Ab` | Weiterschalten der aktiven Hotbar-Slots 1–9 |

---

### 1.3 Inventar & Hotbar-Verwaltung
| Aktion | Taste (PC) | Taste (macOS) | Bemerkung |
| :--- | :--- | :--- | :--- |
| **Inventar öffnen / schließen** | `E` | `E` | Schließt auch per `Esc` oder erneut `E` |
| **Hotbar-Slot 1 bis 9** | `1` bis `9` | `1` bis `9` | Direkte Slot-Auswahl |
| **Item wegwerfen (Drop)** | `Q` | `Q` | Wirft 1 Item des aktiven Stacks |
| **Ganzen Stack wegwerfen** | `Ctrl + Q` | `Control + Q` *(Achtung: nicht Cmd+Q!)* | Wirft alle Items des Slots weg |
| **Zweithand tauschen (Swap)** | `F` | `F` | Wechselt Item zwischen Haupt- und Nebenhand |
| **Schnellverschieben (Shift-Click)** | `Shift + Linksklick` | `Shift + Linksklick` | Schneller Stack-Transfer Truhe ↔ Inventar / Auto-Craft |

---

### 1.4 Funktionstasten & F3-Debug-Kombinationen
Auf vielen Mac-Tastaturen (MacBook, Magic Keyboard) muss standardmäßig die **`fn`**-Taste gehalten werden (`fn + F3`), sofern in macOS nicht „F1, F2 usw. als Standard-Funktionstasten verwenden“ aktiv ist.

| Taste / Shortcut | Funktion | Nutzen im Spiel & Prototyp |
| :--- | :--- | :--- |
| `F1` | HUD ein-/ausblenden | Screenshot- / Cinematic-Modus (versteckt Fadenkreuz & UI) |
| `F2` | Screenshot aufnehmen | Speichert PNG im Screenshot-Ordner |
| `F3` | Debug-Screen ein-/ausblenden | Zeigt FPS, Koordinaten (XYZ), Block/Chunk-Koord, Blickrichtung, Biome, Speicher |
| `F5` | Perspektive wechseln | First-Person → Third-Person hinten → Third-Person vorne |
| `F11` | Vollbildmodus umschalten | Auf Mac oft von macOS belegt (Mission Control / Desktop anzeigen) |
| `F3 + A` | Alle Chunks neu laden | Zwingt Mesher & Renderliste zum kompletten Rebuild |
| `F3 + B` | Entity-Hitboxen anzeigen | Visualisiert Kollisions-AABB und Blickvektor |
| `F3 + G` | Chunk-Grenzen anzeigen | Zeichnet 16×16-Chunk-Gitterkanten in die Welt |
| `F3 + H` | Erweiterte Tooltips | Zeigt Item-IDs, Haltbarkeitswerte, NBT-Tags |
| `F3 + C` | Koordinaten / Teleport kopieren | Kopiert `/tp`-Befehl in Zwischenablage (10s Halten = Test-Crash) |
| `Esc` | Menü / Pause / Cursor freigeben | Löst HTML5 Pointer Lock, öffnet Einstellungsmenü |

---

## 2. Plattformunterschiede: PC (Windows / Linux) vs. macOS

### 2.1 Modifier-Tasten und Tastenkonflikte
* **`Command ⌘` vs. `Control ⌃`:**
  * Windows/Linux nutzen `Strg` (`Ctrl`) universell für Sprinten und Stack-Drops.
  * Unter macOS ist `Control` die Standard-SWM/Minceraft-Taste für Sprinten.
  * **Toxische Tastenkombination `Cmd + Q`:** Auf dem Mac schließt `Command + Q` die aktive Applikation ohne Rückfrage. Da `Q` direkt neben `W` und `A` liegt (Drop Item) und der Daumen/Zeigefinger leicht `Cmd` streift, beenden Mac-Spieler häufig versehentlich das Spiel. Minceraft fängt `Cmd+Q` nicht immer nativ ab; im Webbrowser führt `Cmd+Q` bzw. `Cmd+W` zum sofortigen Schließen des Tabs!
* **Standard-Funktionstasten (`fn`-Zwang):**
  * macOS belegt `F1`–`F12` hardwareseitig mit Displayhelligkeit, Mission Control, Launchpad, Mediensteuerung und Lautstärke.
  * Ohne Systemeinstellungs-Wechsel müssen Mac-User zwingend `fn + F3`, `fn + F5` etc. drücken.
  * `F11` (Vollbild auf PC) triggert auf macOS standardmäßig *„Schreibtisch anzeigen“*. Der Mac-Vollbild-Shortcut ist `Control + Command + F`.

### 2.2 Maus-Hardware: 3-Tasten-Maus vs. Apple Magic Mouse
* **Klassische PC-Maus:** Zwei getrennte mechanische Mikroschalter + klickbares Scrollrad. Klare Haptik, gleichzeitiges Drücken von Links+Rechts möglich.
* **Apple Magic Mouse:**
  * Eine einzige durchgehende Touch-Oberfläche mit nur einem physischen Mikroschalter.
  * Rechtsklick wird kapazitiv über die Position des aufgelegten Fingers erkannt. Liegt der Zeigefinger beim Rechtsklick noch minimal auf der linken Seite auf, wird die Eingabe als *Linksklick* interpretiert.
  * Kein physischer Mittelklick vorhanden (Pick Block unmöglich ohne Modifikation oder Rebind).
  * Versehentliches horizontales Wischen auf der Oberfläche triggert unabsichtliche Scroll-Events (Hotbar springt unruhig).

---

## 3. Besonderheiten: Apple Trackpad / MacBook Touchpad

### 3.1 Gängige Trackpad-Gesten in Minceraft
* **Umschauen (Look around):** 1-Finger-Gleiten auf dem Trackpad bei aktivem Pointer Lock.
* **Linksklick / Abbauen:** Einfacher mechanischer Klick oder Tippen mit einem Finger (falls „Tippen zum Klicken“ in macOS aktiv ist).
* **Rechtsklick / Platzieren:**
  * Standard: **2-Finger-Klick / 2-Finger-Tippen**.
  * Historischer macOS-Konflikt: `Control + Klick` erzeugt im macOS-System einen Sekundärklick (Rechtsklick). Da `Control` aber gleichzeitig die Standardtaste für Sprinten ist, führte `Control + Klick` bei vielen Spielern zu unbeabsichtigtem Platzieren statt Schlagen im Sprint.
* **Mittelklick (Pick Block):**
  * Mac-Trackpads besitzen von Haus aus **keinen 3-Finger- oder Mittelklick-Standard** für Mausklicks.
  * Minceraft-Spieler auf Mac rebinden „Pick Block“ typischerweise auf eine freie Tastatur-Taste (z. B. `R`, `C` oder `V`) oder nutzen Zusatztools wie *MiddleClick* / *BetterTouchTool*.
* **Hotbar-Wechsel (Scrollen):**
  * **2-Finger-Wischen nach oben/unten**.
  * *Problem:* Trackpads liefern im Web-Umfeld (DOM `wheel`-Event) kontinuierliche Sub-Pixel-Deltas mit Trägheit (Inertia/Momentum Scrolling). Ohne Filter/Quantisierung wechselt die Hotbar mit einem einzigen Wisch unkontrolliert 20 Slots durch.

### 3.2 Mausbeschleunigung (Mouse Acceleration) & Raw Input
* macOS wendet standardmäßig eine aggressive, nicht-lineare Beschleunigungskurve auf Maus- und Trackpad-Bewegungen an. Schnelle Handbewegungen verziehen das Fadenkreuz überproportional stark.
* In Minceraft Java Edition wurde dafür die Option *„Raw Input“* integriert, die OS-Beschleunigungskurven umgeht.

---

## 4. Gamepad- & Controller-Steuerung: PlayStation 4 / PlayStation 5 (DualShock 4 & DualSense)

Auf PlayStation 4 und PlayStation 5 läuft Minceraft als **Bedrock Edition** (zuvor PS4 Edition) mit nativer Gamepad-Steuerung.

### 4.1 Standardbelegung (DualShock 4 & DualSense)

| Taste / Eingabe | Standard-Aktion | Funktion & Verhalten |
| :--- | :--- | :--- |
| **Linker Stick (L-Stick)** | Bewegen / Laufen | Analoge 360°-Bewegung (Vor/Zurück/Strafe). Neigung bestimmt Schritttempo |
| **L3 (L-Stick Klick)** | Sprinten | Schaltet Sprintmodus um bzw. sprintet bei Vorwärtsbewegung |
| **Rechter Stick (R-Stick)** | Kamera / Blickrichtung | Analoge Blicksteuerung (Pitch / Yaw) |
| **R3 (R-Stick Klick)** | Schleichen / Ducken | Schaltet Ducken/Sneaken um; im Flugmodus: Sinken/Absteigen |
| **R2 (Rechter Trigger)** | Angreifen / Abbauen | Entspricht **Linksklick** (LMB): Block abbauen (Halten) oder Mob schlagen |
| **L2 (Linker Trigger)** | Benutzen / Platzieren | Entspricht **Rechtsklick** (RMB): Block platzieren, Kiste öffnen, Bogen spannen |
| **R1 (Rechter Bumper)** | Hotbar rechts | Nächsten Hotbar-Slot nach rechts auswählen |
| **L1 (Linker Bumper)** | Hotbar links | Nächsten Hotbar-Slot nach links auswählen |
| **Kreuz (✕)** | Springen / Auftauchen / Steigen | Springen; im Wasser auftauchen; Doppeltippen = Flugmodus ein/aus; Halten = Steigen |
| **Kreis (◯)** | Schleichen / Absteigen *(alt.)* | Alternativ/Legacy: Schleichen bzw. von Reittier absteigen |
| **Quadrat (▢)** | Handwerk / Crafting | Öffnet das Crafting-Raster bzw. Schnell-Crafting |
| **Dreieck (△)** | Inventar öffnen / schließen | Öffnet das vollständige Spieler-Inventar |
| **D-Pad Oben (↑)** | Perspektive wechseln | Wechselt Kameraperspektive (First-Person → Third-Person hinten/vorne; entspricht `F5`) |
| **D-Pad Unten (↓)** | Item wegwerfen (Drop) | Wirft das aktuell gehaltene Item aus der Hand weg (entspricht `Q`) |
| **D-Pad Links (←)** | Chat / Befehle öffnen | Öffnet die Chat- und Befehlszeile |
| **D-Pad Rechts (→)** | Emotes-Menü | Öffnet das Emote-Auswahlrad |
| **Options-Taste** | Spielpause / Hauptmenü | Öffnet Pausenmenü und Einstellungen (entspricht `Esc`) |
| **Touchpad-Klick / Create** | Karte / Spielerliste | Zeigt Karte / Scoreboard / Spielerübersicht an |

---

### 4.2 Gegenüberstellung: Tastatur/Maus vs. PlayStation-Controller

| Spielfunktion | PC / Mac (Tastatur & Maus) | PlayStation 4 / 5 Controller |
| :--- | :--- | :--- |
| **Bewegung** | `W`, `A`, `S`, `D` (digital, 8 Richtungen) | **Linker Analogstick** (stufenlos 360°, variable Geschwindigkeit) |
| **Blicksteuerung** | **Mausbewegung** (Pointer Lock) | **Rechter Analogstick** (Winkelgeschwindigkeit, Deadzone) |
| **Primäraktion (Abbauen / Schlag)** | **Linksklick** (LMB) | **R2-Trigger** (analog bis Druckpunkt) |
| **Sekundäraktion (Platzieren / Nutzen)**| **Rechtsklick** (RMB) | **L2-Trigger** (analog bis Druckpunkt) |
| **Springen / Flugmodus** | `Space` / `Doppeltipp Space` | **✕-Taste** / `Doppeltipp ✕` |
| **Hotbar-Navigation** | Ziffern `1`–`9` / Mausrad | **L1 / R1** (Slotweise links/rechts scrollen) |
| **Inventar** | `E` | **△-Taste** |
| **Item abwerfen** | `Q` | **D-Pad Unten (↓)** |
| **Perspektive (F5)** | `F5` (bzw. `fn + F5`) | **D-Pad Oben (↑)** |
| **Pause / Menü** | `Esc` | **Options** |

---

### 4.3 Besonderheiten & Haptik bei PS4/PS5-Controllern
1. **Analoge Trigger (L2 / R2):**
   * Im Gegensatz zu einem binären Mausklick sind L2 und R2 analoge Achsen (Wertebereich `0.0` bis `1.0`).
   * Spiele wie Minceraft setzen einen Schwellenwert (üblich: `> 0.5` oder `> 0.25`), ab dem die Aktion als "gedrückt" gilt, um versehentliches Auslösen durch leichtes Antippen zu verhindern.
2. **Stick-Drift & Deadzones:**
   * Physische Analogsticks driften im Ruhezustand leicht. Ein Deadzone-Filter (üblicherweise 10–15 %) ist zwingend erforderlich, damit der Spieler nicht ohne Eingabe driftet oder die Kamera wandert.
3. **PS5 DualSense Haptics & Adaptive Trigger:**
   * In der nativen PS5-Fassung von Minceraft Bedrock unterstützen adaptive Trigger unterschiedliche Widerstände (z. B. Spannwiderstand beim Bogen oder Vibration je nach abgebautem Blocktyp wie Stein vs. Holz).

---

### 4.4 Web- & Browser-Integration (HTML5 Gamepad API)

Wenn ein DualShock 4 oder DualSense Controller per USB oder Bluetooth an einen PC oder Mac angeschlossen wird, meldet der Browser diesen über die HTML5 **Gamepad API** im `standard`-Mapping:

```typescript
// Standard Gamepad API Mapping (DualShock 4 / DualSense im Browser)
const pad = navigator.getGamepads()[0];
if (pad && pad.mapping === 'standard') {
  const jumpPressed     = pad.buttons[0].pressed; // ✕ (Cross)
  const sneakPressed    = pad.buttons[1].pressed; // ◯ (Circle)
  const inventoryPressed= pad.buttons[3].pressed; // △ (Triangle)
  
  const hotbarLeft      = pad.buttons[4].pressed; // L1 (Bumper)
  const hotbarRight     = pad.buttons[5].pressed; // R1 (Bumper)
  
  const placePressed    = pad.buttons[6].value > 0.25; // L2 (Trigger) -> Place
  const attackPressed   = pad.buttons[7].value > 0.25; // R2 (Trigger) -> Break
  
  const moveX = Math.abs(pad.axes[0]) > 0.15 ? pad.axes[0] : 0; // Left Stick X
  const moveZ = Math.abs(pad.axes[1]) > 0.15 ? pad.axes[1] : 0; // Left Stick Y
  const lookX = Math.abs(pad.axes[2]) > 0.15 ? pad.axes[2] : 0; // Right Stick X
  const lookY = Math.abs(pad.axes[3]) > 0.15 ? pad.axes[3] : 0; // Right Stick Y
}
```

---

## 5. Gamepad-Steuerung: Nintendo Switch (Joy-Con & Pro Controller)

Auf der Nintendo Switch läuft Minceraft ebenfalls als **Bedrock Edition**. Die Steuerung erfolgt über zwei Joy-Cons (im Grip oder an der Konsole), den Nintendo Switch Pro Controller oder im Handheld-Modus.

### 5.1 Standardbelegung (Joy-Con & Pro Controller)

| Taste / Eingabe | Standard-Aktion | Funktion & Verhalten |
| :--- | :--- | :--- |
| **Linker Stick (L-Stick)** | Bewegen / Laufen | Analoge 360°-Bewegung (Vor/Zurück/Strafe) |
| **L-Stick Klick (L3)** | Sprinten | Sprintmodus aktivieren |
| **Rechter Stick (R-Stick)** | Kamera / Blickrichtung | Kamera drehen (Pitch / Yaw) |
| **R-Stick Klick (R3)** | Schleichen / Ducken | Schaltet Ducken/Sneaken um; im Flugmodus: Sinken |
| **ZR (Rechter Trigger)** | Angreifen / Abbauen | Entspricht **Linksklick** (LMB / R2): Block abbauen (Halten) oder Schlagen |
| **ZL (Linker Trigger)** | Benutzen / Platzieren | Entspricht **Rechtsklick** (RMB / L2): Block platzieren, Kiste öffnen, Bogen spannen |
| **R-Taste (Rechter Bumper)** | Hotbar rechts | Nächsten Hotbar-Slot nach rechts auswählen |
| **L-Taste (Linker Bumper)** | Hotbar links | Nächsten Hotbar-Slot nach links auswählen |
| **A-Taste (Rechts)** | Springen / Auftauchen / Steigen | Springen; im Wasser auftauchen; Doppeltippen = Flugmodus |
| **B-Taste (Unten)** | Schleichen / Abbrechen *(alt.)* | Alternativ Ducken / Menü abbrechen |
| **X-Taste (Oben)** | Inventar öffnen / schließen | Öffnet das Spieler-Inventar (entspricht `E` auf PC bzw. `△` auf PS) |
| **Y-Taste (Links)** | Crafting / Handwerksmenü | Öffnet die Werkbank / das Crafting-Menü (entspricht `▢` auf PS) |
| **D-Pad Oben (↑)** | *(Nicht belegt / Frei)* | Kann für Perspektiven-Wechsel (F5) belegt werden |
| **D-Pad Unten (↓)** | Item wegwerfen (Drop) | Wirft das aktuell gehaltene Item aus der Hand weg (entspricht `Q`) |
| **D-Pad Links (←)** | Emotes-Menü | Öffnet das Emote-Auswahlrad |
| **D-Pad Rechts (→)** | Chat / Befehle öffnen | Öffnet die Chat- und Befehlszeile |
| **+ Taste (Plus)** | Spielpause / Hauptmenü | Pausiert bzw. öffnet das Einstellungsmenü (entspricht `Esc` / `Options`) |
| **- Taste (Minus)** | Spielerliste | Zeigt die Online-Spielerliste an (entspricht `Tab`) |

---

### 5.2 Gegenüberstellung: Switch vs. PlayStation vs. PC/Mac

| Spielfunktion | Nintendo Switch | PlayStation 4/5 | PC / macOS (Tastatur/Maus) |
| :--- | :--- | :--- | :--- |
| **Bewegung** | Linker Stick | Linker Stick | `W`, `A`, `S`, `D` |
| **Kamera** | Rechter Stick | Rechter Stick | Mausbewegung |
| **Abbauen / Schlag** | **ZR** (digitaler Trigger) | **R2** (analoger Trigger) | **Linksklick** (LMB) |
| **Platzieren / Nutzen** | **ZL** (digitaler Trigger) | **L2** (analoger Trigger) | **Rechtsklick** (RMB) |
| **Hotbar weiterschalten** | **L / R** | **L1 / R1** | Mausrad / Ziffern `1`–`9` |
| **Springen / Flug** | **A-Taste** (rechte Position) | **✕-Taste** (untere Position) | `Space` |
| **Inventar** | **X-Taste** (obere Position) | **△-Taste** (obere Position) | `E` |
| **Crafting** | **Y-Taste** (linke Position) | **▢-Taste** (linke Position) | Inventar / Werkbank |
| **Item abwerfen** | **D-Pad Unten (↓)** | **D-Pad Unten (↓)** | `Q` |
| **Pause / Menü** | **+ Taste** | **Options** | `Esc` |

---

### 5.3 Besonderheiten der Nintendo Switch-Hardware

1. **Nintendo Face-Button-Layout (A/B & X/Y Tausch):**
   * Im Vergleich zum Xbox- und PlayStation-Schema sind die Bestätigungs-/Aktionstasten vertauscht:
     * Bei Nintendo liegt **A rechts** (in Minceraft = Sprung) und **B unten** (in Minceraft = Ducken/Abbrechen).
     * Auf Xbox liegt *A unten* und *B rechts*; auf PlayStation liegt *✕ unten* und *◯ rechts*.
     * **X oben** öffnet das Inventar, **Y links** das Crafting.
2. **Digitale Trigger (ZL / ZR) vs. Analoge Trigger:**
   * Sowohl die Joy-Cons als auch der Pro Controller verfügen über **reine Mikroschalter (digitale Klicks)** für ZL/ZR, keine stufenlos messbaren analogen Achsen wie bei PS4/PS5 (L2/R2) oder Xbox (LT/RT).
   * Im WebGL-/Gamepad-API-Kontext liefert `buttons[6]` und `buttons[7]` bei Switch-Controllern daher direkt `0` oder `1` ohne Zwischenwerte.
3. **Keine Touchscreen-Steuerung im Handheld-Modus:**
   * Obwohl die Nintendo Switch über einen kapazitiven Touchscreen verfügt, unterstützt Minceraft Switch **keine Gameplay-Touch-Gesten** (kein Tippen zum Abbauen/Platzieren und keine On-Screen-Thumbsticks wie bei Minceraft Pocket Edition / iOS / Android). Die Steuerung erfolgt ausnahmslos über physische Buttons.
4. **Joy-Con Stick-Weg & Deadzone:**
   * Die Miniatur-Analogsticks der Joy-Cons besitzen einen deutlich kürzeren Hebelweg als der DualSense oder Pro Controller.
   * Aufgrund von Alterung und Schmutzanfälligkeit („Joy-Con Drift“) ist eine konfigurierbare Deadzone (mindestens 15–20 %) in der Controller-Abfrage zwingend zu empfehlen.

---

## 6. Konsequenzen & Empfehlungen für Minceraft (SWM)

Für die browserbasierte Small World Machine Voxel-Pipeline (M0 bis M5) ergeben sich daraus konkrete Richtlinien:

1. **Pointer Lock API (`requestPointerLock`)**:
   - Wenn vom Browser unterstützt, sollte `{ unadjustedMovement: true }` angefordert werden, um OS-Mausbeschleunigung auf macOS und Windows zu deaktivieren.
   - `Escape` muss jederzeit zuverlässig den Cursor freigeben und das Menü/HUD anzeigen.

2. **M2-Interaktionen (Break & Place)**:
   - `Button 0` (LMB) bzw. **R2-Trigger**: Block abbauen (mit Hold-Akkumulator für Abbauzeit).
   - `Button 2` (RMB) bzw. **L2-Trigger**: Block platzieren an Nachbarfläche.
   - `Button 1` (MMB): Block picken (ID des anvisierten Blocks in Hand nehmen).
   - **Mac-/Trackpad-Fallback:** Alternative Taste für Pick Block anbieten (z. B. Taste `R` oder `B`), da Trackpad-User keinen MMB besitzen.
   - Rechtsklick-Kontextmenü im Canvas zwingend unterdrücken (`canvas.addEventListener('contextmenu', e => e.preventDefault())`).

3. **Gamepad-Support via HTML5 Gamepad API**:
   - Optionale, nahtlose Controller-Unterstützung im FPS-Behavior (`VoxelPlayerCollision`):
     - Achsen 0 & 1 für WASD-Bewegungssimulation (inkl. Deadzone-Guard `0.15`).
     - Achsen 2 & 3 für Kamera-Pitch & Yaw (`pendingDx`/`pendingDy`).
     - Trigger `buttons[7]` (R2) für Break und `buttons[6]` (L2) für Place.
     - Schultertasten `buttons[4]` (L1) und `buttons[5]` (R1) mit Slot-Debounce zum Weiterschalten der Hotbar.

4. **Trackpad-Wheel-Smoothing (Hotbar)**:
   - Das `wheel`-Event darf nicht 1:1 Slots schalten.
   - Implementierung eines Schwellenwert-Akkumulators (z. B. `deltaAccumulator += event.deltaY; if (Math.abs(deltaAccumulator) > threshold) { stepSlot(); deltaAccumulator = 0; }`) mit Cooldown/Debounce, um macOS-Trägheits-Wischen zu dämpfen.

5. **Modifier-Tasten & Tastatur-Handling**:
   - `event.code` (z. B. `'KeyW'`, `'Space'`, `'ShiftLeft'`) statt `event.key` verwenden, um Tastatur-Layout-Unabhängigkeit (QWERTZ vs QWERTY) zu gewährleisten.
   - Bei `KeyQ` keinen gefährlichen Shortcut im Browser triggern (`preventDefault()` bei Vollbild/Spiel).
   - Sprinten: Neben `ControlLeft` auch `ShiftLeft` oder `KeyR` als konfigurierbare Alternative vorsehen, um `Ctrl+Click`-Kollisionen auf dem Mac zu umgehen.

6. **Debug-Shortcuts**:
   - Statt reiner `F1`–`F12`-Bindungen (die auf Mac `fn` erfordern) sollten im minceraft sekundäre Tastekombinationen existieren (z. B. Taste `F3` ODER Taste `H`/`F` im Prototyp-HUD bzw. D-Pad Oben auf Controllern).
