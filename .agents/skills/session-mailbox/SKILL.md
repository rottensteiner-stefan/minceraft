---
name: session-mailbox
description: Coordinate several Claude (or other agent) sessions that work in the same repository at the same time. A shared append-only mailbox with messages and path claims, plus strict rules for committing only your own files. Use whenever another session may be editing or committing in this working tree, before any git command that touches the index or history, and when you need to tell another session something.
---

# Session Mailbox

Several sessions can work in one checkout. They share one working tree and one git index, so they
can overwrite each other's files and, worse, commit each other's uncommitted work (a plain
`git commit` commits the WHOLE index, and `git add -A` stages everything). This skill is the
agreement that prevents that: a small shared log for messages and claims, and a few hard rules.

**Language:** all mailbox entries and messages between sessions are written in English.

## The mailbox

- File: `.agents/scratches/session-mailbox.jsonl` (git-ignored, append-only, one JSON object per line).
  If your side only sees it through a symlink (`.claude/scratches -> ../.agents/scratches`), it is the same file.
- Helper: `node .agents/skills/session-mailbox/mailbox.mjs <command>` (no dependencies).
- There is NO push. A session only sees new entries when it reads the mailbox, so reading is part of the routine.
- Pick one stable name for your session and use it everywhere: `--as <name>` or `export MAILBOX_NAME=<name>`.

| Command | Purpose |
| --- | --- |
| `read [--as me] [--tail 20] [--since <iso>]` | Messages addressed to you or to `all`, then the active claims. Start every work step with this. |
| `send --as me [--to <name\|all>] "text"` | Tell another session something (short, concrete, English). |
| `claim --as me [--note "why"] <path>...` | Announce which files or directories you are about to change. Directories end with `/`. Warns if another session already claimed an overlapping path. |
| `release --as me [<claim-id>]` | Give your claims back when you are done (all of yours if no id). |
| `check --as me <path>...` | Exit code 1 if a path overlaps an active claim of another session. Also reads paths from stdin. |
| `status` | Active claims only. Claims expire after 12 h (`MAILBOX_CLAIM_TTL_HOURS`) so a crashed session does not block forever. |

If sessions can see each other through the harness (for example `ListAgents` lists peer sessions),
`SendMessage` is a faster channel for urgent notes. Still write anything that must not get lost into
the mailbox: it is the durable record.

## Rules every session follows

1. **Read first.** Run `read` at the start of every work step and before every git command that
   writes (add, commit, rebase, reset, checkout, stash, merge, push).
2. **Claim before you edit** files that another session could also touch, and **release when done**.
   Claim narrowly (specific files or one directory), not the whole repo.
3. **Respect other claims.** If your change overlaps one, do not edit those paths: write to the
   owner (`send --to <owner> ...`), wait, or pick other work. Never "just fix it quickly".
4. **Commit only your own paths, explicitly.**
   - Never `git add -A`, `git add .`, `git commit -a`, `git stash`, `git checkout -- .`,
     `git reset --hard`, or any history rewrite (rebase, amend, filter-branch) without the other
     session's and the human's agreement.
   - Stage by path: `git add -- <your files>`; then verify what is in the index:
     `git diff --cached --name-only` must list only your files (the index may already contain someone
     else's staged work from before you started).
   - Commit by path: `git commit -m "..." -- <your files>` commits only those paths and leaves
     everything else in the index alone.
   - Cheap guard before committing:
     `git diff --cached --name-only | node .agents/skills/session-mailbox/mailbox.mjs check --as <me>`
5. **Do not interpret a missing file as "the other session dealt with it".** If a file you did not
   touch disappears from `git status`, someone may have committed or deleted it: ask in the mailbox
   and look at `git log -- <path>` before assuming anything.
6. **Shared dev server and build output.** Do not kill or restart processes you did not start. Do not
   run a second `vite` dev server on the same port: it can wipe `node_modules/.vite/deps` and break
   the running one. `dist/` is written by every build, so avoid two builds at the same time (claim
   `dist/` for the duration).
7. **Say what you did.** When you finish a piece of work that others depend on (an API change, a
   renamed file, a changed test setup), post one line with the commit hash or the changed paths.

## Message style

Short and self-contained, because the reader has none of your context.

```
node .agents/skills/session-mailbox/mailbox.mjs claim --as alice --note "decal data model" \
  packages/engine/src/loaders/kit/ public/schemas/
node .agents/skills/session-mailbox/mailbox.mjs send --as alice --to bob \
  "I changed KitTypes.ts (added decals[]). Please rebase your loader work on it before touching KitRegistry.ts."
node .agents/skills/session-mailbox/mailbox.mjs release --as alice
```

## When something goes wrong

- **Wrong files ended up in a commit:** if the commits are local and unpushed, tell the other
  session and the human at once, do not rewrite history silently. The fix (rebuild the commits
  without the foreign paths, keep a backup branch first) needs explicit approval from the human.
- **Damaged line in the mailbox:** the helper skips unparsable lines, so one broken entry cannot block anyone.
- **Nobody answers:** the mailbox is not a lock. If a claim is stale (old, owner gone), say so in a
  message to the human before overriding it.
