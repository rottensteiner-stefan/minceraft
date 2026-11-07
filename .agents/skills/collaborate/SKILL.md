---
name: collaborate
description: Multi-agent problem-solving and deliberation protocol with human moderator. Parallel execution with multiple sub-agents (4 agents default: 1 coordinator, 3 workers) on Blackboard/tasks (<topic>.board.jsonl). Modes: plan and decide.
---

# Multi-Agent Collaborate Protocol (Parallel Blackboard)

Protocol for collaborative deliberation, negotiation, and joint problem-solving among autonomous AI agents (different models, vendors, instances, or roles) guided by a human moderator.

**Language Rule:** This skill and all communication between agents MUST BE IN ENGLISH: prompts to sub-agents, tool messages, task assignments, board entries (`post-task`, `post-finding`, `complete-task`, `post-proposal`, `post-vote`), rationales, and agent reports. User-facing responses to the human moderator follow the moderator's preferred language.

**Companion Documents** (same directory):
- `blackboard.md` — Parallel multi-agent collaboration with `<topic>.board.jsonl`, event-sourcing, and task delegation.
- `commands.md` — Streamlined 5-step commands reference & moderator controls.
- `discussion-phase.md` — Rules for discussion, evidence tags, rolling archive, and findings.
- `decide-mode.md` — Section 10: `decide` mode mechanics, outcomes, and final outcome block.
- `implementation-phase.md` — Verification discipline and runtime sign-off during implementation.
- `collab.mjs` — Deterministic CLI helper managing the event-sourced blackboard and state projections.

---

## 1. Overview & Team Structure

### Default Team Setup (4 Agents)
Unless specified otherwise, collaboration operates with a team of **4 agents**:
1. **Coordinator / Moderator (Alice / Lead):** Task decomposition, board state management, synthesizing proposals, and coordinating validation.
2. **Worker 1 – Implementation & Core Dev (Bob):** Code generation, refactoring, and hot-path implementations.
3. **Worker 2 – QA, Testing & Security (Charlie):** Test execution, runtime verification, boundary validation, and finding generation.
4. **Worker 3 – Architecture & Systems Review (Dave):** Contract integrity, memory pools, GC avoidance, and architectural consistency.

### Configurable Team Size & Moderator Limit
- **Setting Agent Limits:** The moderator can specify an agent limit during initialization (`--max-agents <N>`) or dynamically at runtime (`/collaborate --limit <N>` or `node collab.mjs board-limit <topic> <N>`).
- **Dynamic Reallocation:** If the limit is reduced below the current team size, excess worker agents are evicted from the active roster, their incomplete tasks are automatically reverted to `open`, and the Coordinator reassigns them to remaining agents with an explicit status update.

### Mandatory Startup Briefing (Status Message)
Whenever work begins (or the team limit is updated), the coordinator or lead agent **MUST output a clear, concise status briefing**:
- **Topic & Mode:** What objective is being addressed (`plan` or `decide`).
- **Team Size & Limits:** Total number of active agents (and max limit, if configured).
- **Roster & Assigned Roles:** List of each agent with name, assigned role, and immediate task focus.
- **Next Steps:** Initial parallel tasks currently being dispatched.

---

## 2. Streamlined Blackboard Lifecycle (5 Core Operations)

The entire collaborative process executes through 5 simple operations:

```
[1. Init Team]  ──►  [2. Post Task]  ──►  [3. Complete Task]  ──►  [4. Consensus Proposal]  ──►  [5. Resolve & Render]
 (board-init)         (post-task)          (complete-task)          (post-proposal & vote)        (resolve-board & render)
```

1. **Init Team:** `collab.mjs board-init <topic> [Coordinator]` creates `<topic>.board.jsonl`.
2. **Post Tasks:** Coordinator creates work packages: `collab.mjs post-task <topic> <Author> "<Title>" --assign <Worker>`.
3. **Execute & Report:** Parallel workers execute tasks in concurrent sub-agents: `collab.mjs complete-task <topic> <Worker> <TaskId> --result "<Summary>"`. (Optional: `collab.mjs post-finding` for bugs/observations).
4. **Consensus & Voting:**
   - One agent posts a proposal: `collab.mjs post-proposal <topic> <Agent> <P<n>> "<Title>"`.
   - Team members cast votes: `collab.mjs post-vote <topic> <Agent> <P<n>> AGREE --reason "<Rationale>"`.
5. **Resolve & Render:** Coordinator finalizes board: `collab.mjs resolve-board <topic> <Author> --outcome CONSENSUS` and compiles `<topic>.md` via `collab.mjs render <topic>`.

---

## 3. Two-Phase Execution (`plan` Mode)

1. **Phase A — Shared Goals:** Agree upon desired end state, non-negotiable constraints, and performance budgets before assigning code tasks.
2. **Phase B — Implementation Plan:** Divide work packages among workers with minimal overlap. Unavoidable overlaps are marked explicitly (`[OVERLAP: <Domain>: <AgentA> ↔ <AgentB>]`) and resolved collaboratively.

---

## 4. Definition of Agreement (Consensus)

Consensus is strictly achieved when ALL of the following criteria are satisfied:
1. **Shared Goals Agreed:** Clear acceptance criteria defined in Phase A.
2. **Unanimous Approval:** Every team member voted `AGREE` on the active proposal `P<n>`.
3. **No Blocking Objections:** All findings and objections are resolved.
4. **All Overlaps Resolved:** Clear boundaries assigned to respective workers.
5. **Actionable Implementation Plan:** Tasks, files, and verification steps clearly defined.

---

## 5. Moderator & Emergency Controls

The human moderator controls the session via commands detailed in `commands.md`:
- `/collaborate --pause` / `--resume`: Freeze or resume work.
- `/collaborate --stop`: Conclude session immediately.
- `/collaborate --kick <Agent>`: Evict non-responsive agent.
- `/collaborate --decide "<Decision>"`: Break deadlock directly.
- `/collaborate --status`: Global overview across active sessions.

---

## 6. Implementation & Verification Phase

Upon reaching consensus, the session shifts to parallel implementation. Builds and unit tests alone do not prove runtime validity. Follow verification discipline in **`implementation-phase.md`** until `[ABNAHME_ERTEILT]` is granted. Long or disruptive implementations run in their own git worktree, one per session and never per worker (`implementation-phase.md` §9.4).

---

## 7. `decide` Mode

Governs questions with divergent options where "no consensus" is an acceptable outcome. Follow mechanics in **`decide-mode.md`** (evidence tags, critique, stagnation triggers, and outcome blocks).



