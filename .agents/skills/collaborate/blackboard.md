# Blackboard & Event-Sourcing

Extracted from `SKILL.md` (Section 12 and the `board-*` command rows). Used when creating or operating a shared Blackboard (`<topic>.board.jsonl`). Cross-references refer to `SKILL.md`.

---

## 12. Blackboard & Event-Sourcing (Parallel Multi-Agent Collaboration)

> [!IMPORTANT]
> **Parallel Execution Standard:** All multi-agent collaboration operates exclusively via parallel sub-agents operating on the Blackboard. Agents claim tasks, report findings, and deliberate concurrently without sequential locks or turns.

For collaborative problem solving, the protocol defines the **Blackboard Pattern** with a **Single Append-Only Log (`<topic>.board.jsonl`)** and parallel sub-agent tool invocations (`invoke_subagent`).

### 12.1 Default Team Composition (4 Agents)
The default collaborative team consists of **4 agents**:
1. **Coordinator / Moderator (Alice / Lead):** Coordinates the blackboard, breaks down user requests into discrete work packages (`post-task`), aggregates findings, mediates consensus proposals (`post-proposal`), and formalizes final closure (`resolve-board`).
2. **Worker 1 – Implementation & Core Dev (Bob):** Claims implementation tasks, writes patches, inspects hot paths, and produces concrete code artifacts.
3. **Worker 2 – QA, Testing & Security (Charlie):** Verifies runtime behavior, runs test suites, tests boundary conditions, inspects logs, and logs structured findings (`post-finding`).
4. **Worker 3 – Architecture & Systems Review (Dave):** Evaluates contract integrity, memory allocation, cross-subsystem dependencies, and flags architectural conflicts or technical debt.

#### Team Limits & Dynamic Scaling:
- The moderator can constrain the maximum active agents via `--max-agents <N>` (during init) or `node collab.mjs board-limit <topic> <N>` / `/collaborate --limit <N>`.
- If downscaled, excess worker agents are evicted, their unfinished tasks return to `open`, and the Coordinator reallocates the remaining tasks with an explicit status update.

#### Mandatory Startup / Status Briefing:
Whenever a collaborative phase starts or team limits change, the coordinator prints an immediate, concise briefing specifying:
- Objective & Mode (`plan` / `decide`).
- Active Agent Count & Limit.
- Roster with roles and specific task focus.
- Current work packages in progress.

### 12.2 Architecture & POSIX Atomic Guarantee
- **Single Append-Only File:** All agents append events (`task_posted`, `finding_posted`, `task_completed`, `vote_posted`) as individual JSON lines into `<topic>.board.jsonl`.
- **Lock-Free Concurrency:** Under POSIX systems (macOS/Linux), append writes via `fs.appendFileSync(path, line + '\n', { flag: 'a' })` below 4 KB are atomic. There are no `.lock` blocking contentions.
- **Event-Sourcing & Determinism:** The board state is a pure projection: `State = Reducer(Events)`.
- **Live Markdown Compiler:** The command `collab.mjs render <topic>` compiles the current projected state losslessly into human-readable GitHub-flavored markdown (`<topic>.md`) for review.
- **Zero-Resource Watcher:** Parallel worker sub-agents wait via OS `fs.watch` (`collab.mjs board-watch <topic> --task <TaskId>`) with 0% CPU and 0 token cost until their task is ready or new events arrive.

### 12.3 Streamlined Blackboard Workflow (5 Core Operations)

The entire parallel collaboration loop is driven by just **5 core actions**:

| Operation | Command | Description |
| :--- | :--- | :--- |
| **1. Init Team** | `board-init <topic> [Coordinator] [--role <R>]` | Initialize board (`<topic>.board.jsonl`) with 4-agent team |
| **2. Post Task** | `post-task <topic> <Author> "<Title>" [--assign <Agent>]` | Post work package assigned to a specialist worker |
| **3. Complete Task** | `complete-task <topic> <Agent> <TaskId> --result "<Summary>"` | Worker submits finished artifact (optional: `post-finding`) |
| **4. Consensus** | `post-proposal <topic> <Agent> <P<n>> "<Title>"` <br> `post-vote <topic> <Agent> <P<n>> <AGREE\|DISAGREE>` | Post proposal and register team votes |
| **5. Resolve & Render** | `resolve-board <topic> <Author> --outcome CONSENSUS` <br> `render <topic>` | Conclude board and compile losslessly into `<topic>.md` |

**Inspection & Waiting:**
- `board <topic>`: Query active state, open tasks, and vote counters.
- `board-watch <topic> [--task <T>] [--agent <A>]`: Sleep until task is ready or board resolves.
- `status`: Overview table across all workspace sessions.

