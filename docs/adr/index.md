# Architecture Decision Records (ADRs)

Dieser Abschnitt enthält die Architekturentscheidungs-Protokolle, die signifikante architektonische Entscheidungen, Trade-offs und Designprinzipien für **Minceraft** und dessen Zusammenspiel mit Small World Machine dokumentieren.

## Index der Entscheidungen

- **[ADR 0001: Application Persistence & Savegame](./0001-application-persistence-and-savegame.md)** *(vormals Engine-ADR 0041)* — Pflicht-Grundlage für App-Manifest (`app.json`), stabile IDs (`retiredIds`) und Savegame-Treiber (OPFS / IndexedDB).
- **[ADR 0002: App-First-Regel für Genre-Code](./0002-app-first-genre-code-extraction-rule.md)** *(vormals Engine-ADR 0015)* — Genre-spezifischer Gameplay-Code bleibt strikt in der App und wird nicht vorzeitig in den Engine-Kern verlagert.
- **[ADR 0003: Quality Tiers & Performance Budgets](./0003-quality-tier-mechanism.md)** *(vormals Engine-ADR 0035)* — Auflösung der Qualitätsstufen (LOW, MEDIUM, HIGH), Override-Lock-Regel und mobile Performance-Grenzen.
