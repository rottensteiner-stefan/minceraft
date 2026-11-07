---
name: Changelog & Release Standard
description: Defines the strict formatting rules for CHANGELOG.md entries and Git release commits.
---

# Changelog & Release Standards

Small World Machine uses a highly stylized, poetic approach to version releases. Every new version is accompanied by a profound quote (philosophical, mathematical, scientific, or literary) that loosely reflects the nature of the update.

## 1. CHANGELOG.md Format

Every entry in the `CHANGELOG.md` MUST strictly follow this exact structure:

```markdown
## [0.63.0] - 2026-07-18

### "Pure mathematics is, in its way, the poetry of logical ideas." - Albert Einstein

- **Features:**
  - Description of new features, showcases, or visual additions.
- **Architecture & Bugfixes:**
  - Description of core engine changes, math fixes, or resolved crashes.
- **Housekeeping & Docs:**
  - Code cleanups, linting rules, or documentation updates.
```

**Rules for the Changelog:**
1. **No Extra Titles:** Do NOT invent a name for the update (like "The Shader Update"). The subheader (H3 `###`) MUST be exactly the quote in quotes, followed by a hyphen and the author.
2. **Categories:** Always use exactly these three categories: `- **Features:**`, `- **Architecture & Bugfixes:**`, and `- **Housekeeping & Docs:**`. If a category is empty for a specific release, you may omit it.
3. **Preserve History:** NEVER delete old entries. Always prepend the new version block directly under the `# Changelog` header.

## 2. Git Commit Rule

**CRITICAL MANDATE — Git Commit Rule (reconciled with AGENTS.md):** Do NOT commit or push after
every single micro-edit, and do NOT commit on pure speculation. The controlling rule in this repo
is AGENTS.md: *the agent is explicitly authorized to run git operations without asking*, but only
commits when a feature or milestone is cohesively rounded off (or the user signals a commit).
(ORIGINAL text of this skill — superseded by AGENTS.md: "NEVER make a commit or push without
explicit user request... Either the user explicitly requests a commit, or no commit happens." —)
Micro-edits stay uncommitted until a milestone is done.

EVERY single Git commit (not just version bumps) MUST use this unconventional format.
The commit message MUST be **exactly a quote**, but **WITHOUT the author** and **WITHOUT the surrounding quotation marks**. Do NOT use standard Conventional Commits (like `feat: added something` or `docs: fixed typo`).

**Example:**
If you want to commit a layout refactoring, use an appropriate quote:
`git commit -m "Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away."`

Never use anything else for any commit.
