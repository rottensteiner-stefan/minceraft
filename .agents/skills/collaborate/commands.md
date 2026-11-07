# Commands Reference (Streamlined)

Extracted from `SKILL.md`. Idempotency rules apply across all commands. Cross-references refer to `SKILL.md`.

---

## 1. Primary Blackboard Workflow (Parallel Multi-Agent Standard)

The entire collaborative lifecycle on the Blackboard operates with just **5 core actions**:

| Action | Command | Purpose |
| :--- | :--- | :--- |
| **1. Init Team** | `node collab.mjs board-init <topic> [Coordinator] [--role <R>] [--max-agents <N>]` | Spawns session (`<topic>.board.jsonl`) with optional agent limit |
| **2. Task** | `node collab.mjs post-task <topic> <Author> "<Title>" [--assign <Agent>]` | Coordinator posts or assigns tasks to workers |
| **3. Work & Report** | `node collab.mjs complete-task <topic> <Agent> <TaskId> --result "<Summary>"` | Worker finishes task (optionally logs `post-finding`) |
| **4. Consensus** | `node collab.mjs post-proposal <topic> <Agent> <P<n>> "<Title>"` <br> `node collab.mjs post-vote <topic> <Agent> <P<n>> <AGREE\|DISAGREE>` | Post proposal and collect votes from the team |
| **5. Resolve & Render** | `node collab.mjs resolve-board <topic> <Author> --outcome CONSENSUS` <br> `node collab.mjs render <topic>` | Concludes board and losslessly compiles `<topic>.md` |

### Query, Limits & Monitoring
- `node collab.mjs board-limit <topic> <N>` — Set maximum agent limit dynamically; evicts excess agents & reopens their tasks for reassignment.
- `node collab.mjs board <topic>` — Live JSON state & open task summary.
- `node collab.mjs status` — Global overview of all active sessions across workspace.
- `node collab.mjs board-watch <topic> [--task <T>] [--agent <A>]` — Zero-resource watcher (0% CPU, 0 tokens) via OS filesystem notifications.

---

## 2. Steering & Emergency Commands (Moderator / Interactive)

| Command | Action | Effect |
| :--- | :--- | :--- |
| `/collaborate --limit <N> [<Topic>]` | **Set Limit** | Dynamically changes maximum agents, reallocates tasks, and outputs status. |
| `/collaborate --pause [<Topic>]` | **Pause** | Freezes execution immediately. |
| `/collaborate --resume [<Topic>]` | **Resume** | Unfreezes and continues execution. |
| `/collaborate --stop [<Topic>]` | **Terminate** | Concludes session permanently. |
| `/collaborate --kick <Agent> [<Topic>]` | **Evict** | Removes unresponsive agent from active roster. |
| `/collaborate --decide "<Decision>"` | **Tie-Break** | Moderator resolves deadlock directly. |
| `/collaborate --status` | **Diagnose** | Scans and lists all active collaborate sessions. |

---

### Default 4-Agent Example Workflow:

```bash
# 1. Moderator / Lead initializes the board
node .agents/skills/collaborate/collab.mjs board-init refactoring Alice --role "Lead Coordinator"

# 2. Coordinator posts work packages for the 3 specialized workers
node .agents/skills/collaborate/collab.mjs post-task refactoring Alice "Optimize hot path in Matrix4" --assign Bob
node .agents/skills/collaborate/collab.mjs post-task refactoring Alice "Audit test harness & WebGPU fixtures" --assign Charlie
node .agents/skills/collaborate/collab.mjs post-task refactoring Alice "Review memory pools & GC allocation" --assign Dave

# 3. Parallel workers claim tasks, work concurrently, and record findings
# (Bob - Implementation):
node .agents/skills/collaborate/collab.mjs claim-task refactoring Bob T1
node .agents/skills/collaborate/collab.mjs complete-task refactoring Bob T1 --result "Eliminated array allocations in multiplyToArray"

# (Charlie - QA & Testing):
node .agents/skills/collaborate/collab.mjs claim-task refactoring Charlie T2
node .agents/skills/collaborate/collab.mjs post-finding refactoring Charlie --task T2 --severity info --title "All WebGPU tests pass"
node .agents/skills/collaborate/collab.mjs complete-task refactoring Charlie T2 --result "TestSuite verified green"

# (Dave - Architecture & Review):
node .agents/skills/collaborate/collab.mjs claim-task refactoring Dave T3
node .agents/skills/collaborate/collab.mjs complete-task refactoring Dave T3 --result "Zero allocations verified on hot path"

# 4. Consensus proposal & voting
node .agents/skills/collaborate/collab.mjs post-proposal refactoring Alice P1 "Merge Matrix4 Optimization"
node .agents/skills/collaborate/collab.mjs post-vote refactoring Bob P1 AGREE --reason "Benchmarks verified"
node .agents/skills/collaborate/collab.mjs post-vote refactoring Charlie P1 AGREE --reason "Zero regressions"
node .agents/skills/collaborate/collab.mjs post-vote refactoring Dave P1 AGREE --reason "Memory profile clean"

# 5. Coordinator closes board and compiles markdown summary
node .agents/skills/collaborate/collab.mjs resolve-board refactoring Alice --outcome CONSENSUS --summary "All verification gates passed."
node .agents/skills/collaborate/collab.mjs render refactoring
```



