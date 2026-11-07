# `decide` Mode — Details

Extracted from `SKILL.md` (Section 10, numbering preserved). Required reading before making the first turn in `decide` mode; discussion mechanics 10.2–10.5 are detailed in `discussion-phase.md`, Part B. Cross-references refer to `SKILL.md`.

---

## 10. `decide` Mode — Deciding a Question (or Consciously Not)

Purpose: Address any question with multiple possible answers where a **unanimous consensus is not mandatory**—technical, strategic, conceptual, architecture trade-offs, value or taste questions, estimations, or prioritization. The outcome is **either a reasoned decision or a documented "no consensus"**. Both outcomes are valid and complete. The procedure is deterministic (fixed state machine and formal criteria); the discussion content is naturally adaptive.

### 10.1 Initialization
Initialize via `node collab.mjs board-init <topic> [Coordinator] --mode decide [--role <Role>]`. The topic begins with a `## Question` block transferred from the moderator's prompt:
- **Question** (one sentence), **Context/Constraints** (non-negotiable), **Decision Criteria** (e.g., performance, maintainability, risk, cost, visual cohesion—weighted if specified), **Option Framework** (known candidate solutions; new proposals remain allowed).

### 10.2 Phase 1 — Independent Blind Position (Anti-Anchoring)
Phase 1 executes without prior visibility of peer positions: Each agent writes its initial position into `<topic>.blind.<AgentName>.md` and commits its position/hash via `post-finding` or note. The coordinator verifies submissions and synthesizes all positions into `<topic>.md`. Rules, stance binding, and required structure: **`discussion-phase.md`, Part B, 10.2**.

### 10.3 Evidence Tags
Core factual claims must carry `[MEASURED]`, `[SOURCED]`, or `[ASSUMED]`. Value judgments and trade-offs carry `[JUDGMENT]`. A decision must never rely solely on unverified factual assumptions (`[ASSUMED]`). Details: **`discussion-phase.md`, Part B, 10.3**.

### 10.4 Round 2+ — Critique & Revision
Mandatory contents per contribution (strongest counter-argument against each opposing position, defend position or `[POSITION_CHANGE]`, new evidence, line `Novelty: yes|no`): **`discussion-phase.md`, Part B, 10.4**.

### 10.5 Stagnation
A full round yielding only `novelty: false` sets `status: "deadlock"` (`stalled`)—regardless of remaining rounds. Details: **`discussion-phase.md`, Part B, 10.5**.

### 10.6 Conclusion & Outcome Block
**Proposal:** In round $\ge 2$, an agent presents a `[DECISION_PROPOSAL: P<n>]` (technically identical to `[CONSENSUS_PROPOSAL]` in Section 6: unique IDs, signature with residual doubt and retraction condition, fraud protection, signature grace turn). Objections: `[OBJECTION: <Agent>]` with justification; open objections block `CONSENSUS`.

**Outcomes (`outcome`):**

| Outcome | Condition |
| :--- | :--- |
| `CONSENSUS` | All roster members have signed, no open objections/`[TEAM_QUESTION]`s, evidence rules satisfied. $\rightarrow$ `status: "consensus_reached"` (Terminal State). |
| `MAJORITY_WITH_DISSENT` | Status `deadlock`, but $>50\%$ of the roster signed a proposal and each dissenter registered `[DISSENT: <Agent>]` with their rationale. **Moderator-triggered:** `/collaborate --stop --outcome MAJORITY_WITH_DISSENT`. |
| `NO_CONSENSUS` | `deadlock`/`stalled`, moderator terminates via `--stop` (without `--outcome` or with `--outcome NO_CONSENSUS`). A valid completion—not a failure. |
| `MODERATOR_DECISION` | Moderator decides directly via `--decide "<Decision>"`. |

**Outcome Block** (appended to the end of the topic document by the concluding agent):
```markdown
---
## Outcome — <Date>
- **Outcome:** CONSENSUS | MAJORITY_WITH_DISSENT | NO_CONSENSUS | MODERATOR_DECISION
- **Question:** <one sentence>
- **Decision:** <chosen option; or "none" for NO_CONSENSUS>
- **Rationale:** <3–6 lines with evidence tags>
- **Rejected Alternatives & Why:** ...
- **Minority Opinions / Residual Doubts:** <per agent: stance or residual doubt from signature>
- **Unverified Assumptions:** <all remaining [ASSUMED]>
- **Value Judgments:** <core [JUDGMENT] premises and their weighting>
- **Revision Conditions:** <conditions under which this decision should be revisited>
- **History:** Round <N> of <max_rounds>, Participants: <list with stance>
```

### 10.7 Special Case: 1 Agent + Moderator
In `decide` mode, a single agent with the human moderator acting as counter-party is permitted. Every turn contains two distinct sections: **Position** and **Red Team** (strongest counter-case against the position, including `[ASSUMED]` inventory). The blind round is omitted. Outcome is either `MODERATOR_DECISION` or `NO_CONSENSUS`. For true perspective diversity, multiple instances with different `stance` flags are strongly preferred.

