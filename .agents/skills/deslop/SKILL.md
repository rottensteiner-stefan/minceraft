---
name: deslop
description: Remove AI-generated code slop and clean up code style
---

# Remove AI code slop

Check the diff against `main` (or the relevant base branch) and strip AI-authored cruft the
branch introduced — without changing behavior.

"Local style" means this repo's own rules, not generic taste: `../../../AGENTS.md` and
`.agents/skills/coding-guide/SKILL.md` are the authority. Don't re-derive or duplicate those
rules here — if this file and `AGENTS.md` ever disagree, `AGENTS.md` wins and this file is stale
(exactly the kind of drift this skill exists to catch in application code — don't let it happen
to this file either).

## Focus areas

- **Restating comments**: a comment that just repeats what the next line already says
  (`// set the color` above `this.color = ...`). Delete it. Keep a comment only when it explains
  a non-obvious WHY — a hidden constraint, a workaround, an invariant a reader couldn't infer
  from the code alone.
- **Stale comments**: a comment or doc-block describing behavior the same diff just changed.
  Whenever you touch code a comment refers to, re-check the comment still matches what the code
  now does — don't leave it narrating the previous implementation.
- **Dead scaffolding**: commented-out code (`// console.log(...)`), `// TODO` markers with no
  tracked follow-up, blank lines left behind where code was removed.
- **Unearned defensiveness**: `try/catch` around calls that cannot throw in this codebase,
  `if (x === undefined) return` guards for a value the type system already guarantees is defined,
  redundant checks after a guard clause already ruled the case out.
- **Type-safety shortcuts**: `any` casts or overly broad unions used only to silence the
  compiler instead of fixing the actual type — `AGENTS.md` treats "no `any`" as a hard rule, not
  a preference.
- **Over-nesting**: `if`/`else` pyramids that should be guard clauses / early returns instead.
- **Needless abstraction**: a wrapper, helper, or config object introduced for a single call
  site with no second user in sight.

## Workflow

1. Diff the branch against its base (`git diff main...HEAD` or equivalent) — only touch lines
   this branch actually introduced. Don't sweep pre-existing code outside the diff unless the
   user explicitly asked for a sweep.
2. Walk each focus area above against that diff and apply fixes directly.
3. Before reporting done, run the repo's build gate: `npm run lint`, `npm run typecheck`, and the
   relevant tests. A cleanup pass that silently breaks the build isn't a cleanup.

## Guardrails

- Keep behavior unchanged. If you spot a real bug while cleaning up, flag it separately instead
  of silently "fixing" it as part of a slop pass — scope creep hides review-worthy changes inside
  a pass nobody expects to touch behavior.
- Prefer minimal, focused edits over broad rewrites.
- Keep the final summary concise (1-3 sentences): what categories were found, what was removed,
  confirmation the build gate passed.
