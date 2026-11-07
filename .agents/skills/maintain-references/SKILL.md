---
name: maintain-references
description: Ensure that new mathematical formulas, algorithms, shaders, or external inspirations are documented in REFERENCES.md.
---

# Maintain References

## Trigger

Use this skill whenever you implement a new algorithm, use a specific mathematical formula, adapt an external shader, or integrate architectural concepts from an external paper, book, or article.

## Workflow

1. Identify the original source of the new logic (e.g., Shadertoy, a specific paper, a mathematical standard, a blog post).
2. Read the `REFERENCES.md` file in the root directory.
3. Locate the appropriate category (e.g., "Geometry & Mathematics", "Physics & Collision Detection", "Shaders & Procedural Art") or create a new one if it doesn't fit.
4. Add a new entry using the exact format described below.

## Entry Format

Every new entry in `REFERENCES.md` MUST follow this exact structure (using an `H3` header):

```markdown
### {Name of the Concept / Algorithm}

- **File:** `path/to/the/affected_file.ts`
- **Authors/Gurus:** {Name of the authors, researchers, or creators, if known}
- **Source:** [{Title of the Source/Paper/Site}]({URL})
- **Usage:** {A brief, precise explanation of how and why this concept is used inside the small-world-machine engine. What does it solve?}
```

## Guardrails

- Do not add standard programming concepts (like loops, basic design patterns, or MDN JS docs). Only add significant domain-specific, mathematical, or architectural sources.
- Never overwrite existing references. Always append to the correct category.
