# Discussion Phase — Rules for Discussion Turns

Extracted from `SKILL.md` (Section 5 Step 2 and Section 10.2–10.5). Governs interaction between kickoff and consensus/deadlock. Part A applies to both modes, Part B to `decide` mode, Part C to single-agent self-planning. Cross-references refer to `SKILL.md`.

---

## Part A — Discussion Turn (Both Modes)

### Reasoning & Contribution to Topic (Step 2)
1. **Reading: `## Status` + Open Rounds.** The topic document stays lean via rolling archiving. Read `## Status` and any unarchived `## Round` sections.
   - **Rolling Archive Mechanism:** Immediately after `begin-turn`, run `node .agents/skills/collaborate/collab.mjs archive <topic>`. Old rounds ($n \le \text{current\_round} - 2$) are cleanly moved to `<topic>.archive.md`, leaving behind stub lines.
   - **Status Block (Mandatory):** Directly beneath the title resides `## Status (live)` (max ~40 lines). Every active agent updates it in-place at turn end:
     ```markdown
     ## Status (live)
     - Goal / Question: <one sentence>
     - Locked: D1 <Decision> (Round n, Agent) · D2 ...
     - Open: [OBJECTION Agent R<n>] <verbatim> · [TEAM_QUESTION: Title R<n>] · [OVERLAP ...]
     - Proposal: P<n> by <Agent>, Signatures <List>
     - Next: <Agent> to do <Action>
     ```
2. **Formulating Contribution:**
   - Challenge invalid assumptions with constructive dissent.
   - Answer peer questions and open team queries.
   - Propose architectural, implementation, or strategic solutions.
   - **Team Questions (`[TEAM_QUESTION: <Title>]`):** Asking a team-wide question imposes a **mandatory answer obligation** on all peers in their subsequent turns.
3. **Structured Contribution Section:**
   ```markdown
   ## Round <N>: <AgentName> (<Role>) — <Date>

   ### 1. Evaluation & Responses to Prior Rounds
   - Response to question/proposal from <AgentName>: ...

   ### 2. Proposals & Architectural Decisions
   ...

   ### 3. Questions to Team / Consensus Status
   - **Targeted Question to <AgentName>:** ...
   - **Team Query [TEAM_QUESTION]:** ...
   - **Status:** ...
   ```

**Contribution Discipline (Token Budget):**
- **Length:** Target $\le 2\text{ KB}$ (~500 tokens). First round allows up to ~6 KB. Endorsements $\le 10$ lines.
- **No Redundancy:** Do not quote past contributions; reference them (`→ Round 2, Bob, §2`).
- **Language:** English across all notes, artifacts, and inter-agent messages.

---

## Part B — `decide` Mode: Discussion Procedure

### 10.2 Round 1 — Blind Position (Anti-Anchoring)
Round 1 executes without prior visibility into peer positions:
- Each agent reads only `## Question` (and moderator notes) and writes its position into `<topic>.blind.<AgentName>.md`.
- **Commitment:** Once written, record a `finding_posted` or position event with SHA-256 hash in `<topic>.board.jsonl`.
- **Reveal:** The coordinator verifies hashes and synthesizes blind positions into the topic document or board summary under `## Round 1: Blind Positions`.
- `stance` governs only Round 1 to ensure divergent initial exploration.

### 10.3 Evidence Tags (Prevent Shared Hallucinations)
- `[MEASURED: <command/line>]` — Measured directly.
- `[SOURCED: <file/URL>]` — Backed by verifiable source.
- `[ASSUMED]` — Factually unverified assumption.
- `[JUDGMENT: <Standard>]` — Trade-off, architectural aesthetic, or priority.

### 10.4 Round 2+ — Critique & Revision
Must include:
1. **Strongest counter-argument** against each opposing position.
2. **Own position:** Retain or `[POSITION_CHANGE: <from> → <to>] <Reason>`.
3. New tagged evidence.
4. Line `Novelty: yes|no`.

### 10.5 Stagnation
If an entire round yields only `novelty: false`, the session enters `status: "deadlock"` (`stalled`).

---

## Part C — Self-Planning (Single Agent `plan` Mode)

Applies when the roster contains exactly 1 agent and the human moderator acts as counter-party.
1. **Plan Draft:** Standard Phase A goals and Phase B tasks.
2. **Red Team (`### Red Team` mandatory):** The strongest possible case against one's own plan:
   - Identify unverified assumptions (`[ASSUMED]`).
   - Describe the 2 most likely failure modes and early indicators.
   - Propose at least 1 serious alternative.
   - Outline moderator responsibilities.
3. **Response to Red Team:** Adjust plan or document why the objection does not apply.

